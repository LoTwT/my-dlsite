import type { AuthApi, ScopedCookie } from "@my-dlsite/core"
import { BrowserLoginError } from "./errors.js"

export type LoginStage =
  | "opening-browser"
  | "waiting-for-user"
  | "capture-ready"
  | "closing-browser"
  | "checking-session"
  | "session-established"

export interface TransactionOptions {
  signal?: AbortSignal
  timeoutMs?: number
  onStage?: (stage: LoginStage) => void
}

export interface LoginBrowser {
  capture(signal: AbortSignal): Promise<readonly ScopedCookie[]>
  close(): Promise<void>
}

export type OpenLoginBrowser = (signal: AbortSignal) => Promise<LoginBrowser>

export async function untilAborted<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => {})
    throw new BrowserLoginError("canceled")
  }
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new BrowserLoginError("canceled"))
    signal.addEventListener("abort", aborted, { once: true })
    void work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", aborted))
  })
}

// Internal adapter boundary: the real observer and synthetic tests execute
// the same transaction. Browser teardown must finish before Core is touched.
export async function runLoginTransaction(
  auth: AuthApi,
  openBrowser: OpenLoginBrowser,
  options: TransactionOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 600_000
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 2_147_483_647
  ) {
    throw new BrowserLoginError("invalid-options")
  }
  const timeout = new AbortController()
  const signal = AbortSignal.any([
    timeout.signal,
    ...(options.signal === undefined ? [] : [options.signal]),
  ])
  const timer = setTimeout(() => timeout.abort(), timeoutMs)
  let browser: LoginBrowser | undefined
  let closed = false
  let importing = false
  const interrupted = () =>
    new BrowserLoginError(
      options.signal?.aborted === true ? "canceled" : "timeout",
    )
  const check = () => {
    if (signal.aborted) throw interrupted()
  }
  const stage = (value: LoginStage) => {
    // Status observers cannot alter the transaction or turn a committed
    // session into failure. In particular they never receive credential data.
    try {
      options.onStage?.(value)
    } catch {
      /* observational callback */
    }
  }

  try {
    check()
    stage("opening-browser")
    const opening = openBrowser(signal)
    void opening.then(
      (lateBrowser) => {
        if (signal.aborted) void lateBrowser.close().catch(() => {})
      },
      () => {},
    )
    browser = await untilAborted(opening, signal)
    check()
    stage("waiting-for-user")
    const cookies = await untilAborted(browser.capture(signal), signal)
    check()
    stage("capture-ready")
    stage("closing-browser")
    await untilAborted(browser.close(), signal)
    closed = true
    check()
    stage("checking-session")
    importing = true
    // Core owns the candidate probe and queue cancellation. Racing its return
    // against abort could report failure after it already committed a session.
    await auth.importCookies(cookies, { signal })
    // Successful import is the commit point. Do not recheck cancellation,
    // close, validate, restore, or export after it.
    stage("session-established")
  } catch (error) {
    if (signal.aborted) throw interrupted()
    if (importing || error instanceof BrowserLoginError) throw error
    throw new BrowserLoginError("browser-failed")
  } finally {
    try {
      if (browser !== undefined && !closed) {
        // On interruption initiate cleanup without extending the total deadline.
        // Adapters close their owned process; never touch a user's browser.
        await untilAborted(browser.close(), signal).catch(() => {})
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
