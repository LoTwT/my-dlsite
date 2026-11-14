export type BrowserLoginFailure =
  | "invalid-options"
  | "browser-unavailable"
  | "browser-failed"
  | "browser-closed"
  | "browser-close-failed"
  | "canceled"
  | "timeout"
  | "unsupported-cookie"

export class BrowserLoginError extends Error {
  readonly code: BrowserLoginFailure

  constructor(code: BrowserLoginFailure) {
    super(
      code === "browser-unavailable"
        ? "Matching Chromium is missing. Run pnpm --filter @my-dlsite/browser-auth browser:install before login."
        : `Browser login failed (${code}).`,
    )
    this.name = "BrowserLoginError"
    this.code = code
  }
}
