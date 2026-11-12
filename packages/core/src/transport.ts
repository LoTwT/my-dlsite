import { Cookie, type CookieJar } from "tough-cookie"
import {
  Aborted,
  AuthRequired,
  HttpError,
  RateLimited,
  TransportError,
  UnexpectedResponse,
} from "./errors.js"
import { type Clock, abortPromise, systemClock } from "./internal/clock.js"
import {
  type AllowedPath,
  assertAllowedUrl,
  isKnownLoginUrl,
  parseRetryAfter,
} from "./internal/url.js"
import {
  HOST_RATE_LIMIT_MS,
  MAX_REDIRECTS,
  TRANSACTION_TIMEOUT_MS,
} from "./model.js"

export interface TransportOptions {
  fetch: typeof globalThis.fetch
  userAgent: string
  clock?: Clock
  transactionTimeoutMs?: number
  hostRateLimitMs?: number
  maxRedirects?: number
}

export interface TransportRequest {
  method: "GET" | "POST"
  url: URL
  endpoint: string
  allowedHosts: readonly string[]
  allowedPath: AllowedPath
  authContext: "play-session" | "none"
  credentials: "session" | "none"
  jar?: CookieJar
  body?: {
    contentType: string
    text: string
  }
  signal?: AbortSignal
}

interface HostGateState {
  tail: Promise<void>
  nextAt: number
}

type HopResult =
  | { type: "json"; value: unknown }
  | { type: "redirect"; url: URL }
  | { type: "retry"; retryAfterMs: number; status: number }

class Transaction {
  readonly signal: AbortSignal
  private readonly timeoutSignal: AbortSignal
  private readonly userSignal: AbortSignal | undefined
  private readonly clock: Clock
  private readonly timeoutMs: number
  private readonly startedAt: number

  constructor(
    userSignal: AbortSignal | undefined,
    clock: Clock,
    timeoutMs: number,
  ) {
    this.clock = clock
    this.timeoutMs = timeoutMs
    this.startedAt = clock.now()
    this.userSignal = userSignal
    this.timeoutSignal = AbortSignal.timeout(timeoutMs)
    this.signal =
      userSignal === undefined
        ? this.timeoutSignal
        : AbortSignal.any([userSignal, this.timeoutSignal])
  }

  remaining(): number {
    return this.startedAt + this.timeoutMs - this.clock.now()
  }

  abortError(): Aborted | TransportError {
    if (this.userSignal?.aborted === true) return new Aborted()
    if (this.timeoutSignal.aborted) return new TransportError("timeout")
    return new Aborted()
  }

  async sleep(milliseconds: number): Promise<void> {
    if (this.signal.aborted) throw this.abortError()
    try {
      await this.clock.sleep(milliseconds, this.signal)
    } catch {
      throw this.abortError()
    }
    if (this.signal.aborted) throw this.abortError()
  }
}

class HostGate {
  private readonly gates = new Map<string, HostGateState>()
  private readonly clock: Clock
  private readonly rateLimitMs: number

  constructor(clock: Clock, rateLimitMs: number) {
    this.clock = clock
    this.rateLimitMs = rateLimitMs
  }

  async run<T>(
    host: string,
    task: () => Promise<T>,
    signal: AbortSignal,
    abortError: () => Aborted | TransportError,
  ): Promise<T> {
    const state = this.gates.get(host) ?? { tail: Promise.resolve(), nextAt: 0 }
    const previous = state.tail
    let releaseCurrent: (() => void) | undefined
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve
    })
    state.tail = current
    this.gates.set(host, state)

    try {
      await Promise.race([previous, abortPromise(signal)])
      if (signal.aborted) throw abortError()

      const wait = state.nextAt - this.clock.now()
      if (wait > 0) {
        try {
          await this.clock.sleep(wait, signal)
        } catch {
          throw abortError()
        }
      }
      if (signal.aborted) throw abortError()

      state.nextAt = this.clock.now() + this.rateLimitMs
      return await task()
    } finally {
      void previous.then(
        () => releaseCurrent?.(),
        () => releaseCurrent?.(),
      )
    }
  }
}

