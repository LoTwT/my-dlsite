import { describe, expect, it, vi } from "vitest"
import {
  Aborted,
  AuthRequired,
  InvalidInput,
  SessionChanged,
} from "../src/errors.js"
import type { CoreRuntimeOptions, ScopedCookie } from "../src/model.js"
import { createHarness, type Harness } from "./client-helpers.js"
import {
  jsonResponse,
  playSessionCookie,
  salesResponse,
  type FakeHandler,
} from "./helpers.js"

const workId = "RJ000001"
const entryUrl = `https://play.dlsite.com/api/v3/download?workno=${workId}`
const wwwUrl = `https://www.dlsite.com/home/download/=/product_id/${workId}.html`
const finalUrl = `https://download.dlsite.com/get/=/type/work/domain/doujin/dir/RJ000000/file/${workId}.zip/_/20261016141106?update_date=2026-10-16`

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolver) => {
    resolve = resolver
  })
  return { promise, resolve }
}

function redirect(location: string, setCookie?: string): Response {
  const headers: Record<string, string> = { Location: location }
  if (setCookie !== undefined) headers["set-cookie"] = setCookie
  return new Response("", { status: 302, headers })
}

function fileResponse(headers: Record<string, string>): {
  response: Response
  canceled: () => boolean
} {
  let canceled = false
  const response = {
    status: 200,
    headers: new Headers(headers),
    redirected: false,
    body: {
      cancel: async () => {
        canceled = true
      },
    },
    text: () => {
      throw new Error("body_read")
    },
    json: () => {
      throw new Error("body_read")
    },
  } as unknown as Response
  return { response, canceled: () => canceled }
}

function domainCookie(name: string, value: string): ScopedCookie {
  return playSessionCookie({
    name,
    value,
    domain: "dlsite.com",
    hostOnly: false,
  })
}

function downloadCookie(name: string, value: string, path = "/"): ScopedCookie {
  return playSessionCookie({
    name,
    value,
    domain: "download.dlsite.com",
    hostOnly: true,
    path,
  })
}

function wwwCookie(name: string, value: string): ScopedCookie {
  return playSessionCookie({
    name,
    value,
    domain: "www.dlsite.com",
    hostOnly: true,
  })
}

const baseCookies = [
  playSessionCookie(),
  wwwCookie("www_session", "WWW_SECRET"),
  downloadCookie("download_scope", "DOWNLOAD_SECRET"),
  downloadCookie("path_scope", "PATH_SECRET", "/private"),
  domainCookie("account", "OLD_ACCOUNT"),
]

function withSales(handler: FakeHandler): FakeHandler {
  return (url, init, call) => {
    if (url.pathname === "/api/v4/content/sales") {
      return jsonResponse(salesResponse([]))
    }
    return handler(url, init, call)
  }
}

async function withSession(
  handler: FakeHandler,
  options: CoreRuntimeOptions = {},
): Promise<Harness> {
  const harness = createHarness(withSales(handler), options)
  await harness.client.auth.importCookies(baseCookies)
  harness.server.calls.length = 0
  return harness
}

