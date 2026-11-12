import { UnexpectedResponse } from "../errors.js"

export function assertAllowedUrl(
  url: URL,
  allowedHosts: readonly string[],
  endpoint: string,
): void {
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    !allowedHosts.some(
      (host) => host.toLowerCase() === url.hostname.toLowerCase(),
    )
  ) {
    throw new UnexpectedResponse(endpoint, "unexpected_target")
  }
}

export function isKnownLoginUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase()
  if (host === "www.dlsite.com" && url.pathname.startsWith("/home/login"))
    return true
  if (host === "play.dlsite.com" && url.pathname.startsWith("/login"))
    return true
  return false
}

export function normalizeGrantBaseUrl(raw: string): URL {
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
    url.hostname.toLowerCase() !== "play.dl.dlsite.com" ||
    !url.pathname.endsWith("/") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new UnexpectedResponse("access.sign", "unexpected_grant_target")
  }
  return url
}

export function buildResourceUrl(
  baseUrl: string,
  relativePath: string,
  params: Readonly<Record<string, string>>,
  endpoint = "playback.resolve",
): URL {
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("/") ||
    relativePath.includes("?") ||
    relativePath.includes("#")
  ) {
    throw new UnexpectedResponse(endpoint, "invalid_resource_path")
  }
  const segments = relativePath.split("/")
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new UnexpectedResponse(endpoint, "invalid_resource_path")
  }

  const base = new URL(baseUrl)
  if (
    base.protocol !== "https:" ||
    base.hostname.toLowerCase() !== "play.dl.dlsite.com" ||
    !base.pathname.endsWith("/") ||
    base.search !== "" ||
    base.hash !== ""
  ) {
    throw new UnexpectedResponse(endpoint, "unexpected_grant_target")
  }

  const encoded = segments
    .map((segment) => encodeURIComponent(segment))
    .join("/")
  const url = new URL(encoded, base)
  if (
    url.protocol !== "https:" ||
    url.host !== base.host ||
    !url.pathname.startsWith(base.pathname) ||
    url.hash !== ""
  ) {
    throw new UnexpectedResponse(endpoint, "resource_outside_grant")
  }
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  return url
}

export function parseRetryAfter(
  value: string | null,
  nowMilliseconds: number,
): number {
  if (value === null) return 1_000
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed)
    if (!Number.isFinite(seconds) || seconds < 0) return 1_000
    return Math.min(seconds * 1_000, Number.MAX_SAFE_INTEGER)
  }
  const date = Date.parse(trimmed)
  if (!Number.isFinite(date)) return 1_000
  return Math.max(0, date - nowMilliseconds)
}

export function extensionOf(nameOrPath: string): string | null {
  const dot = nameOrPath.lastIndexOf(".")
  if (dot <= 0 || dot === nameOrPath.length - 1) return null
  return nameOrPath.slice(dot).toLowerCase()
}
