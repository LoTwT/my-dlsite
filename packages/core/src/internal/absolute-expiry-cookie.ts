import { Cookie } from "tough-cookie"
import type { CreateCookieOptions } from "tough-cookie"

// Date TimeClip discards submillisecond expiry from Chromium. CookieJar uses
// expiryTime() for sending and expired-record removal, so retain the original
// seconds on that same stored Cookie and adapt its numeric deadline as well.
class AbsoluteExpiryCookie extends Cookie {
  readonly absoluteExpirySeconds: number

  constructor(options: CreateCookieOptions, expires: number) {
    super(options)
    this.absoluteExpirySeconds = expires
  }

  override expiryTime(): number {
    return this.absoluteExpirySeconds * 1_000
  }

  override TTL(now = Date.now()): number {
    return this.expiryTime() - now
  }
}

export function createImportedCookie(
  options: CreateCookieOptions,
  expires: number | null | undefined,
): Cookie {
  return expires === undefined || expires === null
    ? new Cookie(options)
    : new AbsoluteExpiryCookie(options, expires)
}

export function importedExpirySeconds(cookie: Cookie): number | undefined {
  // MemoryCookieStore replaces the object on Set-Cookie updates. The original
  // precision therefore belongs only to the imported record, never its later
  // replacement (including session cookies and deletion markers).
  return cookie instanceof AbsoluteExpiryCookie
    ? cookie.absoluteExpirySeconds
    : undefined
}