describe("acquisition", () => {
  it("follows play to www and returns a scoped plan without requesting the file", async () => {
    const harness = await withSession((url) => {
      if (url.href === entryUrl) {
        return redirect(
          wwwUrl,
          "rotated_scope=ROTATED; Domain=.dlsite.com; Path=/; Secure; HttpOnly",
        )
      }
      if (url.href === wwwUrl) {
        return redirect(
          finalUrl,
          "jwt=FINAL_JWT; Domain=.dlsite.com; Path=/; Secure; HttpOnly",
        )
      }
      return new Response("", { status: 404 })
    })

    const plan = await harness.client.acquisition.plan(workId)

    expect(harness.server.calls.map((call) => call.url.href)).toEqual([
      entryUrl,
      wwwUrl,
    ])
    expect(harness.server.calls.map((call) => call.init.method)).toEqual([
      "GET",
      "GET",
    ])
    const entryHeaders = harness.server.calls[0]?.init.headers as Record<
      string,
      string
    >
    const wwwHeaders = harness.server.calls[1]?.init.headers as Record<
      string,
      string
    >
    expect(entryHeaders["Cookie"]).toContain("play_session=FAKE_PLAY_SESSION")
    expect(entryHeaders["Cookie"]).toContain("account=OLD_ACCOUNT")
    expect(entryHeaders["Cookie"]).not.toContain("www_session=")
    expect(entryHeaders["Cookie"]).not.toContain("download_scope=")
    expect(entryHeaders["User-Agent"]).toBe("my-dlsite-core/0.0.0")
    expect(entryHeaders["Accept"]).toBe("*/*")
    expect(entryHeaders["Authorization"]).toBeUndefined()
    expect(wwwHeaders["Cookie"]).toContain("www_session=WWW_SECRET")
    expect(wwwHeaders["Cookie"]).toContain("rotated_scope=ROTATED")
    expect(wwwHeaders["Cookie"]).not.toContain("play_session=")
    expect(wwwHeaders["Cookie"]).not.toContain("download_scope=")

    expect(plan.url).toBe(finalUrl)
    expect(plan.filename).toBe(`${workId}.zip`)
    expect(Object.keys(plan.headers)).toEqual(["Cookie"])
    expect(plan.headers["Cookie"]).toContain("download_scope=DOWNLOAD_SECRET")
    expect(plan.headers["Cookie"]).toContain("account=OLD_ACCOUNT")
    expect(plan.headers["Cookie"]).toContain("rotated_scope=ROTATED")
    expect(plan.headers["Cookie"]).toContain("jwt=FINAL_JWT")
    expect(plan.headers["Cookie"]).not.toContain("path_scope=")
    expect(plan.headers["Cookie"]).not.toContain("play_session=")
    expect(plan.headers["Cookie"]).not.toContain("www_session=")
    expect(plan.headers["Authorization"]).toBeUndefined()
    expect(plan).not.toHaveProperty("mimeType")
    expect(plan).not.toHaveProperty("sizeBytes")
    expect(plan).not.toHaveProperty("expiresAt")
  })

  it("uses a direct ZIP response and cancels its body without reading it", async () => {
    const file = fileResponse({
      "content-type": "application/zip; charset=binary",
      "content-length": "12345",
      "content-disposition": `attachment; filename="${workId}.zip"`,
    })
    const harness = await withSession((url) => {
      if (url.href === entryUrl) return file.response
      return new Response("", { status: 404 })
    })

    const plan = await harness.client.acquisition.plan(workId)

    expect(harness.server.calls).toHaveLength(1)
    expect(plan).toMatchObject({
      url: entryUrl,
      filename: `${workId}.zip`,
      mimeType: "application/zip",
      sizeBytes: 12345,
    })
    expect(plan.headers["Cookie"]).toContain("play_session=FAKE_PLAY_SESSION")
    expect(plan.headers["Cookie"]).toContain("account=OLD_ACCOUNT")
    expect(plan).not.toHaveProperty("expiresAt")
    expect(file.canceled()).toBe(true)
  })

  it("returns a plan from an octet-stream attachment with an RFC 5987 filename", async () => {
    const file = fileResponse({
      "content-type": "application/octet-stream",
      "content-disposition": "attachment; filename*=UTF-8''RJ%20002.zip",
    })
    const harness = await withSession((url) => {
      if (url.href === entryUrl) return file.response
      return new Response("", { status: 404 })
    })

    const plan = await harness.client.acquisition.plan(workId)

    expect(plan.filename).toBe("RJ 002.zip")
    expect(plan.mimeType).toBe("application/octet-stream")
    expect(plan).not.toHaveProperty("sizeBytes")
    expect(file.canceled()).toBe(true)
  })

  it("omits a content length that describes an encoded body", async () => {
    const file = fileResponse({
      "content-type": "application/zip",
      "content-length": "123",
      "content-encoding": "gzip",
      "content-disposition": `attachment; filename="${workId}.zip"`,
    })
    const harness = await withSession((url) => {
      if (url.href === entryUrl) return file.response
      return new Response("", { status: 404 })
    })

    const plan = await harness.client.acquisition.plan(workId)

    expect(plan.mimeType).toBe("application/zip")
    expect(plan).not.toHaveProperty("sizeBytes")
    expect(file.canceled()).toBe(true)
  })

  it("decodes the filename from the final URL path", async () => {
    const encodedUrl = `https://download.dlsite.com/get/=/type/work/domain/doujin/dir/RJ000000/file/RJ%20001.zip/_/20261016141106`
    const harness = await withSession((url) => {
      if (url.href === entryUrl) return redirect(wwwUrl)
      if (url.href === wwwUrl) return redirect(encodedUrl)
      return new Response("", { status: 404 })
    })

    const plan = await harness.client.acquisition.plan(workId)

    expect(plan.url).toBe(encodedUrl)
    expect(plan.filename).toBe("RJ 001.zip")
  })

  it("accepts the /file/{filename}/ download shape", async () => {
    const fileUrl = "https://download.dlsite.com/file/RJ%20003.zip/"
    const harness = await withSession((url) => {
      if (url.href === entryUrl) return redirect(wwwUrl)
      if (url.href === wwwUrl) return redirect(fileUrl)
      return new Response("", { status: 404 })
    })

    const plan = await harness.client.acquisition.plan(workId)

    expect(plan.url).toBe(fileUrl)
    expect(plan.filename).toBe("RJ 003.zip")
    expect(harness.server.calls).toHaveLength(2)
  })

  it("does not treat an HTML page as a ZIP", async () => {
    const playEntry = await withSession((url) => {
      if (url.href === entryUrl) {
        return new Response("<html>login</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })
      }
      return new Response("", { status: 404 })
    })
    await expect(
      playEntry.client.acquisition.plan(workId),
    ).rejects.toMatchObject({
      code: "UnexpectedResponse",
      diagnostic: "unexpected_content_type",
    })
    expect(playEntry.server.calls).toHaveLength(1)

    const www = await withSession((url) => {
      if (url.href === entryUrl) return redirect(wwwUrl)
      if (url.href === wwwUrl) {
        return new Response("<html>serial</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })
      }
      return new Response("", { status: 404 })
    })
    await expect(www.client.acquisition.plan(workId)).rejects.toMatchObject({
      code: "UnsupportedDelivery",
      reason: "html_response",
    })
    expect(www.server.calls).toHaveLength(2)
  })

  it("rejects unknown, unsafe, looping, and malformed redirects without a plan", async () => {
    const unknown = await withSession((url) => {
      if (url.href === entryUrl) {
        return redirect("https://evil.example/steal?token=SECRET")
      }
      return new Response("", { status: 404 })
    })
    const unknownError = await unknown.client.acquisition
      .plan(workId)
      .catch((error: unknown) => error)
    expect(unknownError).toMatchObject({
      code: "UnexpectedResponse",
      diagnostic: "unexpected_target",
    })
    expect(String(unknownError)).not.toContain("SECRET")
    expect(unknown.server.calls).toHaveLength(1)

    const credentials = await withSession((url) => {
      if (url.href === entryUrl) {
        return redirect(`https://user:pass@download.dlsite.com/file/x.zip/`)
      }
      return new Response("", { status: 404 })
    })
    await expect(
      credentials.client.acquisition.plan(workId),
    ).rejects.toMatchObject({
      code: "UnexpectedResponse",
      diagnostic: "unexpected_target",
    })
    expect(credentials.server.calls).toHaveLength(1)

    const missing = await withSession((url) => {
      if (url.href === entryUrl) return new Response("", { status: 302 })
      return new Response("", { status: 404 })
    })
    await expect(missing.client.acquisition.plan(workId)).rejects.toMatchObject(
      {
        code: "UnexpectedResponse",
        diagnostic: "redirect_without_location",
      },
    )

    const invalid = await withSession((url) => {
      if (url.href === entryUrl) {
        return new Response("", {
          status: 302,
          headers: { Location: "http://[" },
        })
      }
      return new Response("", { status: 404 })
    })
    await expect(invalid.client.acquisition.plan(workId)).rejects.toMatchObject(
      {
        code: "UnexpectedResponse",
        diagnostic: "invalid_redirect_target",
      },
    )
    expect(invalid.server.calls).toHaveLength(1)

    const insecure = await withSession((url) => {
      if (url.href === entryUrl) {
        return redirect("http://download.dlsite.com/file/x.zip/")
      }
      return new Response("", { status: 404 })
    })
    await expect(
      insecure.client.acquisition.plan(workId),
    ).rejects.toMatchObject({
      code: "UnexpectedResponse",
      diagnostic: "unexpected_target",
    })
    expect(insecure.server.calls).toHaveLength(1)

    const looping = await withSession((url) => {
      if (url.href === entryUrl) return redirect(wwwUrl)
      if (url.href === wwwUrl) return redirect(wwwUrl)
      return new Response("", { status: 404 })
    })
    await expect(looping.client.acquisition.plan(workId)).rejects.toMatchObject(
      {
        code: "UnexpectedResponse",
        diagnostic: "redirect_loop",
      },
    )
    expect(looping.server.calls).toHaveLength(2)
  })

  it.each([
    [
      "an unsupported file extension",
      `https://download.dlsite.com/get/=/type/work/domain/doujin/dir/RJ000000/file/${workId}.rar/_/20261016141106`,
      "UnsupportedDelivery",
    ],
    [
      "an unrecognized download path",
      "https://download.dlsite.com/static/archive.zip",
      "UnsupportedDelivery",
    ],
    [
      "an unrecognized download query",
      `https://download.dlsite.com/get/=/type/work/domain/doujin/dir/RJ000000/file/${workId}.zip/_/20261016141106?token=SECRET`,
      "UnsupportedDelivery",
    ],
    [
      "a malformed filename",
      `https://download.dlsite.com/get/=/type/work/domain/doujin/dir/RJ000000/file/%ZZ.zip/_/20261016141106`,
      "UnexpectedResponse",
    ],
  ])("rejects %s", async (_label, location, code) => {
    const harness = await withSession((url) => {
      if (url.href === entryUrl) return redirect(location)
      return new Response("", { status: 404 })
    })

    await expect(harness.client.acquisition.plan(workId)).rejects.toMatchObject(
      code === "UnsupportedDelivery"
        ? { code, reason: "download_target" }
        : { code, diagnostic: "filename" },
    )
    expect(harness.server.calls).toHaveLength(1)
    expect(harness.server.calls[0]?.url.hostname).toBe("play.dlsite.com")
  })

  it("treats a Play-entry login redirect as AuthRequired and invalidates the session", async () => {
    const harness = await withSession((url) => {
      if (url.href === entryUrl) {
        return redirect("https://www.dlsite.com/home/login/=/skip_register/1")
      }
      return new Response("", { status: 404 })
    })

    await expect(
      harness.client.acquisition.plan(workId),
    ).rejects.toBeInstanceOf(AuthRequired)
    const calls = harness.server.calls.length
    await expect(
      harness.client.acquisition.plan(workId),
    ).rejects.toBeInstanceOf(AuthRequired)
    expect(harness.server.calls.length).toBe(calls)
  })

  it("does not invalidate the Play session for main-site auth failures", async () => {
    let mode: "login" | "www401" | "play403" | "ok" = "login"
    const harness = await withSession((url) => {
      if (url.href === entryUrl) {
        if (mode === "play403") return new Response("", { status: 403 })
        return redirect(wwwUrl)
      }
      if (url.href === wwwUrl) {
        if (mode === "login") {
          return redirect("https://www.dlsite.com/home/login/=/skip_register/1")
        }
        if (mode === "www401") return new Response("", { status: 401 })
        return redirect(finalUrl)
      }
      return new Response("", { status: 404 })
    })

    await expect(harness.client.acquisition.plan(workId)).rejects.toMatchObject(
      {
        code: "UnexpectedResponse",
        diagnostic: "login_redirect",
      },
    )
    mode = "www401"
    await expect(harness.client.acquisition.plan(workId)).rejects.toMatchObject(
      { code: "HttpError", status: 401 },
    )
    mode = "play403"
    await expect(harness.client.acquisition.plan(workId)).rejects.toMatchObject(
      { code: "HttpError", status: 403 },
    )
    mode = "ok"
    await expect(
      harness.client.acquisition.plan(workId),
    ).resolves.toMatchObject({ url: finalUrl })
  })

  it("retries one GET 429 with Retry-After", async () => {
    let entryCalls = 0
    const harness = await withSession((url) => {
      if (url.href === entryUrl) {
        entryCalls += 1
        if (entryCalls === 1) {
          return new Response("", {
            status: 429,
            headers: { "retry-after": "1" },
          })
        }
        return redirect(wwwUrl)
      }
      if (url.href === wwwUrl) return redirect(finalUrl)
      return new Response("", { status: 404 })
    })

    const plan = await harness.client.acquisition.plan(workId)

    expect(plan.url).toBe(finalUrl)
    expect(harness.server.calls).toHaveLength(3)
    expect(harness.clock.sleeps).toContain(1_000)
  })

  it("shares the transaction deadline across acquisition hops", async () => {
    const harness = createHarness(
      (url, init) => {
        if (url.pathname === "/api/v4/content/sales") {
          return jsonResponse(salesResponse([]))
        }
        if (url.href === entryUrl) return redirect(wwwUrl)
        if (url.href === wwwUrl) {
          return new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Timed out", "TimeoutError")),
              { once: true },
            )
          })
        }
        return new Response("", { status: 404 })
      },
      { transactionTimeoutMs: 20 },
    )
    await harness.client.auth.importCookies([playSessionCookie()])
    harness.server.calls.length = 0

    await expect(harness.client.acquisition.plan(workId)).rejects.toMatchObject(
      { code: "TransportError", reason: "timeout" },
    )
    expect(harness.server.calls).toHaveLength(2)
  })

  it("maps a session replacement during the chain to SessionChanged without an old-account plan", async () => {
    const wwwResponse = deferred<Response>()
    const wwwStarted = deferred<void>()
    let mode: "old" | "new" = "old"
    const harness = createHarness(
      (url) => {
        if (url.pathname === "/api/v4/content/sales") {
          return jsonResponse(salesResponse([]))
        }
        if (url.href === entryUrl) {
          if (mode === "new") return redirect(wwwUrl)
          return redirect(
            wwwUrl,
            "rotated_scope=OLD_SECRET; Domain=.dlsite.com; Path=/",
          )
        }
        if (url.href === wwwUrl) {
          if (mode === "new") {
            return redirect(finalUrl, "jwt=NEW_JWT; Domain=.dlsite.com; Path=/")
          }
          wwwStarted.resolve()
          return wwwResponse.promise
        }
        return new Response("", { status: 404 })
      },
      { transactionTimeoutMs: 5_000 },
    )
    await harness.client.auth.importCookies([
      playSessionCookie({ value: "OLD" }),
      domainCookie("account", "OLD_ACCOUNT"),
    ])
    harness.server.calls.length = 0

    const pending = harness.client.acquisition.plan(workId)
    await wwwStarted.promise
    await harness.client.auth.importCookies([
      playSessionCookie({ value: "NEW" }),
      domainCookie("account", "NEW_ACCOUNT"),
    ])
    wwwResponse.resolve(
      redirect(finalUrl, "jwt=OLD_JWT; Domain=.dlsite.com; Path=/"),
    )

    await expect(pending).rejects.toBeInstanceOf(SessionChanged)

    mode = "new"
    const plan = await harness.client.acquisition.plan(workId)
    expect(plan.headers["Cookie"]).toContain("account=NEW_ACCOUNT")
    expect(plan.headers["Cookie"]).toContain("jwt=NEW_JWT")
    expect(plan.headers["Cookie"]).not.toContain("OLD_ACCOUNT")
    expect(plan.headers["Cookie"]).not.toContain("OLD_JWT")
    expect(plan.headers["Cookie"]).not.toContain("OLD_SECRET")
  })

  it("does not create a plan when canceled before or during the chain", async () => {
    const wwwStarted = deferred<void>()
    const harness = await withSession((url, init) => {
      if (url.href === entryUrl) return redirect(wwwUrl)
      if (url.href === wwwUrl) {
        wwwStarted.resolve()
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          )
        })
      }
      return new Response("", { status: 404 })
    })

    const preCanceled = new AbortController()
    preCanceled.abort()
    await expect(
      harness.client.acquisition.plan(workId, {
        signal: preCanceled.signal,
      }),
    ).rejects.toBeInstanceOf(Aborted)
    expect(harness.server.calls).toHaveLength(0)

    const controller = new AbortController()
    const pending = harness.client.acquisition.plan(workId, {
      signal: controller.signal,
    })
    await wwwStarted.promise
    controller.abort()
    await expect(pending).rejects.toBeInstanceOf(Aborted)
    expect(harness.server.calls).toHaveLength(2)
  })

  it("rejects an empty work ID without network", async () => {
    const harness = await withSession(() => new Response("", { status: 404 }))

    await expect(harness.client.acquisition.plan("")).rejects.toBeInstanceOf(
      InvalidInput,
    )
    expect(harness.server.calls).toHaveLength(0)
  })

  it("does not leak cookies, URLs, or response bodies through errors or logs", async () => {
    const secret = "FAKE_ACQUISITION_SECRET"
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const forbidden = await withSession((url) => {
        if (url.href === entryUrl) {
          return new Response(secret, {
            status: 403,
            headers: {
              "set-cookie": `leak=${secret}; Domain=.dlsite.com; Path=/`,
            },
          })
        }
        return new Response("", { status: 404 })
      })
      const forbiddenError = await forbidden.client.acquisition
        .plan(workId)
        .catch((error: unknown) => error)
      expect(forbiddenError).toMatchObject({ code: "HttpError", status: 403 })
      expect(String(forbiddenError)).not.toContain(secret)
      expect(JSON.stringify(forbiddenError)).not.toContain(secret)

      const unsupported = await withSession((url) => {
        if (url.href === entryUrl) {
          return redirect(
            `https://download.dlsite.com/get/=/type/work/domain/doujin/dir/RJ000000/file/${secret}.rar/_/20261016141106`,
          )
        }
        return new Response("", { status: 404 })
      })
      const unsupportedError = await unsupported.client.acquisition
        .plan(workId)
        .catch((error: unknown) => error)
      expect(unsupportedError).toMatchObject({ code: "UnsupportedDelivery" })
      expect(String(unsupportedError)).not.toContain(secret)
      expect(JSON.stringify(unsupportedError)).not.toContain(secret)

      expect(log).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
      expect(errorLog).not.toHaveBeenCalled()
    } finally {
      log.mockRestore()
      warn.mockRestore()
      errorLog.mockRestore()
    }
  })
})
