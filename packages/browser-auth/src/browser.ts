import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { chromium } from "playwright"
import type { BrowserContext, Page } from "playwright"
import { readChromiumCookies, scopedCookiesFromChromium } from "./cookies.js"
import { BrowserLoginError } from "./errors.js"
import type { LoginBrowser } from "./transaction.js"
import { untilAborted } from "./transaction.js"

export interface BrowserProxy {
  server: string
  bypass?: string
  username?: string
  password?: string
}

export type ObserveLogin = (
  context: BrowserContext,
  page: Page,
  signal: AbortSignal,
) => Promise<void>

export async function openLoginBrowser(
  observer: ObserveLogin,
  proxy: BrowserProxy | undefined,
  signal: AbortSignal,
): Promise<LoginBrowser> {
  try {
    await access(chromium.executablePath(), constants.X_OK)
  } catch {
    throw new BrowserLoginError("browser-unavailable")
  }
  if (signal.aborted) throw new BrowserLoginError("canceled")
  const browser = await chromium.launch({
    headless: false,
    ...(proxy === undefined ? {} : { proxy }),
  })
  const closeOnAbort = () => {
    void browser.close().catch(() => {})
  }
  signal.addEventListener("abort", closeOnAbort, { once: true })
  let closing: Promise<void> | undefined
  const close = () => {
    signal.removeEventListener("abort", closeOnAbort)
    closing ??= browser.close().catch(() => {
      throw new BrowserLoginError("browser-close-failed")
    })
    return closing
  }
  try {
    if (signal.aborted) throw new BrowserLoginError("canceled")
    if (browser.version() !== "158.0.8127.18")
      throw new BrowserLoginError("browser-unavailable")
    const context = await browser.newContext({ acceptDownloads: false })
    const page = await context.newPage()
    return {
      close,
      async capture(captureSignal) {
        let disconnected: (() => void) | undefined
        const closed = new Promise<never>((_resolve, reject) => {
          disconnected = () => reject(new BrowserLoginError("browser-closed"))
          browser.once("disconnected", disconnected)
          page.once("close", disconnected)
        })
        try {
          await untilAborted(
            Promise.race([observer(context, page, captureSignal), closed]),
            captureSignal,
          )
          const browserSession = await browser.newBrowserCDPSession()
          const pageSession = await context.newCDPSession(page)
          return scopedCookiesFromChromium(
            await readChromiumCookies(
              pageSession,
              browserSession,
              captureSignal,
            ),
          )
        } finally {
          if (disconnected !== undefined) {
            browser.off("disconnected", disconnected)
            page.off("close", disconnected)
          }
        }
      },
    }
  } catch (error) {
    await untilAborted(close(), signal).catch(() => {})
    throw error instanceof BrowserLoginError
      ? error
      : new BrowserLoginError("browser-failed")
  }
}
