import type { ScopedCookie } from "@my-dlsite/core"
import type { CDPSession } from "playwright"
import { BrowserLoginError } from "./errors.js"

const SERVICE_HOSTS = [
  "play.dlsite.com",
  "www.dlsite.com",
  "download.dlsite.com",
]
const NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,256}$/
const VALUE = /^[\x21-\x3A\x3C-\x7E]*$/

function unsupported(): never {
  throw new BrowserLoginError("unsupported-cookie")
}

export interface ChromiumCookie {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  size: number
  httpOnly: boolean
  secure: boolean
  session: boolean
  sameSite?: "Strict" | "Lax" | "None"
  priority: string
  sourceScheme: string
  sourcePort: number
  partitionKey?: unknown
  partitionKeyOpaque?: boolean
}

export async function readChromiumCookies(
  pageSession: CDPSession,
  browserSession: CDPSession,
  signal?: AbortSignal,
): Promise<ChromiumCookie[]> {
  const { targetInfo } = await pageSession.send(
    "Target.getTargetInfo",
    undefined,
    { signal },
  )
  if (targetInfo.browserContextId === undefined) unsupported()
  // Storage defaults to the default context, even on a page-target session.
  // Only a browser-target session accepts the explicit isolated context ID.
  return (
    await browserSession.send(
      "Storage.getCookies",
      { browserContextId: targetInfo.browserContextId },
      { signal },
    )
  ).cookies
}

// Capture all paths via CDP Storage.getCookies, rather than cookies(homeUrl).
// Inspect raw partition/source metadata before projecting to Core's scope.
export function scopedCookiesFromChromium(
  cookies: readonly ChromiumCookie[],
  nowSeconds = Date.now() / 1_000,
): readonly ScopedCookie[] {
  const result: ScopedCookie[] = []
  const scopes = new Set<string>()
  for (const cookie of cookies) {
    const domain = cookie.domain.replace(/^\./, "")
    const hostOnly = !cookie.domain.startsWith(".")
    if (domain !== "dlsite.com" && !domain.endsWith(".dlsite.com")) continue
    if (
      !SERVICE_HOSTS.some(
        (host) => host === domain || (!hostOnly && host.endsWith(`.${domain}`)),
      )
    )
      continue
    if (!Number.isFinite(cookie.expires) || typeof cookie.session !== "boolean")
      unsupported()
    if (!cookie.session && cookie.expires <= nowSeconds) continue
    if (
      !cookie.session &&
      !Number.isFinite(new Date(cookie.expires * 1_000).getTime())
    )
      unsupported()
    if (cookie.partitionKey !== undefined || cookie.partitionKeyOpaque === true)
      unsupported()
    // Core only calls HTTPS services on the default port. Source restrictions
    // at that origin are satisfied by every supported request; any other
    // origin binding cannot be represented and must fail before import.
    if (cookie.sourceScheme !== "Secure" || cookie.sourcePort !== 443)
      unsupported()
    if (
      !NAME.test(cookie.name) ||
      !VALUE.test(cookie.value) ||
      cookie.value.length > 8_192 ||
      domain.length > 253 ||
      domain !== domain.toLowerCase() ||
      !cookie.path.startsWith("/") ||
      cookie.path.length > 1_024 ||
      Array.from(cookie.path).some(
        (character) =>
          character.charCodeAt(0) < 0x20 ||
          character.charCodeAt(0) === 0x7f ||
          character === ";",
      ) ||
      typeof cookie.secure !== "boolean" ||
      typeof cookie.httpOnly !== "boolean"
    )
      unsupported()
    if (
      cookie.sameSite !== undefined &&
      !["Strict", "Lax", "None"].includes(cookie.sameSite)
    )
      unsupported()
    if (cookie.session && cookie.expires !== -1) unsupported()
    const key = `${cookie.name}\0${domain}\0${cookie.path}`
    // Current Core cannot represent both host-only and domain records with
    // this same key. Do not pick a value or synthesize merged attributes.
    if (scopes.has(key)) unsupported()
    scopes.add(key)
    result.push({
      name: cookie.name,
      value: cookie.value,
      domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      hostOnly,
      ...(cookie.session ? {} : { expires: cookie.expires }),
      ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite }),
    })
  }
  if (result.length === 0) unsupported()
  return result
}
