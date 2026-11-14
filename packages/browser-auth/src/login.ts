import type { AuthApi } from "@my-dlsite/core"
import { openLoginBrowser } from "./browser.js"
import type { BrowserProxy } from "./browser.js"
import { BrowserLoginError } from "./errors.js"
import { observePlayLogin } from "./observe.js"
import { runLoginTransaction } from "./transaction.js"
import type { TransactionOptions } from "./transaction.js"

export interface BrowserLoginOptions extends TransactionOptions {
  proxy?: BrowserProxy
}

function validateProxy(proxy: BrowserProxy | undefined): void {
  if (proxy === undefined) return
  try {
    const url = new URL(proxy.server)
    if (
      !["http:", "https:", "socks5:"].includes(url.protocol) ||
      url.hostname === "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      (url.pathname !== "" && url.pathname !== "/") ||
      [proxy.bypass, proxy.username, proxy.password].some(
        (value) =>
          value !== undefined &&
          (typeof value !== "string" ||
            value.includes("\n") ||
            value.includes("\r")),
      )
    )
      throw new BrowserLoginError("invalid-options")
  } catch {
    throw new BrowserLoginError("invalid-options")
  }
}

export async function loginWithBrowser(
  auth: AuthApi,
  options: BrowserLoginOptions = {},
): Promise<void> {
  validateProxy(options.proxy)
  await runLoginTransaction(
    auth,
    (signal) => openLoginBrowser(observePlayLogin, options.proxy, signal),
    options,
  )
}
