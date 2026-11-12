import { describe, expect, it, vi } from "vitest"
import { Auth } from "../src/auth.js"
import {
  Aborted,
  AuthRequired,
  InvalidInput,
  UnexpectedResponse,
} from "../src/errors.js"
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

function authHarness(
  handler: FakeHandler,
  startMilliseconds = 1_700_000_000_000,
) {
  const server = createFakeServer(handler)
  const clock = createClock(startMilliseconds)
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

  it("rejects candidate redirects outside the sales path without sending cookies onward", async () => {
    let redirect = false
    let calls = 0
    const harness = authHarness((url) => {
      calls += 1
      if (url.pathname !== salesPath) return new Response("", { status: 404 })
      if (redirect) {
        return new Response("", {
          status: 302,
          headers: { Location: "/unrelated-path" },
        })
      }
      return jsonResponse(salesResponse([]))
    })
    await harness.auth.importCookies([playSessionCookie({ value: "OLD" })])
    redirect = true
    calls = 0
    await expect(
      harness.auth.importCookies([playSessionCookie({ value: "NEW" })]),
    ).rejects.toBeInstanceOf(UnexpectedResponse)
    expect(calls).toBe(1)
    const snapshot = await harness.auth.export()
    expect(snapshot.cookies[0]?.value).toBe("OLD")
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

  it("keeps a Max-Age deadline across requests and rejects restore after it expires", async () => {
    const base = 1_700_000_000_000
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(base)
    try {
      let setCookie = true
      const seen: Array<string | undefined> = []
      const harness = authHarness((url, init) => {
        if (url.pathname !== salesPath) return new Response("", { status: 404 })
        const cookie = (init.headers as Record<string, string>)["Cookie"]
        seen.push(cookie)
        if (cookie === undefined || !cookie.includes("play_session=")) {
          return new Response("", { status: 401 })
        }
        if (setCookie) {
          setCookie = false
          return jsonResponse(salesResponse([]), {
            "set-cookie":
              "play_session=ROTATED; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Secure; HttpOnly",
          })
        }
        return jsonResponse(salesResponse([]))
      }, base)
      await harness.auth.importCookies([playSessionCookie({ value: "OLD" })])
      const deadline = Math.floor((base + 60_000) / 1_000)
      expect((await harness.auth.export()).cookies[0]?.expires).toBe(deadline)

      harness.clock.advance(20_000)
      vi.setSystemTime(base + 20_000)
      await harness.auth.validate()
      expect(seen[seen.length - 1]).toContain("play_session=ROTATED")
      const beforeExpiry = await harness.auth.export()
      expect(beforeExpiry.cookies[0]?.expires).toBe(deadline)

      harness.clock.advance(45_000)
      vi.setSystemTime(base + 65_000)
      expect((await harness.auth.export()).cookies).toHaveLength(0)
      await expect(harness.auth.validate()).rejects.toBeInstanceOf(AuthRequired)
      expect(seen[seen.length - 1]).toBeUndefined()

      const restoredSeen: Array<string | undefined> = []
      const restored = authHarness((url, init) => {
        if (url.pathname !== salesPath) return new Response("", { status: 404 })
        const cookie = (init.headers as Record<string, string>)["Cookie"]
        restoredSeen.push(cookie)
        return cookie?.includes("play_session=")
          ? jsonResponse(salesResponse([]))
          : new Response("", { status: 401 })
      }, base + 65_000)
      await expect(restored.auth.restore(beforeExpiry)).rejects.toBeInstanceOf(
        AuthRequired,
      )
      expect(restoredSeen).toHaveLength(1)
      expect(restoredSeen[0]).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it("allows a new Set-Cookie to establish a new Max-Age deadline", async () => {
    const base = 1_700_000_000_000
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(base)
    try {
      let salesCalls = 0
      const harness = authHarness((url) => {
        if (url.pathname !== salesPath) return new Response("", { status: 404 })
        salesCalls += 1
        if (salesCalls === 1) {
          return jsonResponse(salesResponse([]), {
            "set-cookie":
              "play_session=FIRST; Max-Age=60; Path=/; Secure; HttpOnly",
          })
        }
        if (salesCalls === 2) {
          return jsonResponse(salesResponse([]), {
            "set-cookie":
              "play_session=SECOND; Max-Age=120; Path=/; Secure; HttpOnly",
          })
        }
        return jsonResponse(salesResponse([]))
      }, base)
      await harness.auth.importCookies([playSessionCookie({ value: "OLD" })])
      expect((await harness.auth.export()).cookies[0]?.expires).toBe(
        Math.floor((base + 60_000) / 1_000),
      )

      harness.clock.advance(20_000)
      vi.setSystemTime(base + 20_000)
      await harness.auth.validate()
      expect((await harness.auth.export()).cookies[0]?.expires).toBe(
        Math.floor((base + 140_000) / 1_000),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([0, -1])(
    "does not export a Max-Age %i deletion as a session cookie",
    async (maxAge) => {
      const base = 1_700_000_000_000
      vi.useFakeTimers({ toFake: ["Date"] })
      vi.setSystemTime(base)
      try {
        let firstSalesCall = true
        const seen: Array<string | undefined> = []
        const harness = authHarness((url, init) => {
          if (url.pathname !== salesPath)
            return new Response("", { status: 404 })
          const cookie = (init.headers as Record<string, string>)["Cookie"]
          seen.push(cookie)
          if (firstSalesCall) {
            firstSalesCall = false
            return jsonResponse(salesResponse([]), {
              "set-cookie": `play_session=DELETED; Max-Age=${maxAge}; Path=/; Secure; HttpOnly`,
            })
          }
          return cookie?.includes("keep=KEEP")
            ? jsonResponse(salesResponse([]))
            : new Response("", { status: 401 })
        }, base)
        await harness.auth.importCookies([
          playSessionCookie({ value: "OLD" }),
          playSessionCookie({
            name: "keep",
            value: "KEEP",
            expires: undefined,
          }),
        ])

        const snapshot = await harness.auth.export()
        expect(snapshot.cookies.map((cookie) => cookie.name)).toEqual(["keep"])
        expect(snapshot.cookies[0]?.expires).toBeNull()

        await harness.auth.validate()
        expect(seen[seen.length - 1]).toContain("keep=KEEP")
        expect(seen[seen.length - 1]).not.toContain("play_session=")

        const restoredSeen: Array<string | undefined> = []
        const restored = authHarness((url, init) => {
          if (url.pathname !== salesPath)
            return new Response("", { status: 404 })
          const cookie = (init.headers as Record<string, string>)["Cookie"]
          restoredSeen.push(cookie)
          return cookie?.includes("keep=KEEP")
            ? jsonResponse(salesResponse([]))
            : new Response("", { status: 401 })
        }, base)
        await restored.auth.restore(snapshot)
        expect(restoredSeen[0]).toContain("keep=KEEP")
        expect(restoredSeen[0]).not.toContain("play_session=")
      } finally {
        vi.useRealTimers()
      }
    },
  )

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

  it("keeps legal empty cookie values through import, export, and restore", async () => {
    const handler = (seen: Array<string | undefined>): FakeHandler => {
      return (url, init) => {
        if (url.pathname !== salesPath) return new Response("", { status: 404 })
        const cookie = (init.headers as Record<string, string>)["Cookie"]
        seen.push(cookie)
        if (cookie === undefined || !cookie.includes("play_session=")) {
          return new Response("", { status: 401 })
        }
        return jsonResponse(salesResponse([]), {
          "set-cookie": "server_empty=; Path=/; Secure; HttpOnly",
        })
      }
    }

    const importedSeen: Array<string | undefined> = []
    const harness = authHarness(handler(importedSeen))
    await harness.auth.importCookies([
      playSessionCookie(),
      playSessionCookie({ name: "imported_empty", value: "" }),
    ])
    const snapshot = await harness.auth.export()
    expect(
      snapshot.cookies
        .filter((cookie) => cookie.value === "")
        .map((cookie) => cookie.name)
        .sort(),
    ).toEqual(["imported_empty", "server_empty"])

    const restoredSeen: Array<string | undefined> = []
    const restored = authHarness(handler(restoredSeen))
    await expect(restored.auth.restore(snapshot)).resolves.toBeUndefined()
    expect(restoredSeen[0]).toContain("imported_empty=")
    expect(restoredSeen[0]).toContain("server_empty=")
    const after = await restored.auth.export()
    expect(
      after.cookies
        .filter((cookie) => cookie.value === "")
        .map((cookie) => cookie.name)
        .sort(),
    ).toEqual(["imported_empty", "server_empty"])
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
    await expect(
      harness.auth.importCookies([
        playSessionCookie({ value: "BAD\u0001VALUE" }),
      ]),
    ).rejects.toBeInstanceOf(InvalidInput)
    await expect(
      harness.auth.restore({
        version: 1,
        cookies: [
          {
            name: "bad",
            value: "BAD\u0001VALUE",
            domain: "play.dlsite.com",
            path: "/",
            secure: true,
            hostOnly: true,
            httpOnly: true,
            expires: null,
          },
        ],
      }),
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

  it("does not invalidate the session when the caller aborts an auth failure", async () => {
    const harness = authHarness(salesHandler())
    await harness.auth.importCookies([playSessionCookie()])
    harness.server.calls.length = 0
    const controller = new AbortController()

    await expect(
      harness.auth.operation(
        async () => {
          controller.abort()
          throw new AuthRequired("test")
        },
        { signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(Aborted)

    await expect(harness.auth.validate()).resolves.toBeUndefined()
    expect(
      harness.server.calls.some((call) => call.url.pathname === salesPath),
    ).toBe(true)
  })
})
