import { describe, expect, it } from "vitest"
import { Auth } from "../src/auth.js"
import {
  Aborted,
  HttpError,
  IncompleteLibrary,
  SessionChanged,
  UnexpectedResponse,
} from "../src/errors.js"
import { Library } from "../src/library.js"
import { Transport } from "../src/transport.js"
import {
  createClock,
  createFakeServer,
  jsonResponse,
  playSessionCookie,
  salesResponse,
  workResponse,
  worksResponse,
  type FakeHandler,
} from "./helpers.js"

const workIds = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `RJ${String(10000001 + index)}`)

function readWorknos(init: RequestInit): string[] {
  if (typeof init.body !== "string")
    throw new Error("expected JSON string body")
  const parsed = JSON.parse(init.body) as { worknos?: unknown }
  if (
    !Array.isArray(parsed.worknos) ||
    !parsed.worknos.every((entry) => typeof entry === "string")
  ) {
    throw new Error("expected worknos string array")
  }
  return parsed.worknos
}

function readWorknosFromCall(
  call: { init: RequestInit } | undefined,
): string[] {
  if (call === undefined) throw new Error("missing works call")
  return readWorknos(call.init)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolver) => {
    resolve = resolver
  })
  return { promise, resolve }
}

interface LibraryHandlerOptions {
  sales: unknown
  countUser?: number
  works?: (
    worknos: readonly string[],
    call: number,
  ) => Response | Promise<Response>
  failSales?: boolean
  failWorks?: boolean
}

function libraryHandler(options: LibraryHandlerOptions) {
  let worksCall = 0
  return (url: URL, init: RequestInit): Response | Promise<Response> => {
    if (url.pathname === "/api/v4/content/sales") {
      if (options.failSales === true) return jsonResponse({ not: "an array" })
      return jsonResponse(options.sales)
    }
    if (url.pathname === "/api/v4/content/count") {
      const sales = Array.isArray(options.sales) ? options.sales.length : 0
      return jsonResponse({
        user: options.countUser ?? sales,
        production: 0,
        page_limit: 1,
        concurrency: 1,
      })
    }
    if (url.pathname === "/api/v4/content/works") {
      worksCall += 1
      if (options.failWorks === true) return jsonResponse({ nope: true })
      const worknos = readWorknos(init)
      if (options.works !== undefined) return options.works(worknos, worksCall)
      return jsonResponse(
        worksResponse(worknos.map((workno) => workResponse(workno))),
      )
    }
    return new Response("", { status: 404 })
  }
}

function libraryHarness(handler: FakeHandler) {
  const server = createFakeServer(handler)
  const clock = createClock()
  const transport = new Transport({
    fetch: server.fetch,
    userAgent: "test",
    clock,
    transactionTimeoutMs: 2_000,
    hostRateLimitMs: 1_000,
  })
  const auth = new Auth(
    transport,
    () => clock.now(),
    () => {},
  )
  const library = new Library(transport, auth, "zh_CN")
  return { server, clock, auth, library }
}

async function withSession(handler: FakeHandler) {
  const harness = libraryHarness(handler)
  await harness.auth.importCookies([playSessionCookie()])
  return harness
}

