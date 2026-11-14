import { createClient } from "@my-dlsite/core"
import { chromium } from "playwright"
import { expect, it } from "vitest"
import { openLoginBrowser } from "../src/browser.js"
import {
  readChromiumCookies,
  scopedCookiesFromChromium,
} from "../src/cookies.js"
import { runLoginTransaction } from "../src/transaction.js"

it("reads real Chromium fields from only the dedicated context without network requests", async () => {
  const browser = await chromium.launch({ headless: false })
  try {
    const context = await browser.newContext({ serviceWorkers: "block" })
    let requests = 0
    await context.route("**/*", async (route) => {
      requests += 1
      await route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Synthetic login</title><p>Local synthetic page</p>",
      })
    })
    const page = await context.newPage()
    await page.goto("http://127.0.0.1/synthetic")
    const cdp = await context.newCDPSession(page)
    const browserCdp = await browser.newBrowserCDPSession()
    const expiry = Math.floor(Date.now() / 1_000) + 600.123456
    await cdp.send("Network.setCookies", {
      cookies: [
        {
          name: "synthetic_parent",
          value: "",
          domain: ".dlsite.com",
          path: "/",
          secure: true,
          httpOnly: true,
          sourceScheme: "Secure",
          sourcePort: 443,
        },
        {
          name: "synthetic_host",
          value: "SYNTHETIC",
          domain: "www.dlsite.com",
          path: "/account",
          secure: true,
          httpOnly: true,
          expires: expiry,
          sourceScheme: "Secure",
          sourcePort: 443,
        },
      ],
    })
    const raw = await readChromiumCookies(cdp, browserCdp)
    expect(raw).toHaveLength(2)
    expect(
      raw.find((cookie) => cookie.name === "synthetic_parent"),
    ).toMatchObject({
      domain: ".dlsite.com",
      expires: -1,
      session: true,
      sourceScheme: "Secure",
      sourcePort: 443,
    })
    const projected = scopedCookiesFromChromium(raw)
    expect(
      projected.find((cookie) => cookie.name === "synthetic_parent"),
    ).toMatchObject({ value: "", hostOnly: false })
    expect(
      projected.find((cookie) => cookie.name === "synthetic_host"),
    ).toMatchObject({
      domain: "www.dlsite.com",
      path: "/account",
      hostOnly: true,
      expires: expiry,
    })
    const fetchImpl = (async () => Response.json([])) as typeof fetch
    const client = createClient({ fetch: fetchImpl })
    await client.auth.importCookies(projected)
    const snapshot = await client.auth.export()
    expect(
      snapshot.cookies.find((cookie) => cookie.name === "synthetic_host")
        ?.expires,
    ).toBe(expiry)
    const restored = createClient({ fetch: fetchImpl })
    await restored.auth.restore(snapshot)
    expect(await restored.auth.export()).toEqual(snapshot)

    await cdp.send("Network.setCookies", {
      cookies: [
        {
          name: "synthetic_host",
          value: "OTHER",
          domain: ".www.dlsite.com",
          path: "/account",
          secure: true,
          sourceScheme: "Secure",
          sourcePort: 443,
        },
      ],
    })
    const colliding = await readChromiumCookies(cdp, browserCdp)
    expect(
      colliding.filter((cookie) => cookie.name === "synthetic_host"),
    ).toHaveLength(2)
    expect(() => scopedCookiesFromChromium(colliding)).toThrow(
      "unsupported-cookie",
    )
    const other = await browser.newContext()
    const otherPage = await other.newPage()
    expect(
      await readChromiumCookies(
        await other.newCDPSession(otherPage),
        browserCdp,
      ),
    ).toEqual([])
    expect(requests).toBe(1)
  } finally {
    await browser.close()
  }
}, 20_000)

it("runs the owned visible browser adapter through teardown and one real Core import", async () => {
  let browserClosed: (() => boolean) | undefined
  let requests = 0
  let probes = 0
  const client = createClient({
    fetch: (async () => {
      expect(browserClosed?.()).toBe(true)
      probes += 1
      return new Response("[]", {
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch,
  })
  await runLoginTransaction(
    client.auth,
    (signal) =>
      openLoginBrowser(
        async (context, page) => {
          browserClosed = () => context.browser()?.isConnected() === false
          await context.route("**/*", async (route) => {
            requests += 1
            await route.fulfill({ body: "Synthetic login" })
          })
          await page.goto("http://127.0.0.1/synthetic")
          const session = await context.newCDPSession(page)
          await session.send("Network.setCookies", {
            cookies: [
              {
                name: "synthetic",
                value: "SYNTHETIC",
                domain: "play.dlsite.com",
                path: "/",
                secure: true,
                httpOnly: true,
                sourceScheme: "Secure",
                sourcePort: 443,
              },
            ],
          })
        },
        undefined,
        signal,
      ),
    { timeoutMs: 10_000 },
  )
  expect(probes).toBe(1)
  expect(requests).toBe(1)
  expect((await client.auth.export()).cookies[0]?.value).toBe("SYNTHETIC")
}, 20_000)
