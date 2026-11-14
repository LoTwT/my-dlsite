import { Cookie, CookieJar, MemoryCookieStore } from "tough-cookie"
import * as v from "valibot"
import {
  Aborted,
  AuthRequired,
  InvalidInput,
  SessionChanged,
  UnexpectedResponse,
} from "./errors.js"
import { exactPath } from "./internal/url.js"
import type {
  AuthApi,
  OperationOptions,
  ScopedCookie,
  SessionSnapshot,
  SnapshotCookie,
} from "./model.js"
import type { Transport } from "./transport.js"

const NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
// Empty cookie values are legal. Deletion is expressed by Max-Age or Expires,
// not by an empty value.
const VALUE_RE = /^[\x21-\x3A\x3C-\x7E]*$/
const PLAY_HOST = "play.dlsite.com"
const SALES_URL = new URL("/api/v4/content/sales", "https://play.dlsite.com")
const ALLOWED_SAME_SITE = new Set(["Strict", "Lax", "None"])

const scopedCookieSchema = v.strictObject({
  name: v.pipe(v.string(), v.regex(NAME_RE), v.maxLength(256)),
  value: v.pipe(v.string(), v.regex(VALUE_RE), v.maxLength(8_192)),
  domain: v.pipe(v.string(), v.minLength(1), v.maxLength(253)),
  path: v.pipe(v.string(), v.startsWith("/"), v.maxLength(1_024)),
  secure: v.boolean(),
  hostOnly: v.boolean(),
  httpOnly: v.optional(v.boolean()),
  expires: v.optional(v.number()),
  sameSite: v.optional(v.picklist(["Strict", "Lax", "None"])),
})

const scopedCookiesSchema = v.array(scopedCookieSchema)

const snapshotCookieSchema = v.strictObject({
  name: v.pipe(v.string(), v.regex(NAME_RE), v.maxLength(256)),
  value: v.pipe(v.string(), v.regex(VALUE_RE), v.maxLength(8_192)),
  domain: v.pipe(v.string(), v.minLength(1), v.maxLength(253)),
  path: v.pipe(v.string(), v.startsWith("/"), v.maxLength(1_024)),
  secure: v.boolean(),
  hostOnly: v.boolean(),
  httpOnly: v.boolean(),
  expires: v.nullable(v.number()),
  sameSite: v.optional(v.picklist(["Strict", "Lax", "None"])),
})

const snapshotSchema = v.strictObject({
  version: v.literal(1),
  cookies: v.array(snapshotCookieSchema),
})

const salesArraySchema = v.array(v.unknown())

export interface SessionContext {
  readonly generation: number
  readonly jar: CookieJar
  readonly signal: AbortSignal
}

interface CurrentSession extends SessionContext {
  readonly controller: AbortController
  state: "unknown" | "valid" | "invalid"
}

export class Auth implements AuthApi {
  private current: CurrentSession | null = null
  private queue: Promise<void> = Promise.resolve()
  private readonly transport: Transport
  private readonly now: () => number
  private readonly onSessionReplaced: (generation: number) => void

  constructor(
    transport: Transport,
    now: () => number,
    onSessionReplaced: (generation: number) => void,
  ) {
    this.transport = transport
    this.now = now
    this.onSessionReplaced = onSessionReplaced
  }

  async importCookies(
    cookies: readonly ScopedCookie[],
    options: OperationOptions = {},
  ): Promise<void> {
    await this.serial(async () => {
      const jar = await this.jarFromScopedCookies(cookies)
      await this.probeCandidate(jar, options.signal)
      this.replace(jar)
    })
  }

  async restore(
    snapshot: SessionSnapshot,
    options: OperationOptions = {},
  ): Promise<void> {
    await this.serial(async () => {
      const jar = await this.jarFromSnapshot(snapshot)
      await this.probeCandidate(jar, options.signal)
      this.replace(jar)
    })
  }

  async export(): Promise<SessionSnapshot> {
    const session = this.current
    if (session === null) return { version: 1, cookies: [] }
    const cookies = await session.jar.store.getAllCookies()
    this.assertCurrent(session)
    const nowMilliseconds = this.now()
    const snapshotCookies: SnapshotCookie[] = []
    for (const cookie of cookies) {
      const snapshotCookie = toSnapshotCookie(cookie, nowMilliseconds)
      if (snapshotCookie !== null) snapshotCookies.push(snapshotCookie)
    }
    return { version: 1, cookies: snapshotCookies }
  }

  async validate(options: OperationOptions = {}): Promise<void> {
    await this.operation(async (context) => {
      await this.probe(
        context.jar,
        combineSignals(context.signal, options.signal),
      )
      this.assertCurrent(context)
      const current = this.current
      if (current !== null && current.generation === context.generation) {
        current.state = "valid"
      }
    }, options)
  }