export class Transport {
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly userAgent: string
  private readonly clock: Clock
  private readonly transactionTimeoutMs: number
  private readonly maxRedirects: number
  private readonly hostGate: HostGate

  constructor(options: TransportOptions) {
    this.fetchImpl = options.fetch
    this.userAgent = options.userAgent
    this.clock = options.clock ?? systemClock
    this.transactionTimeoutMs =
      options.transactionTimeoutMs ?? TRANSACTION_TIMEOUT_MS
    this.maxRedirects = options.maxRedirects ?? MAX_REDIRECTS
    this.hostGate = new HostGate(
      this.clock,
      options.hostRateLimitMs ?? HOST_RATE_LIMIT_MS,
    )
  }

  async requestJson(request: TransportRequest): Promise<unknown> {
    assertAllowedUrl(
      request.url,
      request.allowedHosts,
      request.allowedPath,
      request.endpoint,
    )
    const transaction = new Transaction(
      request.signal,
      this.clock,
      this.transactionTimeoutMs,
    )

    let currentUrl = request.url
    let redirects = 0
    let retries = 0

    for (;;) {
      const hop = await this.hostGate.run(
        currentUrl.hostname.toLowerCase(),
        async () => {
          const headers = await this.headersFor(request, currentUrl)
          return this.sendHop({
            url: currentUrl,
            method: request.method,
            body: request.body,
            headers,
            endpoint: request.endpoint,
            allowedHosts: request.allowedHosts,
            allowedPath: request.allowedPath,
            authContext: request.authContext,
            credentials: request.credentials,
            jar: request.jar,
            transaction,
            now: this.clock.now(),
          })
        },
        transaction.signal,
        () => transaction.abortError(),
      )

      if (hop.type === "redirect") {
        if (redirects >= this.maxRedirects) {
          throw new UnexpectedResponse(request.endpoint, "too_many_redirects")
        }
        redirects += 1
        currentUrl = hop.url
        continue
      }

      if (hop.type === "retry") {
        if (request.method !== "GET" || retries >= 1) {
          if (hop.status === 429) throw new RateLimited(hop.retryAfterMs)
          throw new HttpError(hop.status, request.endpoint)
        }
        if (hop.retryAfterMs > transaction.remaining()) {
          if (hop.status === 429) throw new RateLimited(hop.retryAfterMs)
          throw new HttpError(hop.status, request.endpoint)
        }
        retries += 1
        await transaction.sleep(hop.retryAfterMs)
        continue
      }

      return hop.value
    }
  }

  private async headersFor(
    request: TransportRequest,
    url: URL,
  ): Promise<Record<string, string>> {
    const cookie =
      request.credentials === "session" && request.jar !== undefined
        ? await request.jar.getCookieString(url)
        : ""
    const headers: Record<string, string> = {
      "Accept": "application/json",
      "User-Agent": this.userAgent,
      "Referer": "https://play.dlsite.com/",
    }
    if (cookie.length > 0) headers.Cookie = cookie
    if (request.method === "POST") {
      headers.Origin = "https://play.dlsite.com"
      if (request.body !== undefined) {
        headers["Content-Type"] = request.body.contentType
      }
    }
    return headers
  }

