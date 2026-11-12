import * as v from "valibot"
import type { Auth, SessionContext } from "./auth.js"
import { Aborted, GrantExpired, UnexpectedResponse } from "./errors.js"
import { exactPath } from "./internal/url.js"
import { GRANT_REFRESH_THRESHOLD_MS } from "./model.js"
import type { Transport } from "./transport.js"

export interface Grant {
  workId: string
  baseUrl: string
  params: Readonly<Record<string, string>>
  expiresAt: number
}

export interface AccessOperation {
  readonly refreshedWorkIds: Set<string>
}

export interface AccessOptions {
  refreshAccess?: boolean
  signal?: AbortSignal
  operation?: AccessOperation
}

const SIGN_URL = new URL("/api/v4/download/sign/url", "https://play.dlsite.com")
const PLAY_HOST = "play.dlsite.com"
const CDN_HOST = "play.dl.dlsite.com"

const signResponseSchema = v.object({
  url: v.pipe(v.string(), v.minLength(1)),
  params: v.strictObject({
    "Policy": v.string(),
    "Signature": v.string(),
    "Key-Pair-Id": v.string(),
  }),
  expires: v.optional(v.string()),
})

export function createAccessOperation(): AccessOperation {
  return { refreshedWorkIds: new Set<string>() }
}

export class Access {
  private readonly transport: Transport
  private readonly auth: Auth
  private readonly now: () => number
  private readonly cache = new Map<string, Grant>()
  private readonly inflight = new Map<string, Promise<Grant>>()
  private readonly latestRequest = new Map<string, symbol>()

  constructor(transport: Transport, auth: Auth, now: () => number) {
    this.transport = transport
    this.auth = auth
    this.now = now
  }

  clear(): void {
    this.cache.clear()
    this.inflight.clear()
    this.latestRequest.clear()
  }

  invalidate(context: SessionContext, workId: string): void {
    const key = this.key(context, workId)
    this.cache.delete(key)
    this.inflight.delete(key)
    this.latestRequest.delete(key)
  }

  async getGrant(
    context: SessionContext,
    workId: string,
    options: AccessOptions = {},
  ): Promise<Grant> {
    if (options.signal?.aborted === true) throw new Aborted()
    this.auth.assertCurrent(context)
    const key = this.key(context, workId)
    const operation = options.operation
    const cached = this.cache.get(key)
    const now = this.now()

    if (cached !== undefined && cached.expiresAt <= now) {
      this.cache.delete(key)
    }

    if (
      cached !== undefined &&
      cached.expiresAt > now &&
      options.refreshAccess !== true
    ) {
      if (cached.expiresAt > now + GRANT_REFRESH_THRESHOLD_MS) {
        return cached
      }
      if (operation?.refreshedWorkIds.has(workId) === true) {
        return cached
      }
    }

    if (operation !== undefined) operation.refreshedWorkIds.add(workId)

    let shared = this.inflight.get(key)
    if (shared === undefined) {
      shared = this.fetchGrant(context, workId, key)
      this.inflight.set(key, shared)
      void shared
        .finally(() => {
          if (this.inflight.get(key) === shared) this.inflight.delete(key)
        })
        .catch(() => {
          // The caller receives the same rejection.
        })
    }
    return waitForGrant(shared, options.signal)
  }

  private async fetchGrant(
    context: SessionContext,
    workId: string,
    key: string,
  ): Promise<Grant> {
    const token = Symbol(workId)
    this.latestRequest.set(key, token)

    const url = new URL(SIGN_URL)
    url.searchParams.set("workno", workId)
    const value = await this.transport.requestJson({
      method: "GET",
      url,
      endpoint: "access.sign",
      allowedHosts: [PLAY_HOST],
      allowedPath: exactPath(SIGN_URL.pathname),
      credentials: "session",
      jar: context.jar,
      signal: context.signal,
    })

    this.auth.assertCurrent(context)
    const parsed = v.safeParse(signResponseSchema, value)
    if (!parsed.success) {
      throw new UnexpectedResponse("access.sign", "sign_shape")
    }

    const base = parseBaseUrl(parsed.output.url, workId)
    const expiresAt = resolveExpiry(
      parsed.output.params.Policy,
      parsed.output.expires,
    )
    const now = this.now()
    if (expiresAt <= now) throw new GrantExpired(workId)
    this.auth.assertCurrent(context)

    const grant: Grant = {
      workId,
      baseUrl: base.href,
      params: {
        "Policy": parsed.output.params.Policy,
        "Signature": parsed.output.params.Signature,
        "Key-Pair-Id": parsed.output.params["Key-Pair-Id"],
      },
      expiresAt,
    }

    this.auth.assertCurrent(context)
    if (this.latestRequest.get(key) === token) {
      this.cache.set(key, grant)
    }
    return grant
  }

