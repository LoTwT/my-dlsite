import { createClient } from "@my-dlsite/core"
import { chromium } from "playwright"
import { afterEach, expect, it, vi } from "vitest"
import { loginWithBrowser } from "../src/index.js"

afterEach(() => {
  vi.restoreAllMocks()
})

it("rejects invalid deadlines, proxy credentials in URLs and pre-cancellation before opening a browser", async () => {
  const launch = vi.spyOn(chromium, "launch")
  const fetchImpl = vi.fn<typeof fetch>()
  const client = createClient({ fetch: fetchImpl })
  await expect(
    loginWithBrowser(client.auth, { timeoutMs: Infinity }),
  ).rejects.toMatchObject({ code: "invalid-options" })
  await expect(
    loginWithBrowser(client.auth, {
      proxy: { server: "http://user:SYNTHETIC_PROXY_SECRET@localhost:8888" },
    }),
  ).rejects.toMatchObject({ code: "invalid-options" })
  await expect(
    loginWithBrowser(client.auth, { signal: AbortSignal.abort() }),
  ).rejects.toMatchObject({ code: "canceled" })
  expect(launch).not.toHaveBeenCalled()
  expect(fetchImpl).not.toHaveBeenCalled()
})

it("gives preparation instructions for a missing matching browser before any login activity", async () => {
  vi.spyOn(chromium, "executablePath").mockReturnValue(
    "/my-dlsite-test-missing-chromium",
  )
  const launch = vi.spyOn(chromium, "launch")
  const client = createClient()
  await expect(loginWithBrowser(client.auth)).rejects.toMatchObject({
    code: "browser-unavailable",
    message: expect.stringContaining("browser:install"),
  })
  expect(launch).not.toHaveBeenCalled()
})
