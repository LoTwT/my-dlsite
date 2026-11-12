import type { CookieJar } from "tough-cookie"
import { type Auth, combineSignals, type SessionContext } from "./auth.js"
import {
  AuthRequired,
  InvalidInput,
  UnexpectedResponse,
  UnsupportedDelivery,
} from "./errors.js"
import { isKnownLoginUrl } from "./internal/url.js"
import type {
  AcquisitionApi,
  AcquisitionPlan,
  OperationOptions,
  WorkId,
} from "./model.js"
import type { Transport, TransportHopResponse } from "./transport.js"

const ENDPOINT = "acquisition.plan"
const PLAY_HOST = "play.dlsite.com"
const WWW_HOST = "www.dlsite.com"
const DOWNLOAD_HOST = "download.dlsite.com"
const ENTRY_PATH = "/api/v3/download"
const WWW_DOWNLOAD_PREFIX = "/home/download/=/product_id/"
const ZIP_CONTENT_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
])

type DownloadTarget =
  | { kind: "not-download" }
  | { kind: "unsupported" }
  | { kind: "invalid-filename" }
  | { kind: "match"; filename: string }

export class Acquisition implements AcquisitionApi {
  private readonly transport: Transport
  private readonly auth: Auth

  constructor(transport: Transport, auth: Auth) {
    this.transport = transport
    this.auth = auth
  }

  async plan(
    workId: WorkId,
    options: OperationOptions = {},
  ): Promise<AcquisitionPlan> {
    if (typeof workId !== "string" || workId.length === 0) {
      throw new InvalidInput("work_id")
    }

    return this.auth.operation(async (context) => {
      const signal = combineSignals(context.signal, options.signal)
      const transaction = this.transport.createTransaction(signal)
      const entryUrl = buildEntryUrl(workId)
      const expectedWwwUrl = buildWwwUrl(workId)
      const visited = new Set<string>([entryUrl.href])
      let currentUrl = entryUrl
      let isPlayEntry = true

      for (;;) {
        this.auth.assertCurrent(context)
        const outcome = await transaction.requestHop({
          url: currentUrl,
          endpoint: ENDPOINT,
          authContext: isPlayEntry ? "play-session" : "none",
          credentials: "session",
          jar: context.jar,
        })
        this.auth.assertCurrent(context)

        if (outcome.type === "response") {
          return this.planFromFileResponse(
            context,
            workId,
            currentUrl,
            outcome,
            isPlayEntry,
          )
        }

        const target = outcome.url
        if (isKnownLoginUrl(target)) {
          if (isPlayEntry) throw new AuthRequired(ENDPOINT)
          throw new UnexpectedResponse(ENDPOINT, "login_redirect")
        }
        if (visited.has(target.href)) {
          throw new UnexpectedResponse(ENDPOINT, "redirect_loop")
        }

        const download = classifyDownloadTarget(target)
        if (download.kind === "match") {
          // The final file URL may be single-use. Stop here; never GET or HEAD
          // it just to learn more about the delivery.
          const headers = await cookieHeaders(context.jar, target)
          this.auth.assertCurrent(context)
          return { url: target.href, filename: download.filename, headers }
        }
        if (download.kind === "invalid-filename") {
          throw new UnexpectedResponse(ENDPOINT, "filename")
        }
        if (download.kind === "unsupported") {
          throw new UnsupportedDelivery("download_target", workId)
        }

        if (
          target.hostname.toLowerCase() !== WWW_HOST ||
          target.href !== expectedWwwUrl.href
        ) {
          throw new UnexpectedResponse(ENDPOINT, "unexpected_target")
        }

        visited.add(target.href)
        currentUrl = target
        isPlayEntry = false
      }
    }, options)
  }

  private async planFromFileResponse(
    context: SessionContext,
    workId: WorkId,
    url: URL,
    response: TransportHopResponse,
    isPlayEntry: boolean,
  ): Promise<AcquisitionPlan> {
    const contentType = mimeEssence(response.contentType)
    const filename = filenameFromResponse(url, response)
    const zipMime = contentType !== null && ZIP_CONTENT_TYPES.has(contentType)
    const zipOctet =
      contentType === "application/octet-stream" &&
      filename !== null &&
      filename.toLowerCase().endsWith(".zip")

    if (!zipMime && !zipOctet) {
      if (
        contentType === "text/html" ||
        contentType === "application/xhtml+xml"
      ) {
        if (isPlayEntry) {
          throw new UnexpectedResponse(ENDPOINT, "unexpected_content_type")
        }
        throw new UnsupportedDelivery("html_response", workId)
      }
      if (contentType === null || isJsonMime(contentType)) {
        throw new UnexpectedResponse(ENDPOINT, "unexpected_content_type")
      }
      throw new UnsupportedDelivery("unsupported_content_type", workId)
    }

    if (filename === null) {
      throw new UnexpectedResponse(ENDPOINT, "filename_unavailable")
    }
    if (!filename.toLowerCase().endsWith(".zip")) {
      throw new UnsupportedDelivery("filename", workId)
    }

    // The body is not read or stored; canceling is best-effort and does not
    // guarantee that the network received zero bytes.
    const headers = await cookieHeaders(context.jar, url)
    this.auth.assertCurrent(context)
    const plan: AcquisitionPlan = { url: url.href, filename, headers }
    if (contentType !== null) plan.mimeType = contentType
    const size = parseContentLength(
      response.contentLength,
      response.contentEncoding,
    )
    if (size !== null) plan.sizeBytes = size
    return plan
  }
}

function buildEntryUrl(workId: string): URL {
  const url = new URL(ENTRY_PATH, `https://${PLAY_HOST}`)
  url.searchParams.set("workno", workId)
  return url
}

