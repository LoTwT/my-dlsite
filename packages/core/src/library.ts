import * as v from "valibot"
import { type Auth, combineSignals } from "./auth.js"
import { UnexpectedResponse } from "./errors.js"
import { exactPath } from "./internal/url.js"
import {
  WORKS_BATCH_SIZE,
  type Diagnostic,
  type LibraryApi,
  type LibraryOptions,
  type LibrarySnapshot,
  type LibraryWork,
  type MakerMetadata,
  type PurchaseRecord,
  type WorkMetadata,
} from "./model.js"
import type { Transport } from "./transport.js"

const PLAY_HOST = "play.dlsite.com"
const FULL_READ_LAST = "0"
const COUNT_URL = new URL("/api/v4/content/count", "https://play.dlsite.com")
COUNT_URL.searchParams.set("last", FULL_READ_LAST)
const SALES_URL = new URL("/api/v4/content/sales", "https://play.dlsite.com")
SALES_URL.searchParams.set("last", FULL_READ_LAST)
const WORKS_URL = new URL("/api/v4/content/works", "https://play.dlsite.com")
const DEFAULT_WORK_TYPES = ["SOU"]

const countSchema = v.object({ user: v.number() })
const salesSchema = v.array(v.unknown())
const worksSchema = v.object({ works: v.array(v.unknown()) })
const workItemSchema = v.looseObject({
  workno: v.pipe(v.string(), v.minLength(1)),
})

export class Library implements LibraryApi {
  private readonly transport: Transport
  private readonly auth: Auth
  private readonly defaultLanguage: string

  constructor(transport: Transport, auth: Auth, defaultLanguage: string) {
    this.transport = transport
    this.auth = auth
    this.defaultLanguage = defaultLanguage
  }

  async list(options: LibraryOptions = {}): Promise<LibrarySnapshot> {
    return this.auth.operation(async (context) => {
      const signal = combineSignals(context.signal, options.signal)
      const diagnostics: Diagnostic[] = []
      const count = await this.transport.requestJson({
        method: "GET",
        url: COUNT_URL,
        endpoint: "library.count",
        allowedHosts: [PLAY_HOST],
        allowedPath: exactPath(COUNT_URL.pathname),
        authContext: "play-session",
        credentials: "session",
        jar: context.jar,
        ...(signal === undefined ? {} : { signal }),
      })
      this.auth.assertCurrent(context)

      const parsedCount = v.safeParse(countSchema, count)
      if (
        !parsedCount.success ||
        !Number.isInteger(parsedCount.output.user) ||
        parsedCount.output.user < 0
      ) {
        throw new UnexpectedResponse("library.count", "count_shape")
      }
      const purchases: PurchaseRecord[] = []
      const seenPurchaseIds = new Set<string>()
      if (parsedCount.output.user > 0) {
        const sales = await this.transport.requestJson({
          method: "GET",
          url: SALES_URL,
          endpoint: "library.sales",
          allowedHosts: [PLAY_HOST],
          allowedPath: exactPath(SALES_URL.pathname),
          authContext: "play-session",
          credentials: "session",
          jar: context.jar,
          ...(signal === undefined ? {} : { signal }),
        })
        this.auth.assertCurrent(context)

        const parsedSales = v.safeParse(salesSchema, sales)
        if (!parsedSales.success) {
          throw new UnexpectedResponse("library.sales", "sales_shape")
        }

        for (const record of parsedSales.output) {
          const purchase = readPurchase(record, diagnostics)
          if (purchase === null) continue
          if (seenPurchaseIds.has(purchase.workId)) {
            diagnostics.push({
              code: "duplicate_purchase_record",
              message:
                "Multiple purchase records reference the same work; the first is kept.",
              workId: purchase.workId,
            })
            continue
          }
          seenPurchaseIds.add(purchase.workId)
          purchases.push(purchase)
        }
      }

      const workIds = [...seenPurchaseIds]
      const language = options.language ?? this.defaultLanguage
      const metadataById = new Map<string, WorkMetadata>()
      for (
        let offset = 0;
        offset < workIds.length;
        offset += WORKS_BATCH_SIZE
      ) {
        const batch = workIds.slice(offset, offset + WORKS_BATCH_SIZE)
        const value = await this.transport.requestJson({
          method: "POST",
          url: WORKS_URL,
          endpoint: "library.works",
          allowedHosts: [PLAY_HOST],
          allowedPath: exactPath(WORKS_URL.pathname),
          authContext: "play-session",
          credentials: "session",
          jar: context.jar,
          body: {
            contentType: "application/json; charset=utf-8",
            text: JSON.stringify({ worknos: batch }),
          },
          ...(signal === undefined ? {} : { signal }),
        })
        this.auth.assertCurrent(context)

        const parsedWorks = v.safeParse(worksSchema, value)
        if (!parsedWorks.success) {
          throw new UnexpectedResponse("library.works", "works_shape")
        }
        const requested = new Set(batch)
        for (const item of parsedWorks.output.works) {
          const parsedItem = v.safeParse(workItemSchema, item)
          if (!parsedItem.success) {
            diagnostics.push({
              code: "invalid_work_metadata",
              message:
                "A work metadata record did not contain a usable work ID.",
            })
            continue
          }
          const workId = parsedItem.output.workno
          if (!requested.has(workId)) {
            diagnostics.push({
              code: "unexpected_work_metadata",
              message:
                "Works response contained a work ID that was not requested.",
              workId,
            })
            continue
          }
          if (metadataById.has(workId)) {
            diagnostics.push({
              code: "duplicate_work_metadata",
              message:
                "Multiple metadata records reference the same work; the first is kept.",
              workId,
            })
            continue
          }
          const metadata = readWorkMetadata(item, workId, language, diagnostics)
          if (metadata !== null) metadataById.set(workId, metadata)
        }
      }

      const filters = options.workTypes ?? DEFAULT_WORK_TYPES
      const includeAll = filters.length === 0
      const works: LibraryWork[] = []
      const otherPurchases: LibraryWork[] = []
      const missingMetadata: PurchaseRecord[] = []

      for (const purchase of purchases) {
        const metadata = metadataById.get(purchase.workId)
        if (metadata === undefined || metadata.workType === null) {
          missingMetadata.push(purchase)
          diagnostics.push({
            code: "missing_work_metadata",
            message: "No complete metadata is available for this purchase.",
            workId: purchase.workId,
          })
          continue
        }
        const work: LibraryWork = { purchase, metadata }
        if (includeAll || filters.includes(metadata.workType)) works.push(work)
        else otherPurchases.push(work)
      }

      return { works, missingMetadata, otherPurchases, diagnostics }
    }, options)
  }
}