  beginOperation(): SessionContext {
    const current = this.current
    if (current === null || current.state === "invalid") {
      throw new AuthRequired()
    }
    return {
      generation: current.generation,
      jar: current.jar,
      signal: current.signal,
    }
  }

  async operation<T>(
    run: (context: SessionContext) => Promise<T>,
    options: OperationOptions = {},
  ): Promise<T> {
    const context = this.beginOperation()
    try {
      throwIfAborted(options.signal)
      const result = await run(context)
      this.assertCurrent(context)
      throwIfAborted(options.signal)
      return result
    } catch (error) {
      if (!this.isCurrent(context)) throw new SessionChanged()
      // A canceled operation must not turn an observed auth failure into
      // session invalidation; the next operation can validate again.
      if (options.signal?.aborted === true) throw new Aborted()
      if (error instanceof AuthRequired) {
        this.markInvalid(context)
      }
      throw error
    }
  }

  assertCurrent(context: SessionContext): void {
    if (!this.isCurrent(context)) throw new SessionChanged()
  }

  isCurrent(context: SessionContext): boolean {
    return (
      this.current !== null && this.current.generation === context.generation
    )
  }

  private markInvalid(context: SessionContext): void {
    const current = this.current
    if (current !== null && current.generation === context.generation) {
      current.state = "invalid"
    }
  }

  private replace(jar: CookieJar): void {
    const previous = this.current
    const generation = (previous?.generation ?? 0) + 1
    const controller = new AbortController()
    this.current = {
      generation,
      jar,
      signal: controller.signal,
      controller,
      state: "valid",
    }
    this.onSessionReplaced(generation)
    previous?.controller.abort()
  }

  private async probe(
    jar: CookieJar,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const value = await this.transport.requestJson({
      method: "GET",
      url: SALES_URL,
      endpoint: "auth.validate",
      allowedHosts: [PLAY_HOST],
      allowedPath: exactPath(SALES_URL.pathname),
      authContext: "play-session",
      credentials: "session",
      jar,
      ...(signal === undefined ? {} : { signal }),
    })
    if (!v.is(salesArraySchema, value)) {
      throw new UnexpectedResponse("auth.validate", "sales_not_array")
    }
  }

  private async probeCandidate(
    jar: CookieJar,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    throwIfAborted(signal)
    await this.probe(jar, signal)
    throwIfAborted(signal)
  }

  private async serial<T>(run: () => Promise<T>): Promise<T> {
    let release: (() => void) | undefined
    const previous = this.queue
    this.queue = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await run()
    } finally {
      release?.()
    }
  }

  private async jarFromScopedCookies(
    cookies: readonly ScopedCookie[],
  ): Promise<CookieJar> {
    const parsed = v.safeParse(scopedCookiesSchema, cookies)
    if (!parsed.success) throw new InvalidInput("cookie_shape")
    if (parsed.output.length === 0) throw new InvalidInput("empty_cookie_set")

    const jar = new CookieJar(new MemoryCookieStore())
    const nowMilliseconds = this.now()
    const seen = new Set<string>()
    for (const input of parsed.output) {
      const cookie = createCookie(input, nowMilliseconds, seen)
      await jar.store.putCookie(cookie)
    }
    return jar
  }

  private async jarFromSnapshot(snapshot: SessionSnapshot): Promise<CookieJar> {
    const parsed = v.safeParse(snapshotSchema, snapshot)
    if (!parsed.success) throw new InvalidInput("snapshot_shape")
    if (parsed.output.cookies.length === 0)
      throw new InvalidInput("empty_snapshot")

    const jar = new CookieJar(new MemoryCookieStore())
    const nowMilliseconds = this.now()
    const seen = new Set<string>()
    for (const input of parsed.output.cookies) {
      const cookie = createSnapshotCookie(input, nowMilliseconds, seen)
      await jar.store.putCookie(cookie)
    }
    return jar
  }
}

export function combineSignals(
  ...signals: readonly (AbortSignal | undefined)[]
): AbortSignal | undefined {
  const present = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined,
  )
  if (present.length === 0) return undefined
  if (present.length === 1) return present[0]
  return AbortSignal.any(present)
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new Aborted()
}

function normalizeDomain(raw: string, hostOnly: boolean): string {
  if (hostOnly && raw.startsWith("."))
    throw new InvalidInput("host_only_domain")
  const domain = raw.replace(/^\./, "").toLowerCase()
  if (
    domain.length === 0 ||
    domain.endsWith(".") ||
    (domain !== "dlsite.com" && !domain.endsWith(".dlsite.com"))
  ) {
    throw new InvalidInput("cookie_domain")
  }
  return domain
}

function validatePath(path: string): string {
  if (!path.startsWith("/") || hasControlOrSemicolon(path)) {
    throw new InvalidInput("cookie_path")
  }
  return path
}

