import { describe, expect, it } from "vitest"
import { Auth } from "../src/auth.js"
import { Aborted, AuthRequired, InvalidInput } from "../src/errors.js"
import type { SessionSnapshot } from "../src/model.js"
import { Transport } from "../src/transport.js"
import {
  createClock,
  createFakeServer,
  jsonResponse,
  playSessionCookie,
  salesResponse,
  type FakeHandler,
} from "./helpers.js"

const salesPath = "/api/v4/content/sales"

function authHarness(handler: FakeHandler) {
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
  return { server, clock, auth }
}

function salesHandler(calls: { cookie?: string }[] = []) {
  return (url: URL, init: RequestInit) => {
    if (url.pathname !== salesPath) return new Response("", { status: 404 })
    const headers = init.headers as Record<string, string>
    calls.push({ cookie: headers["Cookie"] })
    return jsonResponse(salesResponse(["RJ000001", "RJ000002"]))
  }
}

describe("auth", () => {
  it("validates imported cookies in a candidate jar and replaces the session", async () => {
    const seen: { cookie?: string }[] = []
    const harness = authHarness(salesHandler(seen))
    await harness.auth.importCookies([playSessionCookie()])

    expect(seen).toHaveLength(1)
    expect(seen[0]?.cookie).toContain("play_session=FAKE_PLAY_SESSION")
    const snapshot = await harness.auth.export()
    expect(snapshot.version).toBe(1)
    expect(snapshot.cookies).toHaveLength(1)
    expect(snapshot.cookies[0]).toMatchObject({
      name: "play_session",
      domain: "play.dlsite.com",
      path: "/",
      secure: true,
      hostOnly: true,
      httpOnly: true,
    })
    expect(JSON.stringify(snapshot)).not.toContain("FAKE_GRANT")
  })

  it("does not send an expired cookie during candidate validation", async () => {
    let requireCookie = false
    const harness = authHarness((url, init) => {
      if (url.pathname !== salesPath) return new Response("", { status: 404 })
      const cookie = (init.headers as Record<string, string>)["Cookie"]
      if (
        requireCookie &&
        (cookie === undefined || !cookie.includes("play_session="))
      ) {
        return new Response("", { status: 401 })
      }
      return jsonResponse(salesResponse([]))
    })
    await harness.auth.importCookies([
      playSessionCookie({ value: "OLD_SESSION" }),
    ])
    requireCookie = true
    await expect(
      harness.auth.importCookies([
        playSessionCookie({ value: "EXPIRED_SESSION", expires: 1 }),
      ]),
    ).rejects.toBeInstanceOf(AuthRequired)
    const snapshot = await harness.auth.export()
    expect(snapshot.cookies[0]?.value).toBe("OLD_SESSION")
  })

  it("keeps the old session when candidate validation fails", async () => {
    let fail = false
    const harness = authHarness((url) => {
      if (url.pathname !== salesPath) return new Response("", { status: 404 })
      return fail
        ? new Response("", { status: 401 })
        : jsonResponse(salesResponse([]))
    })
    await harness.auth.importCookies([
      playSessionCookie({ value: "OLD_SESSION" }),
    ])
    fail = true
    await expect(
      harness.auth.importCookies([playSessionCookie({ value: "NEW_SESSION" })]),
    ).rejects.toBeInstanceOf(AuthRequired)

    const snapshot = await harness.auth.export()
    expect(snapshot.cookies[0]?.value).toBe("OLD_SESSION")
  })

  it("keeps the old session when candidate validation is canceled", async () => {
    let fail = false
    const harness = authHarness((url, init) => {
      if (url.pathname !== salesPath) return new Response("", { status: 404 })
      if (!fail) return jsonResponse(salesResponse([]))
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        )
      })
    })
    await harness.auth.importCookies([
      playSessionCookie({ value: "OLD_SESSION" }),
    ])
    fail = true
    const controller = new AbortController()
    const pending = harness.auth.importCookies(
      [playSessionCookie({ value: "NEW_SESSION" })],
      { signal: controller.signal },
    )
    controller.abort()
    await expect(pending).rejects.toBeInstanceOf(Aborted)

    const snapshot = await harness.auth.export()
    expect(snapshot.cookies[0]?.value).toBe("OLD_SESSION")
  })

  it("exports and restores only versioned cookie scope", async () => {
    const harness = authHarness(salesHandler())
    await harness.auth.importCookies([playSessionCookie()])
    const snapshot = await harness.auth.export()

    const restored = authHarness(salesHandler())
    await restored.auth.restore(snapshot)
    const after = await restored.auth.export()
    expect(after).toEqual(snapshot)
    expect(Object.keys(after)).toEqual(["version", "cookies"])
    expect(Object.keys(after.cookies[0] ?? {}).sort()).toEqual(
      [
        "domain",
        "expires",
        "hostOnly",
        "httpOnly",
        "name",
        "path",
        "secure",
        "value",
      ].sort(),
    )
  })

  it("rejects invalid snapshots and invalid cookie scopes without network", async () => {
    let calls = 0
    const harness = authHarness((url) => {
      calls += 1
      if (url.pathname !== salesPath) return new Response("", { status: 404 })
      return jsonResponse(salesResponse([]))
    })
    const invalidVersion = {
      version: 2,
      cookies: [],
    } as unknown as SessionSnapshot
    await expect(harness.auth.restore(invalidVersion)).rejects.toBeInstanceOf(
      InvalidInput,
    )
    await expect(
      harness.auth.restore({ version: 1, cookies: [] }),
    ).rejects.toBeInstanceOf(InvalidInput)
    await expect(
      harness.auth.importCookies([
        playSessionCookie({ domain: "example.com" }),
      ]),
    ).rejects.toBeInstanceOf(InvalidInput)
    await expect(
      harness.auth.importCookies([
        playSessionCookie({ domain: ".play.dlsite.com" }),
      ]),
    ).rejects.toBeInstanceOf(InvalidInput)
    await expect(
      harness.auth.importCookies([playSessionCookie(), playSessionCookie()]),
    ).rejects.toBeInstanceOf(InvalidInput)
    expect(calls).toBe(0)
  })

  it("sends only cookies matching the Play host for validation", async () => {
    const seen: { cookie?: string }[] = []
    const harness = authHarness((url, init) => {
      if (url.pathname !== salesPath) return new Response("", { status: 404 })
      seen.push({ cookie: (init.headers as Record<string, string>)["Cookie"] })
      return jsonResponse(salesResponse([]))
    })
    await harness.auth.importCookies([
      playSessionCookie(),
      playSessionCookie({
        name: "www_only",
        value: "WWW_VALUE",
        domain: "www.dlsite.com",
        hostOnly: true,
      }),
    ])
    expect(seen[0]?.cookie).toContain("play_session=FAKE_PLAY_SESSION")
    expect(seen[0]?.cookie).not.toContain("www_only=")
  })

  it("serializes imports in call order", async () => {
    const values: string[] = []
    const harness = authHarness((url, init) => {
      if (url.pathname !== salesPath) return new Response("", { status: 404 })
      const cookie = (init.headers as Record<string, string>)["Cookie"] ?? ""
      values.push(cookie)
      return jsonResponse(salesResponse([]))
    })
    await Promise.all([
      harness.auth.importCookies([playSessionCookie({ value: "FIRST" })]),
      harness.auth.importCookies([playSessionCookie({ value: "SECOND" })]),
    ])
    expect(values).toHaveLength(2)
    expect(values[0]).toContain("FIRST")
    expect(values[1]).toContain("SECOND")
    const snapshot = await harness.auth.export()
    expect(snapshot.cookies[0]?.value).toBe("SECOND")
  })

  it("marks a current session invalid after an explicit auth failure", async () => {
    let fail = false
    let calls = 0
    const harness = authHarness((url) => {
      calls += 1
      if (url.pathname !== salesPath) return new Response("", { status: 404 })
      return fail
        ? new Response("", { status: 401 })
        : jsonResponse(salesResponse([]))
    })
    await harness.auth.importCookies([playSessionCookie()])
    fail = true
    await expect(harness.auth.validate()).rejects.toBeInstanceOf(AuthRequired)
    const afterValidateCalls = calls
    expect(() => harness.auth.beginOperation()).toThrow(AuthRequired)
    expect(calls).toBe(afterValidateCalls)
  })
})