function buildWwwUrl(workId: string): URL {
  return new URL(
    `${WWW_DOWNLOAD_PREFIX}${encodeURIComponent(workId)}.html`,
    `https://${WWW_HOST}`,
  )
}

function classifyDownloadTarget(url: URL): DownloadTarget {
  if (url.hostname.toLowerCase() !== DOWNLOAD_HOST) {
    return { kind: "not-download" }
  }
  if (!hasAllowedDownloadQuery(url)) return { kind: "unsupported" }

  const segments = url.pathname.split("/")
  if (segments[1] === "file") {
    if (segments.length > 4 || (segments.length === 4 && segments[3] !== "")) {
      return { kind: "unsupported" }
    }
    return filenameTarget(segments[2])
  }

  if (
    segments.length === 13 &&
    segments[1] === "get" &&
    segments[2] === "=" &&
    segments[3] === "type" &&
    segments[4] === "work" &&
    segments[5] === "domain" &&
    isNonEmpty(segments[6]) &&
    segments[7] === "dir" &&
    isNonEmpty(segments[8]) &&
    segments[9] === "file" &&
    segments[11] === "_" &&
    isNonEmpty(segments[12])
  ) {
    return filenameTarget(segments[10])
  }

  return { kind: "unsupported" }
}

function filenameTarget(raw: string | undefined): DownloadTarget {
  if (raw === undefined) return { kind: "unsupported" }
  const filename = decodeFilename(raw)
  if (filename === null) return { kind: "invalid-filename" }
  if (!filename.toLowerCase().endsWith(".zip")) {
    return { kind: "unsupported" }
  }
  return { kind: "match", filename }
}

function hasAllowedDownloadQuery(url: URL): boolean {
  const entries = [...url.searchParams.entries()]
  if (entries.length === 0) return true
  const first = entries[0]
  return (
    entries.length === 1 &&
    first !== undefined &&
    first[0] === "update_date" &&
    first[1].length > 0
  )
}

function filenameFromResponse(
  url: URL,
  response: TransportHopResponse,
): string | null {
  // The confirmed /file/{filename}/ path is the primary source; the response
  // disposition is only a fallback for direct file deliveries.
  const segments = url.pathname.split("/")
  const fileIndex = segments.indexOf("file")
  if (fileIndex >= 0) {
    const candidate = segments[fileIndex + 1]
    if (candidate !== undefined) {
      const decoded = decodeFilename(candidate)
      if (decoded !== null && decoded.toLowerCase().endsWith(".zip")) {
        return decoded
      }
    }
  }

  const disposition = filenameFromDisposition(response.contentDisposition)
  if (disposition !== null) return disposition

  const last = segments[segments.length - 1]
  if (last === undefined) return null
  const decoded = decodeFilename(last)
  if (decoded === null || !decoded.toLowerCase().endsWith(".zip")) return null
  return decoded
}

function filenameFromDisposition(value: string | null): string | null {
  if (value === null) return null

  const extended = /(?:^|;)\s*filename\*\s*=\s*([^;]+)/i.exec(value)
  const extendedValue = extended?.[1]
  if (extendedValue !== undefined) {
    const match = /^([^']*)'[^']*'(.*)$/.exec(extendedValue.trim())
    if (match !== null && match[1]?.toLowerCase() === "utf-8") {
      try {
        const decoded = validateFilename(decodeURIComponent(match[2] ?? ""))
        if (decoded !== null) return decoded
      } catch {
        // Fall through to the plain filename when the extended value is invalid.
      }
    }
  }

  const plain = /(?:^|;)\s*filename\s*=\s*("(?:[^"\\]|\\.)*"|[^;]+)/i.exec(
    value,
  )
  const plainValue = plain?.[1]
  if (plainValue === undefined) return null
  const raw = plainValue.trim()
  const unquoted =
    raw.startsWith('"') && raw.endsWith('"')
      ? raw.slice(1, -1).replace(/\\(.)/g, "$1")
      : raw
  try {
    return validateFilename(decodeURIComponent(unquoted))
  } catch {
    return validateFilename(unquoted)
  }
}

function decodeFilename(segment: string): string | null {
  try {
    return validateFilename(decodeURIComponent(segment))
  } catch {
    return null
  }
}

function validateFilename(value: string): string | null {
  if (value.length === 0 || value === "." || value === "..") return null
  for (const character of value) {
    const code = character.codePointAt(0)
    if (code === undefined || code < 0x20 || code === 0x7f) return null
    if (character === "/" || character === "\\") return null
  }
  return value
}

function mimeEssence(value: string | null): string | null {
  if (value === null) return null
  const essence = value.split(";")[0]?.trim().toLowerCase() ?? ""
  return essence.length === 0 ? null : essence
}

function isJsonMime(value: string): boolean {
  return (
    value === "application/json" ||
    value === "text/json" ||
    value.endsWith("+json")
  )
}

function parseContentLength(
  value: string | null,
  encoding: string | null,
): number | null {
  if (value === null) return null
  if (encoding !== null) {
    const normalized = encoding.trim().toLowerCase()
    if (normalized.length > 0 && normalized !== "identity") return null
  }
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const size = Number(trimmed)
  return Number.isSafeInteger(size) ? size : null
}

async function cookieHeaders(
  jar: CookieJar,
  url: URL,
): Promise<Readonly<Record<string, string>>> {
  const cookie = await jar.getCookieString(url)
  return cookie.length === 0 ? {} : { Cookie: cookie }
}

function isNonEmpty(value: string | undefined): boolean {
  return value !== undefined && value.length > 0
}
