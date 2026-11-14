import { AuthRequired, createClient } from "@my-dlsite/core"
import type { ScopedCookie } from "@my-dlsite/core"
import { describe, expect, it, vi } from "vitest"
import { runLoginTransaction } from "../src/transaction.js"
import type { LoginBrowser, LoginStage } from "../src/transaction.js"

const candidate: ScopedCookie = {
  name: "session",
  value: "SYNTHETIC_NEW",
  domain: "play.dlsite.com",
  path: "/",
  secure: true,
  hostOnly: true,
}

function harness(rejectCandidate = false) {
  const seen: string[] = []
  const client = createClient({
    fetch: (async (_url, init) => {
      const sent = new Headers(init?.headers).get("cookie") ?? ""
      seen.push(sent)
      if (rejectCandidate && sent.includes("SYNTHETIC_NEW"))
        return new Response("", { status: 401 })
      return new Response("[]", {
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch,
  })
  const close = vi.fn<() => Promise<void>>(async () => {})
  const browser: LoginBrowser = { close, capture: async () => [candidate] }
  return { client, seen, close, browser }
}

describe("login transaction", () => {
  it("keeps the deadline active while cleaning up a failed capture", async () => {
    const { client } = harness()
    const neverCloses: LoginBrowser = {
      capture: async () => {
        throw new Error("CAPTURE_SECRET")
      },
      close: () => new Promise(() => {}),
    }
    const imported = vi.spyOn(client.auth, "importCookies")
    await expect(
      runLoginTransaction(client.auth, async () => neverCloses, {
        timeoutMs: 10,
      }),
    ).rejects.toMatchObject({ code: "browser-failed" })
    expect(imported).not.toHaveBeenCalled()
  })
  it("closes the browser before exactly one import and never validates or exports afterward", async () => {
    const { client, browser, close, seen } = harness()
    const order: string[] = []
    close.mockImplementation(async () => {
      order.push("close")
    })
    const original = client.auth.importCookies.bind(client.auth)
    const imported = vi
      .spyOn(client.auth, "importCookies")
      .mockImplementation(async (...args) => {
        order.push("import")
        await original(...args)
      })
    const exported = vi.spyOn(client.auth, "export")
    const validated = vi.spyOn(client.auth, "validate")
    const stages: LoginStage[] = []
    const controller = new AbortController()
    await expect(
      runLoginTransaction(client.auth, async () => browser, {
        signal: controller.signal,
        onStage(stage) {
          stages.push(stage)
          if (stage === "session-established") {
            controller.abort()
            throw new Error("CALLBACK_SECRET")
          }
        },
      }),
    ).resolves.toBeUndefined()
    expect(order).toEqual(["close", "import"])
    expect(imported).toHaveBeenCalledTimes(1)
    expect(validated).not.toHaveBeenCalled()
    expect(exported).not.toHaveBeenCalled()
    expect(stages).toContain("capture-ready")
    expect(stages.at(-1)).toBe("session-established")
    expect(seen).toEqual(["session=SYNTHETIC_NEW"])
  })

  it.each([
    "canceled",
    "timeout",
    "browser-closed",
    "browser-close-failed",
  ] as const)(
    "preserves old Core state on %s before commit",
    async (failure) => {
      const { client, browser, close } = harness()
      await client.auth.importCookies([
        { ...candidate, value: "SYNTHETIC_OLD" },
      ])
      const previous = await client.auth.export()
      const imported = vi.spyOn(client.auth, "importCookies")
      const controller = new AbortController()
      browser.capture = async (signal) => {
        if (failure === "canceled") controller.abort()
        if (failure === "timeout" || failure === "canceled") {
          return new Promise((_resolve, reject) =>
            signal.addEventListener(
              "abort",
              () => reject(new Error("ABORT_SECRET")),
              { once: true },
            ),
          )
        }
        if (failure === "browser-closed") throw new Error("CLOSED_SECRET")
        return [candidate]
      }
      if (failure === "browser-close-failed")
        close.mockRejectedValue(new Error("CLOSE_SECRET"))
      await expect(
        runLoginTransaction(client.auth, async () => browser, {
          timeoutMs: 20,
          signal: controller.signal,
        }),
      ).rejects.toBeInstanceOf(Error)
      expect(imported).not.toHaveBeenCalled()
      expect(await client.auth.export()).toEqual(previous)
      expect(close).toHaveBeenCalled()
    },
  )

  it("keeps the old session if the single Core candidate probe rejects", async () => {
    const { client, browser } = harness(true)
    await client.auth.importCookies([{ ...candidate, value: "SYNTHETIC_OLD" }])
    const previous = await client.auth.export()
    const imported = vi.spyOn(client.auth, "importCookies")
    await expect(
      runLoginTransaction(client.auth, async () => browser),
    ).rejects.toBeInstanceOf(AuthRequired)
    expect(imported).toHaveBeenCalledOnce()
    expect(await client.auth.export()).toEqual(previous)
  })

  it("bounds uncooperative capture and closes a browser that opens after cancellation", async () => {
    const { client, browser, close } = harness()
    browser.capture = () => new Promise(() => {})
    await expect(
      runLoginTransaction(client.auth, async () => browser, { timeoutMs: 10 }),
    ).rejects.toMatchObject({ code: "timeout" })
    expect(close).toHaveBeenCalled()
    close.mockClear()
    let resolveOpen: (browser: LoginBrowser) => void = () => {}
    const opening = new Promise<LoginBrowser>((resolve) => {
      resolveOpen = resolve
    })
    await expect(
      runLoginTransaction(client.auth, () => opening, { timeoutMs: 10 }),
    ).rejects.toMatchObject({ code: "timeout" })
    resolveOpen(browser)
    await Promise.resolve()
    expect(close).toHaveBeenCalledOnce()
  })
})