describe("library", () => {
  it("reads count/sales/works, batches by 10 including the tail, and merges by work id", async () => {
    const ids = workIds(12)
    const harness = await withSession(
      libraryHandler({ sales: salesResponse(ids) }),
    )
    const snapshot = await harness.library.list()

    expect(snapshot.works).toHaveLength(12)
    expect(snapshot.missingMetadata).toHaveLength(0)
    expect(snapshot.otherPurchases).toHaveLength(0)
    expect(
      harness.server.calls.filter((call) =>
        call.url.pathname.endsWith("/works"),
      ),
    ).toHaveLength(2)
    const worksCalls = harness.server.calls.filter((call) =>
      call.url.pathname.endsWith("/works"),
    )
    expect(readWorknosFromCall(worksCalls[0])).toHaveLength(10)
    expect(readWorknosFromCall(worksCalls[1])).toHaveLength(2)
    expect(worksCalls[0]?.init.headers).toMatchObject({
      "Content-Type": "application/json; charset=utf-8",
    })

    const countCall = harness.server.calls.find((call) =>
      call.url.pathname.endsWith("/count"),
    )
    const salesCall = harness.server.calls.find((call) =>
      call.url.pathname.endsWith("/sales"),
    )
    expect(countCall?.url.search).toBe("")
    expect(salesCall?.url.search).toBe("")
    expect(snapshot.works.map((work) => work.metadata.workId)).toEqual(ids)
  })

  it("merges metadata by work id regardless of works response order", async () => {
    const ids = ["RJ10000001", "RJ10000002"]
    const harness = await withSession((url, init) => {
      if (url.pathname === "/api/v4/content/sales")
        return jsonResponse(salesResponse(ids))
      if (url.pathname === "/api/v4/content/count") {
        return jsonResponse({
          user: 2,
          production: 0,
          page_limit: 1,
          concurrency: 1,
        })
      }
      const worknos = readWorknos(init)
      return jsonResponse(
        worksResponse(
          [...worknos].reverse().map((workno) => workResponse(workno)),
        ),
      )
    })
    const snapshot = await harness.library.list()
    expect(snapshot.works.map((work) => work.metadata.workId)).toEqual(ids)
    expect(snapshot.works.map((work) => work.metadata.name)).toEqual([
      "作品 RJ10000001",
      "作品 RJ10000002",
    ])
  })

  it("fails the whole list when a later works batch fails", async () => {
    const ids = workIds(20)
    let worksCalls = 0
    const harness = await withSession((url, init) => {
      if (url.pathname === "/api/v4/content/sales")
        return jsonResponse(salesResponse(ids))
      if (url.pathname === "/api/v4/content/count") {
        return jsonResponse({
          user: 20,
          production: 0,
          page_limit: 1,
          concurrency: 1,
        })
      }
      worksCalls += 1
      if (worksCalls === 2) return new Response("", { status: 500 })
      const worknos = readWorknos(init)
      return jsonResponse(
        worksResponse(worknos.map((workno) => workResponse(workno))),
      )
    })
    await expect(harness.library.list()).rejects.toBeInstanceOf(HttpError)
    expect(worksCalls).toBe(2)
  })

  it("defaults to SOU, keeps known other types separate, and honors empty filters", async () => {
    const ids = ["RJ10000001", "RJ10000002"]
    const handler = (url: URL, init: RequestInit): Response => {
      if (url.pathname === "/api/v4/content/sales")
        return jsonResponse(salesResponse(ids))
      if (url.pathname === "/api/v4/content/count") {
        return jsonResponse({
          user: 2,
          production: 0,
          page_limit: 1,
          concurrency: 1,
        })
      }
      const worknos = readWorknos(init)
      const works = worknos.map((workno, index) =>
        workResponse(workno, { work_type: index === 0 ? "SOU" : "ICG" }),
      )
      return jsonResponse(worksResponse(works))
    }
    const harness = await withSession(handler)
    const defaultList = await harness.library.list()
    expect(defaultList.works).toHaveLength(1)
    expect(defaultList.otherPurchases).toHaveLength(1)

    const allList = await harness.library.list({ workTypes: [] })
    expect(allList.works).toHaveLength(2)
    expect(allList.otherPurchases).toHaveLength(0)
  })

  it("keeps purchases without metadata and reports localized name fallback", async () => {
    const ids = ["RJ10000001", "RJ10000002"]
    const handler = (url: URL, init: RequestInit): Response => {
      if (url.pathname === "/api/v4/content/sales")
        return jsonResponse(salesResponse(ids))
      if (url.pathname === "/api/v4/content/count") {
        return jsonResponse({
          user: 2,
          production: 0,
          page_limit: 1,
          concurrency: 1,
        })
      }
      const worknos = readWorknos(init)
      return jsonResponse(
        worksResponse([
          workResponse(worknos[0] ?? "", {
            name: { ja_JP: "日本語名" },
          }),
        ]),
      )
    }
    const harness = await withSession(handler)
    const snapshot = await harness.library.list({ language: "zh_CN" })
    expect(snapshot.works).toHaveLength(1)
    expect(snapshot.works[0]?.metadata.name).toBe("日本語名")
    expect(snapshot.works[0]?.metadata.names).toEqual({ ja_JP: "日本語名" })
    expect(snapshot.missingMetadata).toHaveLength(1)
    expect(snapshot.diagnostics.map((entry) => entry.code)).toContain(
      "missing_work_metadata",
    )
  })

  it("treats a missing work type as missing metadata instead of dropping it", async () => {
    const ids = ["RJ10000001"]
    const harness = await withSession((url, init) => {
      if (url.pathname === "/api/v4/content/sales")
        return jsonResponse(salesResponse(ids))
      if (url.pathname === "/api/v4/content/count") {
        return jsonResponse({
          user: 1,
          production: 0,
          page_limit: 1,
          concurrency: 1,
        })
      }
      const worknos = readWorknos(init)
      return jsonResponse(
        worksResponse([workResponse(worknos[0] ?? "", { work_type: null })]),
      )
    })
    const snapshot = await harness.library.list()
    expect(snapshot.works).toHaveLength(0)
    expect(snapshot.missingMetadata).toHaveLength(1)
    expect(snapshot.diagnostics.map((entry) => entry.code)).toContain(
      "missing_work_type",
    )
  })

  it("keeps valid purchases when a single sales record is malformed", async () => {
    const ids = ["RJ10000001"]
    const sales = [
      ...(salesResponse(ids) as unknown[]),
      { sales_date: "2026-01-01" },
    ]
    const harness = await withSession(libraryHandler({ sales }))
    const snapshot = await harness.library.list()
    expect(snapshot.works).toHaveLength(1)
    expect(snapshot.diagnostics.map((entry) => entry.code)).toContain(
      "invalid_purchase_record",
    )
  })

  it("returns an empty snapshot without works requests", async () => {
    const harness = await withSession(libraryHandler({ sales: [] }))
    const snapshot = await harness.library.list()
    expect(snapshot).toEqual({
      works: [],
      missingMetadata: [],
      otherPurchases: [],
      diagnostics: [],
    })
    expect(
      harness.server.calls.some((call) => call.url.pathname.endsWith("/works")),
    ).toBe(false)
  })

  it("fails loudly when count and sales disagree instead of returning a partial library", async () => {
    const harness = await withSession(
      libraryHandler({ sales: salesResponse(workIds(2)), countUser: 3 }),
    )
    await expect(harness.library.list()).rejects.toBeInstanceOf(
      IncompleteLibrary,
    )
  })

  it("fails on overall structure errors", async () => {
    let failSales = false
    const harness = libraryHarness((url, init) => {
      if (url.pathname === "/api/v4/content/sales") {
        return failSales
          ? jsonResponse({ not: "an array" })
          : jsonResponse(salesResponse([]))
      }
      return libraryHandler({ sales: [] })(url, init)
    })
    await harness.auth.importCookies([playSessionCookie()])
    failSales = true
    await expect(harness.library.list()).rejects.toBeInstanceOf(
      UnexpectedResponse,
    )
  })

  it("does not return a partial snapshot when the session changes during works batches", async () => {
    const ids = workIds(20)
    const firstWorks = deferred<Response>()
    const firstWorksStarted = deferred<void>()
    const secondWorks = deferred<Response>()
    let worksCalls = 0
    const harness = libraryHarness((url, init) => {
      if (url.pathname === "/api/v4/content/sales")
        return jsonResponse(salesResponse(ids))
      if (url.pathname === "/api/v4/content/count") {
        return jsonResponse({
          user: 20,
          production: 0,
          page_limit: 1,
          concurrency: 1,
        })
      }
      worksCalls += 1
      const worknos = readWorknos(init)
      if (worksCalls === 1) {
        firstWorksStarted.resolve()
        return firstWorks.promise
      }
      if (worksCalls === 2) return secondWorks.promise
      return jsonResponse(
        worksResponse(worknos.map((workno) => workResponse(workno))),
      )
    })
    await harness.auth.importCookies([playSessionCookie({ value: "OLD" })])

    const list = harness.library.list()
    await firstWorksStarted.promise
    const importB = harness.auth.importCookies([
      playSessionCookie({ value: "NEW" }),
    ])
    firstWorks.resolve(
      jsonResponse(
        worksResponse(ids.slice(0, 10).map((workno) => workResponse(workno))),
      ),
    )
    await importB
    secondWorks.resolve(
      jsonResponse(
        worksResponse(ids.slice(10, 20).map((workno) => workResponse(workno))),
      ),
    )

    await expect(list).rejects.toBeInstanceOf(SessionChanged)
    const snapshot = await harness.auth.export()
    expect(snapshot.cookies[0]?.value).toBe("NEW")
  })

  it("propagates cancellation without returning a partial snapshot", async () => {
    const ids = workIds(12)
    const harness = await withSession((url, init) => {
      if (url.pathname === "/api/v4/content/sales")
        return jsonResponse(salesResponse(ids))
      if (url.pathname === "/api/v4/content/count") {
        return jsonResponse({
          user: 12,
          production: 0,
          page_limit: 1,
          concurrency: 1,
        })
      }
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        )
      })
    })
    const controller = new AbortController()
    const pending = harness.library.list({ signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toBeInstanceOf(Aborted)
  })
})
