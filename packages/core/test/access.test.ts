import { describe, expect, it } from "vitest"
import { Access, createAccessOperation } from "../src/access.js"
import { Auth, type SessionContext } from "../src/auth.js"
import {
  Aborted,
  AuthRequired,
  GrantExpired,
  UnexpectedResponse,
} from "../src/errors.js"
import { Transport } from "../src/transport.js"
import {
  createClock,
  createFakeServer,
  jsonResponse,
  playSessionCookie,
  salesResponse,
  signResponse,
} from "./helpers.js"

type SignHandler = (call: number) => unknown

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolver) => {
    resolve = resolver
  })
  return { promise, resolve }
}

async function accessStack(sign: SignHandler) {
  const server = createFakeServer(async (url, _init, call) => {
    if (url.pathname === "/api/v4/content/sales")
      return jsonResponse(salesResponse([]))
    if (url.pathname === "/api/v4/download/sign/url") {
      const value = await sign(call)
      return value instanceof Response ? value : jsonResponse(value)
    }
    return new Response("", { status: 404 })
  })
  const clock = createClock()
  const transport = new Transport({
    fetch: server.fetch,
    userAgent: "test",
    clock,
    transactionTimeoutMs: 2_000,
    hostRateLimitMs: 1_000,
  })
  const now = () => clock.now()
  const auth = new Auth(transport, now, () => {})
  await auth.importCookies([playSessionCookie()])
  const access = new Access(transport, auth, now)
  const context: SessionContext = auth.beginOperation()
  return { server, clock, auth, access, context }
}

const workId = "RJ123456"

describe("access grants", () => {
  it("requests a signed grant and returns the raw signature parameters", async () => {
    const { access, context, server, clock } = await accessStack(() =>
      signResponse(workId, Math.floor(clock.now() / 1_000) + 3_600),
    )
    const grant = await access.getGrant(context, workId, {
      operation: createAccessOperation(),
    })

    expect(grant.workId).toBe(workId)
    expect(grant.baseUrl).toContain(workId)
    expect(grant.params["Key-Pair-Id"]).toBe("FAKE_KEY_PAIR")
    expect(grant.expiresAt).toBeGreaterThan(clock.now())
    const signCall = server.calls.find((call) =>
      call.url.pathname.endsWith("/sign/url"),
    )
    expect(signCall?.url.searchParams.get("workno")).toBe(workId)
    const headers = (signCall?.init.headers ?? {}) as Record<string, string>
    expect(headers["Authorization"]).toBeUndefined()
  })

  it("uses the earlier of response expiry and Policy DateLessThan", async () => {
    const { access, context, clock } = await accessStack(() => {
      const early = Math.floor(clock.now() / 1_000) + 60
      const response = signResponse(workId, early) as Record<string, unknown>
      response["expires"] = new Date((early + 3_600) * 1_000).toISOString()
      return response
    })
    const grant = await access.getGrant(context, workId, {
      operation: createAccessOperation(),
    })
    expect(grant.expiresAt).toBeLessThanOrEqual(clock.now() + 60_000)
  })

  it("caches a grant and refreshes within the 60 second window once per operation", async () => {
    let calls = 0
    const { access, context, clock } = await accessStack(() => {
      calls += 1
      const expiry =
        calls === 1
          ? Math.floor(clock.now() / 1_000) + 3_600
          : Math.floor(clock.now() / 1_000) + 30
      return signResponse(workId, expiry)
    })

    const firstOperation = createAccessOperation()
    const first = await access.getGrant(context, workId, {
      operation: firstOperation,
    })
    clock.advance(first.expiresAt - clock.now() - 30_000)
    const refreshed = await access.getGrant(context, workId, {
      operation: createAccessOperation(),
    })
    expect(refreshed.expiresAt).toBeLessThanOrEqual(clock.now() + 30_000)
    expect(calls).toBe(2)

    const noLoop = await access.getGrant(context, workId, {
      operation: firstOperation,
    })
    expect(noLoop.expiresAt).toBe(refreshed.expiresAt)
    expect(calls).toBe(2)
  })

  it("merges concurrent grant requests and lets one waiter cancel without canceling the other", async () => {
    const sign = deferred<unknown>()
    const started = deferred<void>()
    const { access, context, server, clock } = await accessStack(() => {
      started.resolve()
      return sign.promise
    })
    const controller = new AbortController()
    const first = access.getGrant(context, workId, {
      operation: createAccessOperation(),
      signal: controller.signal,
    })
    const second = access.getGrant(context, workId, {
      operation: createAccessOperation(),
    })
    await started.promise
    controller.abort()
    await expect(first).rejects.toBeInstanceOf(Aborted)
    sign.resolve(signResponse(workId, Math.floor(clock.now() / 1_000) + 3_600))
    const grant = await second
    expect(grant.workId).toBe(workId)
    expect(
      server.calls.filter((call) => call.url.pathname.endsWith("/sign/url")),
    ).toHaveLength(1)
  })

  it("does not wrap grant-fetch authentication failures as GrantExpired", async () => {
    const { access, context } = await accessStack(
      () => new Response("", { status: 401 }),
    )
    await expect(
      access.getGrant(context, workId, { operation: createAccessOperation() }),
    ).rejects.toBeInstanceOf(AuthRequired)
  })

  it("throws GrantExpired only after a successful but already expired response", async () => {
    const { access, context, clock } = await accessStack(() =>
      signResponse(workId, Math.floor(clock.now() / 1_000) - 1),
    )
    await expect(
      access.getGrant(context, workId, { operation: createAccessOperation() }),
    ).rejects.toBeInstanceOf(GrantExpired)
  })

  it("rejects a grant base URL for a different work", async () => {
    const { access, context } = await accessStack(() => ({
      url: "https://play.dl.dlsite.com/content/work/doujin/RJ00000000/RJ999999/",
      params: { "Policy": "not-base64", "Signature": "s", "Key-Pair-Id": "k" },
    }))
    await expect(
      access.getGrant(context, workId, { operation: createAccessOperation() }),
    ).rejects.toMatchObject({
      code: "UnexpectedResponse",
      diagnostic: "grant_work_mismatch",
    })
  })

  it("rejects an unparseable grant expiry", async () => {
    const { access, context } = await accessStack(() => ({
      url: `https://play.dl.dlsite.com/content/work/doujin/RJ00000000/${workId}/`,
      params: { "Policy": "not-base64", "Signature": "s", "Key-Pair-Id": "k" },
      expires: "not-a-date",
    }))
    await expect(
      access.getGrant(context, workId, { operation: createAccessOperation() }),
    ).rejects.toBeInstanceOf(UnexpectedResponse)
  })

  it("invalidates a cached grant", async () => {
    let calls = 0
    const { access, context, clock } = await accessStack(() => {
      calls += 1
      return signResponse(workId, Math.floor(clock.now() / 1_000) + 3_600)
    })
    await access.getGrant(context, workId, {
      operation: createAccessOperation(),
    })
    access.invalidate(context, workId)
    await access.getGrant(context, workId, {
      operation: createAccessOperation(),
    })
    expect(calls).toBe(2)
  })
})