  private async sendHop(input: {
    url: URL
    method: "GET" | "POST"
    body: TransportRequest["body"]
    headers: Record<string, string>
    endpoint: string
    allowedHosts: readonly string[]
    allowedPath: AllowedPath
    authContext: "play-session" | "none"
    credentials: "session" | "none"
    jar: CookieJar | undefined
    transaction: Transaction
    now: number
  }): Promise<HopResult> {
    let response: Response
    try {
      response = await this.fetchImpl(input.url, {
        method: input.method,
        headers: input.headers,
        body: input.body?.text,
        redirect: "manual",
        signal: input.transaction.signal,
      })
    } catch {
      if (input.transaction.signal.aborted) throw input.transaction.abortError()
      throw new TransportError("network")
    }

    if (response.redirected) {
      await cancelBody(response)
      throw new UnexpectedResponse(input.endpoint, "unexpected_redirect_follow")
    }

    const status = response.status
    if (status >= 300 && status < 400) {
      const location = response.headers.get("location")
      await cancelBody(response)
      if (location === null) {
        throw new UnexpectedResponse(
          input.endpoint,
          "redirect_without_location",
        )
      }
      let target: URL
      try {
        target = new URL(location, input.url)
      } catch {
        throw new UnexpectedResponse(input.endpoint, "invalid_redirect_target")
      }
      if (input.authContext === "play-session" && isKnownLoginUrl(target)) {
        throw new AuthRequired(input.endpoint)
      }
      assertAllowedUrl(
        target,
        input.allowedHosts,
        input.allowedPath,
        input.endpoint,
      )
      if (input.method !== "GET") {
        throw new UnexpectedResponse(input.endpoint, "post_redirect")
      }
      await this.storeCookies(input, response)
      return { type: "redirect", url: target }
    }

    if (status === 401) {
      await cancelBody(response)
      if (input.authContext === "play-session") {
        throw new AuthRequired(input.endpoint)
      }
      throw new HttpError(status, input.endpoint)
    }
    if (status === 403) {
      await cancelBody(response)
      throw new HttpError(403, input.endpoint)
    }
    if (status === 429 || status === 503) {
      await this.storeCookies(input, response)
      const retryAfterMs = parseRetryAfter(
        response.headers.get("retry-after"),
        input.now,
      )
      await cancelBody(response)
      return { type: "retry", retryAfterMs, status }
    }
    if (status < 200 || status >= 300) {
      await cancelBody(response)
      throw new HttpError(status, input.endpoint)
    }

    await this.storeCookies(input, response)
    const contentType = (
      response.headers.get("content-type") ?? ""
    ).toLowerCase()
    if (contentType.length > 0 && !contentType.includes("json")) {
      await cancelBody(response)
      throw new UnexpectedResponse(input.endpoint, "unexpected_content_type")
    }

    let text: string
    try {
      text = await response.text()
    } catch {
      if (input.transaction.signal.aborted) throw input.transaction.abortError()
      throw new TransportError("network")
    }

    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      throw new UnexpectedResponse(input.endpoint, "invalid_json")
    }
    return { type: "json", value }
  }

  private async storeCookies(
    input: {
      url: URL
      credentials: "session" | "none"
      jar: CookieJar | undefined
    },
    response: Response,
  ): Promise<void> {
    if (input.credentials !== "session" || input.jar === undefined) return
    const setCookies = response.headers.getSetCookie()
    const receivedAt = new Date(this.clock.now())
    for (const header of setCookies) {
      try {
        const parsed = Cookie.parse(header)
        if (parsed === undefined) continue

        let deleteMarker = false
        if (typeof parsed.maxAge === "number") {
          // Max-Age is relative to receipt. Convert it once so later reads do
          // not depend on tough-cookie's mutable lastAccessed timestamp.
          deleteMarker = parsed.maxAge <= 0
          parsed.expires = new Date(
            receivedAt.getTime() + parsed.maxAge * 1_000,
          )
          parsed.maxAge = null
        } else if (
          parsed.expires instanceof Date &&
          parsed.expires.getTime() <= receivedAt.getTime()
        ) {
          deleteMarker = true
        }

        const stored = await input.jar.setCookie(parsed, input.url, {
          ignoreError: true,
          now: receivedAt,
        })
        if (
          deleteMarker &&
          stored !== undefined &&
          stored.domain !== null &&
          stored.path !== null
        ) {
          await input.jar.store.removeCookie(
            stored.domain,
            stored.path,
            stored.key,
          )
        }
      } catch {
        // Cookie storage failures must not expose or abort the operation.
      }
    }
  }
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The body may already be closed or canceled.
  }
}