  private key(context: SessionContext, workId: string): string {
    return `${context.generation}:${workId}`
  }
}

function waitForGrant(
  shared: Promise<Grant>,
  signal: AbortSignal | undefined,
): Promise<Grant> {
  if (signal === undefined) return shared
  if (signal.aborted) return Promise.reject(new Aborted())

  return new Promise<Grant>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(new Aborted())
    }
    const cleanup = () => signal.removeEventListener("abort", onAbort)
    signal.addEventListener("abort", onAbort, { once: true })
    shared.then(
      (grant) => {
        cleanup()
        resolve(grant)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      },
    )
  })
}

function parseBaseUrl(raw: string, workId: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new UnexpectedResponse("access.sign", "invalid_grant_url")
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hostname.toLowerCase() !== CDN_HOST ||
    !url.pathname.endsWith("/") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new UnexpectedResponse("access.sign", "unexpected_grant_target")
  }
  if (!url.pathname.split("/").includes(workId)) {
    throw new UnexpectedResponse("access.sign", "grant_work_mismatch")
  }
  return url
}

function resolveExpiry(policy: string, expires: string | undefined): number {
  const candidates: number[] = []
  if (expires !== undefined) {
    const parsed = Date.parse(expires)
    if (Number.isFinite(parsed)) candidates.push(parsed)
  }

  const policyValue = decodePolicy(policy)
  if (policyValue === null || typeof policyValue !== "object") {
    throw new UnexpectedResponse("access.sign", "invalid_policy")
  }
  const statements = (policyValue as Record<string, unknown>)["Statement"]
  if (!Array.isArray(statements)) {
    throw new UnexpectedResponse("access.sign", "invalid_policy")
  }
  for (const statement of statements) {
    if (statement === null || typeof statement !== "object") continue
    const condition = (statement as Record<string, unknown>)["Condition"]
    if (condition === null || typeof condition !== "object") continue
    const dateLessThan = (condition as Record<string, unknown>)["DateLessThan"]
    const value = dateLessThanValue(dateLessThan)
    if (value !== null) candidates.push(value)
  }

  if (candidates.length === 0) {
    throw new UnexpectedResponse("access.sign", "missing_expiry")
  }
  return Math.min(...candidates)
}

function decodePolicy(policy: string): unknown {
  const cloudFrontEncoding = policy
    .replace(/-/g, "+")
    .replace(/_/g, "=")
    .replace(/~/g, "/")
  for (const candidate of [cloudFrontEncoding, policy]) {
    for (const encoding of ["base64", "base64url"] as const) {
      try {
        const text = Buffer.from(candidate, encoding).toString("utf8")
        return JSON.parse(text) as unknown
      } catch {
        // Try the next encoding/candidate.
      }
    }
  }
  throw new UnexpectedResponse("access.sign", "invalid_policy")
}

function dateLessThanValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value))
    return normalizeEpoch(value)
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
    if (/^\d+$/.test(value)) return normalizeEpoch(Number(value))
    return null
  }
  if (value !== null && typeof value === "object") {
    const epoch = (value as Record<string, unknown>)["AWS:EpochTime"]
    if (typeof epoch === "number" && Number.isFinite(epoch))
      return normalizeEpoch(epoch)
    if (typeof epoch === "string" && /^\d+$/.test(epoch))
      return normalizeEpoch(Number(epoch))
  }
  return null
}

function normalizeEpoch(value: number): number {
  return value < 1_000_000_000_000 ? value * 1_000 : value
}