function hasControlOrSemicolon(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)
    if (code === undefined || code < 0x20 || code === 0x7f || character === ";")
      return true
  }
  return false
}

function validateValue(value: string): string {
  if (!VALUE_RE.test(value)) throw new InvalidInput("cookie_value")
  return value
}

function scopeKey(name: string, domain: string, path: string): string {
  return `${name}\u0000${domain}\u0000${path}`
}

function createCookie(
  input: v.InferOutput<typeof scopedCookieSchema>,
  nowMilliseconds: number,
  seen: Set<string>,
): Cookie {
  if (
    input.expires !== undefined &&
    (!Number.isFinite(input.expires) || input.expires <= 0)
  ) {
    throw new InvalidInput("cookie_expiry")
  }
  if (input.sameSite !== undefined && !ALLOWED_SAME_SITE.has(input.sameSite)) {
    throw new InvalidInput("cookie_same_site")
  }
  const domain = normalizeDomain(input.domain, input.hostOnly)
  const path = validatePath(input.path)
  const key = scopeKey(input.name, domain, path)
  if (seen.has(key)) throw new InvalidInput("duplicate_cookie_scope")
  seen.add(key)

  return new Cookie({
    key: input.name,
    value: validateValue(input.value),
    domain,
    path,
    secure: input.secure,
    httpOnly: input.httpOnly ?? false,
    hostOnly: input.hostOnly,
    pathIsDefault: false,
    expires:
      input.expires === undefined
        ? "Infinity"
        : new Date(input.expires * 1_000),
    maxAge: null,
    sameSite: input.sameSite,
    creation: new Date(nowMilliseconds),
    lastAccessed: new Date(nowMilliseconds),
  })
}

function createSnapshotCookie(
  input: v.InferOutput<typeof snapshotCookieSchema>,
  nowMilliseconds: number,
  seen: Set<string>,
): Cookie {
  if (
    input.expires !== null &&
    (!Number.isFinite(input.expires) || input.expires <= 0)
  ) {
    throw new InvalidInput("cookie_expiry")
  }
  if (input.sameSite !== undefined && !ALLOWED_SAME_SITE.has(input.sameSite)) {
    throw new InvalidInput("cookie_same_site")
  }
  const domain = normalizeDomain(input.domain, input.hostOnly)
  const path = validatePath(input.path)
  const key = scopeKey(input.name, domain, path)
  if (seen.has(key)) throw new InvalidInput("duplicate_cookie_scope")
  seen.add(key)

  return new Cookie({
    key: input.name,
    value: validateValue(input.value),
    domain,
    path,
    secure: input.secure,
    httpOnly: input.httpOnly,
    hostOnly: input.hostOnly,
    pathIsDefault: false,
    expires:
      input.expires === null ? "Infinity" : new Date(input.expires * 1_000),
    maxAge: null,
    sameSite: input.sameSite,
    creation: new Date(nowMilliseconds),
    lastAccessed: new Date(nowMilliseconds),
  })
}

function toSnapshotCookie(
  cookie: Cookie,
  nowMilliseconds: number,
): SnapshotCookie | null {
  if (cookie.domain === null || cookie.path === null || cookie.key.length === 0)
    return null
  const expiryTime = absoluteCookieExpiry(cookie)
  if (
    expiryTime === -Infinity ||
    (Number.isFinite(expiryTime) && expiryTime <= nowMilliseconds)
  ) {
    return null
  }
  const expires = Number.isFinite(expiryTime) ? expiryTime / 1_000 : null
  const sameSiteValue = cookie.sameSite?.toLowerCase()
  const sameSite =
    sameSiteValue === "strict"
      ? "Strict"
      : sameSiteValue === "lax"
        ? "Lax"
        : sameSiteValue === "none"
          ? "None"
          : undefined
  return {
    name: cookie.key,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    hostOnly: cookie.hostOnly === true,
    expires,
    ...(sameSite === undefined ? {} : { sameSite }),
  }
}

function absoluteCookieExpiry(cookie: Cookie): number {
  // Do not use expiryTime(): it offsets Max-Age from lastAccessed, which
  // CookieJar.getCookies() advances on every outbound request. creation is
  // the receipt time; normalized cookies already carry an absolute expires.
  if (typeof cookie.maxAge === "number") {
    if (cookie.maxAge <= 0) return -Infinity
    return cookie.creation instanceof Date
      ? cookie.creation.getTime() + cookie.maxAge * 1_000
      : -Infinity
  }
  if (cookie.maxAge === "-Infinity") return -Infinity
  if (cookie.maxAge === "Infinity") return Infinity
  if (cookie.expires === null || cookie.expires === "Infinity") return Infinity
  return cookie.expires instanceof Date ? cookie.expires.getTime() : Infinity
}
