import { BrowserLoginError } from "@my-dlsite/browser-auth"
import type { LoginStage } from "@my-dlsite/browser-auth"
import { AuthRequired, CoreError, InvalidInput } from "@my-dlsite/core"
import type { AuthApi, DlsiteClient } from "@my-dlsite/core"
import { SessionStoreError, withSessionStore } from "./session-store.js"

export type Command =
  | { name: "login"; browserProxy?: string }
  | { name: "library" }
  | { name: "plan"; workId: string }

export class CliError extends Error {
  readonly code: "usage" | "session-not-saved" | "snapshot-invalid"

  constructor(code: CliError["code"]) {
    super(
      code === "session-not-saved"
        ? "会话已建立但未保存，旧快照保留。"
        : code === "snapshot-invalid"
          ? "会话快照损坏或版本不受支持。"
          : "用法：my-dlsite login [--browser-proxy <server>] | library | plan <workId>",
    )
    this.name = "CliError"
    this.code = code
  }
}

export function parseCommand(args: readonly string[]): Command {
  if (args.length === 1 && args[0] === "login") return { name: "login" }
  if (args.length === 1 && args[0] === "library") return { name: "library" }
  if (
    args.length === 2 &&
    args[0] === "plan" &&
    /^[A-Z]{2}\d{4,12}$/.test(args[1] ?? "")
  )
    return { name: "plan", workId: args[1] as string }
  if (
    args.length === 3 &&
    args[0] === "login" &&
    args[1] === "--browser-proxy" &&
    args[2] !== undefined
  ) {
    try {
      const url = new URL(args[2])
      if (
        !["http:", "https:", "socks5:"].includes(url.protocol) ||
        url.hostname.length === 0 ||
        url.username.length > 0 ||
        url.password.length > 0 ||
        url.search.length > 0 ||
        url.hash.length > 0 ||
        (url.pathname !== "" && url.pathname !== "/")
      )
        throw new CliError("usage")
      return { name: "login", browserProxy: args[2] }
    } catch {
      throw new CliError("usage")
    }
  }
  throw new CliError("usage")
}

export interface CliDependencies {
  client: DlsiteClient
  directory: string
  login: (
    auth: AuthApi,
    options: {
      signal?: AbortSignal
      proxy?: { server: string }
      onStage?: (stage: LoginStage) => void
    },
  ) => Promise<void>
  write: (summary: Readonly<Record<string, unknown>>) => void
  onStage?: (stage: LoginStage) => void
  signal?: AbortSignal
}

export async function executeCommand(
  command: Command,
  dependencies: CliDependencies,
): Promise<void> {
  const { client, directory, signal, write } = dependencies
  await withSessionStore(directory, async (store) => {
    const previous = await store.read()
    let established = false
    if (previous !== null) {
      try {
        await client.auth.restore(previous, { signal })
        established = true
      } catch (error) {
        if (error instanceof InvalidInput)
          throw new CliError("snapshot-invalid")
        // An expired old session must not prevent starting a fresh login.
        if (!(command.name === "login" && error instanceof AuthRequired))
          throw error
      }
    }
    if (command.name === "login") {
      await dependencies.login(client.auth, {
        signal,
        onStage: dependencies.onStage,
        ...(command.browserProxy === undefined
          ? {}
          : { proxy: { server: command.browserProxy } }),
      })
      try {
        const current = await client.auth.export()
        if (current.cookies.length === 0)
          throw new CliError("session-not-saved")
        await store.save(current)
      } catch {
        throw new CliError("session-not-saved")
      }
      write({ outcome: "session-established", saved: true })
      return
    }
    if (!established) throw new AuthRequired()

    let operationError: unknown
    let failed = false
    let summary: Readonly<Record<string, unknown>> | undefined
    try {
      if (command.name === "library") {
        const library = await client.library.list({ signal })
        summary = {
          outcome: "library-complete",
          works: library.works.length,
          otherPurchases: library.otherPurchases.length,
          missingMetadata: library.missingMetadata.length,
          diagnostics: library.diagnostics.length,
        }
      } else {
        const plan = await client.acquisition.plan(command.workId, { signal })
        summary = {
          outcome: "plan-created",
          workId: command.workId,
          filenamePresent: plan.filename.length > 0,
          headersSufficiency: "NOT_TESTED",
          fileTransfer: "NOT_TESTED",
        }
      }
    } catch (error) {
      failed = true
      operationError = error
    }
    // Metadata failures can still rotate cookies. Preserve the established
    // current session unless Core explicitly invalidated it. Never write an
    // empty snapshot from a failed restore or an uncommitted login candidate.
    if (!(operationError instanceof AuthRequired)) {
      const current = await client.auth.export()
      if (current.cookies.length > 0) await store.save(current)
    }
    if (failed) throw operationError
    if (summary !== undefined) write(summary)
  })
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof CliError) return error.message
  if (error instanceof BrowserLoginError) return error.message
  if (error instanceof SessionStoreError)
    return `会话文件操作失败（${error.code}）。`
  if (error instanceof CoreError) {
    const allowed = new Set([
      "TransportError",
      "Aborted",
      "SessionChanged",
      "RateLimited",
      "HttpError",
      "UnexpectedResponse",
      "AuthRequired",
      "NotEntitled",
      "NotFound",
      "UnsupportedDelivery",
      "InvalidInput",
    ])
    if (allowed.has(error.code)) return `操作失败（${error.code}）。`
  }
  return "操作失败。未输出原始错误以保护会话凭据。"
}