function readPurchase(
  value: unknown,
  diagnostics: Diagnostic[],
): PurchaseRecord | null {
  if (!isRecord(value)) {
    diagnostics.push({
      code: "invalid_purchase_record",
      message: "A purchase record was not an object.",
    })
    return null
  }
  const workId = typeof value["workno"] === "string" ? value["workno"] : null
  if (workId === null || workId.length === 0) {
    diagnostics.push({
      code: "invalid_purchase_record",
      message: "A purchase record did not contain a work ID.",
    })
    return null
  }
  const purchasedAt =
    typeof value["sales_date"] === "string" ? value["sales_date"] : null
  if (purchasedAt === null) {
    diagnostics.push({
      code: "missing_purchase_date",
      message: "A purchase record did not contain a usable purchase date.",
      workId,
    })
  }
  return { workId, purchasedAt }
}

function readWorkMetadata(
  value: unknown,
  workId: string,
  language: string,
  diagnostics: Diagnostic[],
): WorkMetadata | null {
  if (!isRecord(value)) return null
  const names = readStringRecord(value["name"])
  const name = localize(names, language)
  if (name === null) {
    diagnostics.push({
      code: "missing_work_name",
      message: "A work has no usable localized name.",
      workId,
    })
  }

  const workType =
    typeof value["work_type"] === "string" && value["work_type"].length > 0
      ? value["work_type"]
      : null
  if (workType === null) {
    diagnostics.push({
      code: "missing_work_type",
      message: "A work has no usable work type.",
      workId,
    })
  }

  return {
    workId,
    workType,
    names,
    name,
    maker: readMaker(value["maker"], language, workId, diagnostics),
    releaseDate: readNullableString(value["release_date"]),
    siteId: readNullableString(value["site_id"]),
    fileType: readNullableString(value["file_type"]),
    ageCategory: readNullableString(value["age_category"]),
    tags: readTags(value["tags"]),
    pcFileSize: readNullableNumber(value["pc_file_size"]),
    playable: readNullableBoolean(value["playable"]),
    downloadable: readNullableBoolean(value["downloadable"]),
    encodable: readNullableBoolean(value["encodable"]),
  }
}

function readMaker(
  value: unknown,
  language: string,
  workId: string,
  diagnostics: Diagnostic[],
): MakerMetadata | null {
  if (!isRecord(value)) return null
  const names = readStringRecord(value["name"])
  const name = localize(names, language)
  if (name === null) {
    diagnostics.push({
      code: "missing_maker_name",
      message: "A work maker has no usable localized name.",
      workId,
    })
  }
  return {
    id: readNullableString(value["id"]),
    names,
    name,
  }
}

function readTags(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  const tags: string[] = []
  for (const tag of value) {
    if (!isRecord(tag)) continue
    const name = tag["name"]
    if (typeof name === "string" && name.length > 0) tags.push(name)
  }
  return tags
}

function readStringRecord(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) return {}
  const output: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") output[key] = entry
  }
  return output
}

function localize(
  names: Readonly<Record<string, string>>,
  language: string,
): string | null {
  const requested = names[language]
  const japanese = names["ja_JP"]
  const english = names["en_US"]
  return requested ?? japanese ?? english ?? Object.values(names)[0] ?? null
}

function readNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function readNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function readNullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
