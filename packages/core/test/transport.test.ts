import { Cookie, CookieJar } from "tough-cookie"
import { describe, expect, it } from "vitest"
import { Aborted, AuthRequired, HttpError, RateLimited } from "../src/errors.js"
import { exactPath, pathPrefix } from "../src/internal/url.js"
import { Transport } from "../src/transport.js"
import { createClock, createFakeServer, jsonResponse } from "./helpers.js"

async function sessionJar(): Promise<CookieJar> {
  const jar = new CookieJar()
  await jar.store.putCookie(
    new Cookie({
      key: "play_session",
      value: "FAKE_TRANSPORT_SESSION",
      domain: "play.dlsite.com",
      path: "/",
      secure: true,
      httpOnly: true,
      hostOnly: true,
    }),
  )
  return jar
}

function createTransport(
  server: ReturnType<typeof createFakeServer>,
  clock: ReturnType<typeof createClock>,
) {
  return new Transport({
    fetch: server.fetch,
    userAgent: "test-agent/1.0",
    clock,
    transactionTimeoutMs: 1_000,
    hostRateLimitMs: 1_000,
  })
}

const salesUrl = new URL("https://play.dlsite.com/api/v4/content/sales")

describe("transport", () => {
  it("sends scoped cookies for session credentials but never Authorization", async () => {
    const server = createFakeServer(() => jsonResponse([]))
    const clock = createClock()
    const transport = createTransport(server, clock)
    const jar = await sessionJar()

    await transport.requestJson({
      method: "GET",
      url: salesUrl,
      endpoint: "test",
      allowedHosts: ["play.dlsite.com"],
      allowedPath: exactPath("/api/v4/content/sales"),
      credentials: "session",
      jar,
    })

    const headers = server.calls[0]?.init.headers as Record<string, string>
    expect(headers["Cookie"]).toContain("play_session=FAKE_TRANSPORT_SESSION")
    expect(headers["Authorization"]).toBeUndefined()
    expect(headers["User-Agent"]).toBe("test-agent/1.0")
  })

  it("does not send or persist cookies for CDN credentials", async () => {
    const server = createFakeServer(() =>
      jsonResponse(
        { ok: true },
        { "set-cookie": "cdn_cookie=SECRET; Path=/; Secure" },
      ),
    )
    const clock = createClock()
    const transport = createTransport(server, clock)
    const jar = await sessionJar()
    const cdnUrl = new URL(
      "https://play.dl.dlsite.com/content/work/doujin/RJ00000000/RJ123456/ziptree.json",
    )

    await transport.requestJson({
      method: "GET",
      url: cdnUrl,
      endpoint: "manifest.get",
      allowedHosts: ["play.dl.dlsite.com"],
      allowedPath: pathPrefix("/content/work/doujin/RJ00000000/RJ123456/"),
      credentials: "none",
      jar,
    })

    const headers = server.calls[0]?.init.headers as Record<string, string>
    expect(headers["Cookie"]).toBeUndefined()
    expect(await jar.store.getAllCookies()).toHaveLength(1)
  })

  it("follows safe GET redirects, re-selects cookies, and applies the host rate limit", async () => {
    const server = createFakeServer((url, _init, call) => {
      if (call === 1) {
        return new Response("", {
          status: 302,
          headers: {
            "Location": "/api/v4/content/sales",
            "set-cookie": "rotated=YES; Path=/; Secure; HttpOnly",
          },
        })
      }
      return jsonResponse({ ok: true })
    })
    const clock = createClock()
    const transport = createTransport(server, clock)
    const jar = await sessionJar()

    await transport.requestJson({
      method: "GET",
      url: salesUrl,
      endpoint: "test",
      allowedHosts: ["play.dlsite.com"],
      allowedPath: exactPath("/api/v4/content/sales"),
      credentials: "session",
      jar,
    })

    expect(server.calls).toHaveLength(2)
    expect(server.calls[0]?.url.pathname).toBe("/api/v4/content/sales")
    expect(server.calls[1]?.url.pathname).toBe("/api/v4/content/sales")
    const firstHeaders = server.calls[0]?.init.headers as Record<string, string>
    const secondHeaders = server.calls[1]?.init.headers as Record<
      string,
      string
    >
    expect(firstHeaders["Cookie"]).toContain("play_session=")
    expect(secondHeaders["Cookie"]).toContain("rotated=YES")
    expect(clock.now()).toBeGreaterThanOrEqual(1_000)
  })

  it("keeps the host queue serial when a queued request is canceled", async () => {
    let resolveFirst: ((response: Response) => void) | undefined
    let firstStartedResolve: (() => void) | undefined
    const firstStarted = new Promise<void>((resolve) => {
      firstStartedResolve = resolve
    })
    const server = createFakeServer((_url, _init, call) => {
      if (call === 1) {
        firstStartedResolve?.()
        return new Promise<Response>((resolve) => {
          resolveFirst = resolve
        })
      }
      return jsonResponse({ call })
    })
    const transport = createTransport(server, createClock())
    const first = transport.requestJson({
      method: "GET",
      url: salesUrl,
      endpoint: "test",
      allowedHosts: ["play.dlsite.com"],
      allowedPath: exactPath("/api/v4/content/sales"),
      credentials: "none",
    })
    await firstStarted

    const controller = new AbortController()
    const second = transport.requestJson({
      method: "GET",
      url: salesUrl,
      endpoint: "test",
      allowedHosts: ["play.dlsite.com"],
      allowedPath: exactPath("/api/v4/content/sales"),
      credentials: "none",
      signal: controller.signal,
    })
    const third = transport.requestJson({
      method: "GET",
      url: salesUrl,
      endpoint: "test",
      allowedHosts: ["play.dlsite.com"],
      allowedPath: exactPath("/api/v4/content/sales"),
      credentials: "none",
    })
    controller.abort()
    await expect(second).rejects.toBeInstanceOf(Aborted)
    expect(server.calls).toHaveLength(1)

    resolveFirst?.(jsonResponse({ ok: true }))
    await expect(first).resolves.toEqual({ ok: true })
    await expect(third).resolves.toEqual({ call: 2 })
    expect(server.calls).toHaveLength(2)
  })

  it("selects the current cookies after a queued request gets the host slot", async () => {
    let resolveFirst: ((response: Response) => void) | undefined
    let firstStartedResolve: (() => void) | undefined
    const firstStarted = new Promise<void>((resolve) => {
      firstStartedResolve = resolve
    })
    const server = createFakeServer((_url, _init, call) => {
      if (call === 1) {
        firstStartedResolve?.()
        return new Promise<Response>((resolve) => {
          resolveFirst = resolve
        })
      }
      return jsonResponse([])
    })
    const transport = createTransport(server, createClock())
    const jar = await sessionJar()
    const first = transport.requestJson({
      method: "GET",
      url: salesUrl,
      endpoint: "test",
      allowedHosts: ["play.dlsite.com"],
      allowedPath: exactPath("/api/v4/content/sales"),
      credentials: "session",
      jar,
    })
    await firstStarted
    const second = transport.requestJson({
      method: "GET",
      url: salesUrl,
      endpoint: "test",
      allowedHosts: ["play.dlsite.com"],
      allowedPath: exactPath("/api/v4/content/sales"),
      credentials: "session",
      jar,
    })
    resolveFirst?.(
      jsonResponse([], {
        "set-cookie": "play_session=ROTATED; Path=/; Secure; HttpOnly",
      }),
    )
    await Promise.all([first, second])

    const firstHeaders = server.calls[0]?.init.headers as Record<string, string>
    const secondHeaders = server.calls[1]?.init.headers as Record<
      string,
      string
    >
    expect(firstHeaders["Cookie"]).toContain("FAKE_TRANSPORT_SESSION")
    expect(secondHeaders["Cookie"]).toContain("play_session=ROTATED")
    expect(secondHeaders["Cookie"]).not.toContain("FAKE_TRANSPORT_SESSION")
  })

  it("blocks redirects to unknown hosts and known login entries", async () => {
    const unknown = createFakeServer(
      () =>
        new Response("", {
          status: 302,
          headers: { Location: "https://evil.example/" },
        }),
    )
    const clock = createClock()
    const transport = createTransport(unknown, clock)
    await expect(
      transport.requestJson({
        method: "GET",
        url: salesUrl,
        endpoint: "test",
        allowedHosts: ["play.dlsite.com"],
        allowedPath: exactPath("/api/v4/content/sales"),
        credentials: "none",
      }),
    ).rejects.toMatchObject({
      code: "UnexpectedResponse",
      diagnostic: "unexpected_target",
    })
    expect(unknown.calls).toHaveLength(1)

    const outsidePath = createFakeServer(
      () =>
        new Response("", {
          status: 302,
          headers: { Location: "/unrelated-path" },
        }),
    )
    const outsidePathTransport = createTransport(outsidePath, createClock())
    await expect(
      outsidePathTransport.requestJson({
        method: "GET",
        url: salesUrl,
        endpoint: "test",
        allowedHosts: ["play.dlsite.com"],
        allowedPath: exactPath("/api/v4/content/sales"),
        credentials: "none",
      }),
    ).rejects.toMatchObject({
      code: "UnexpectedResponse",
      diagnostic: "unexpected_target",
    })
    expect(outsidePath.calls).toHaveLength(1)

    const login = createFakeServer(
      () =>
        new Response("", {
          status: 302,
          headers: {
            Location: "https://www.dlsite.com/home/login/=/skip_register/1",
          },
        }),
    )
    const loginTransport = createTransport(login, createClock())
    await expect(
      loginTransport.requestJson({
        method: "GET",
        url: salesUrl,
        endpoint: "test",
        allowedHosts: ["play.dlsite.com"],
        allowedPath: exactPath("/api/v4/content/sales"),
        credentials: "session",
        jar: await sessionJar(),
      }),
    ).rejects.toBeInstanceOf(AuthRequired)
    expect(login.calls).toHaveLength(1)
  })

  it("rejects POST redirects instead of replaying the body", async () => {
    const server = createFakeServer(
      () =>
        new Response("", {
          status: 302,
          headers: { Location: "/api/v4/content/works" },
        }),
    )
    const transport = createTransport(server, createClock())
    await expect(
      transport.requestJson({
        method: "POST",
        url: new URL("https://play.dlsite.com/api/v4/content/works"),
        endpoint: "library.works",
        allowedHosts: ["play.dlsite.com"],
        allowedPath: exactPath("/api/v4/content/works"),
        credentials: "none",
        body: { contentType: "application/json", text: "{}" },
      }),
    ).rejects.toMatchObject({
      code: "UnexpectedResponse",
      diagnostic: "post_redirect",
    })
    expect(server.calls).toHaveLength(1)
  })

  it("retries GET 429 once and honors Retry-After", async () => {
    const server = createFakeServer((_url, _init, call) => {
      if (call === 1) {
        return new Response("", {
          status: 429,
          headers: { "retry-after": "1" },
        })
      }
      return jsonResponse({ ok: true })
    })
    const clock = createClock()
    const transport = createTransport(server, clock)
    await expect(
      transport.requestJson({
        method: "GET",
        url: salesUrl,
        endpoint: "test",
        allowedHosts: ["play.dlsite.com"],
        allowedPath: exactPath("/api/v4/content/sales"),
        credentials: "none",
      }),
    ).resolves.toEqual({ ok: true })
    expect(server.calls).toHaveLength(2)
    expect(clock.sleeps).toContain(1_000)
  })

  it("does not retry POST 429 and does not retry a second GET 429", async () => {
    const post = createFakeServer(() => new Response("", { status: 429 }))
    const postTransport = createTransport(post, createClock())
    await expect(
      postTransport.requestJson({
        method: "POST",
        url: new URL("https://play.dlsite.com/api/v4/content/works"),
        endpoint: "library.works",
        allowedHosts: ["play.dlsite.com"],
        allowedPath: exactPath("/api/v4/content/works"),
        credentials: "none",
        body: { contentType: "application/json", text: "{}" },
      }),
    ).rejects.toBeInstanceOf(RateLimited)
    expect(post.calls).toHaveLength(1)

    const get = createFakeServer(() => new Response("", { status: 429 }))
    const getTransport = createTransport(get, createClock())
    await expect(
      getTransport.requestJson({
        method: "GET",
        url: salesUrl,
        endpoint: "test",
        allowedHosts: ["play.dlsite.com"],
        allowedPath: exactPath("/api/v4/content/sales"),
        credentials: "none",
      }),
    ).rejects.toBeInstanceOf(RateLimited)
    expect(get.calls).toHaveLength(2)
  })

  it("retries GET 503 once and then throws HttpError", async () => {
    const server = createFakeServer(() => new Response("", { status: 503 }))
    const transport = createTransport(server, createClock())
    await expect(
      transport.requestJson({
        method: "GET",
        url: salesUrl,
        endpoint: "test",
        allowedHosts: ["play.dlsite.com"],
        allowedPath: exactPath("/api/v4/content/sales"),
        credentials: "none",
      }),
    ).rejects.toBeInstanceOf(HttpError)
    expect(server.calls).toHaveLength(2)
  })

  it("distinguishes transaction timeout from caller cancellation", async () => {
    const hangingFetch = ((
      _input: string | URL | Request,
      init?: RequestInit,
    ) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Timed out", "TimeoutError")),
          { once: true },
        )
      })) as typeof globalThis.fetch
    const timeoutTransport = new Transport({
      fetch: hangingFetch,
      userAgent: "test",
      clock: createClock(),
      transactionTimeoutMs: 20,
      hostRateLimitMs: 1_000,
    })
    await expect(
      timeoutTransport.requestJson({
        method: "GET",
        url: salesUrl,
        endpoint: "test",
        allowedHosts: ["play.dlsite.com"],
        allowedPath: exactPath("/api/v4/content/sales"),
        credentials: "none",
      }),
    ).rejects.toMatchObject({ code: "TransportError", reason: "timeout" })

    const controller = new AbortController()
    controller.abort()
    const abortedTransport = createTransport(
      createFakeServer(() => jsonResponse([])),
      createClock(),
    )
    await expect(
      abortedTransport.requestJson({
        method: "GET",
        url: salesUrl,
        endpoint: "test",
        allowedHosts: ["play.dlsite.com"],
        allowedPath: exactPath("/api/v4/content/sales"),
        credentials: "none",
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(Aborted)
  })

  it("cancels the response body on an error status", async () => {
    let canceled = false
    const body = new ReadableStream({
      start() {
        // Keep the stream open.
      },
      cancel() {
        canceled = true
      },
    })
    const server = createFakeServer(() => new Response(body, { status: 400 }))
    const transport = createTransport(server, createClock())
    await expect(
      transport.requestJson({
        method: "GET",
        url: salesUrl,
        endpoint: "test",
        allowedHosts: ["play.dlsite.com"],
        allowedPath: exactPath("/api/v4/content/sales"),
        credentials: "none",
      }),
    ).rejects.toBeInstanceOf(HttpError)
    expect(canceled).toBe(true)
  })

  it("limits redirects and does not include response bodies in errors", async () => {
    const server = createFakeServer(
      () =>
        new Response("SECRET_RESPONSE_BODY", {
          status: 302,
          headers: { Location: "/api/v4/content/sales" },
        }),
    )
    const transport = createTransport(server, createClock())
    const error = await transport
      .requestJson({
        method: "GET",
        url: salesUrl,
        endpoint: "test",
        allowedHosts: ["play.dlsite.com"],
        allowedPath: exactPath("/api/v4/content/sales"),
        credentials: "none",
      })
      .catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      code: "UnexpectedResponse",
      diagnostic: "too_many_redirects",
    })
    expect(String(error)).not.toContain("SECRET_RESPONSE_BODY")
    expect(server.calls).toHaveLength(11)
  })
})
