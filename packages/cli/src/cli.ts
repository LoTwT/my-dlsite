import type { LoginStage } from "@my-dlsite/browser-auth"
import { createClient } from "@my-dlsite/core"
import { executeCommand, parseCommand, safeErrorMessage } from "./app.js"
import type { CliDependencies } from "./app.js"
import { defaultSessionDirectory } from "./session-store.js"

const STAGE_MESSAGES: Record<LoginStage, string> = {
  "opening-browser": "正在打开专用浏览器。",
  "waiting-for-user":
    "请在浏览器中亲自完成登录、验证码或二步验证；Ctrl+C 可取消。",
  "capture-ready": "浏览器捕获已就绪。",
  "closing-browser": "正在关闭专用浏览器。",
  "checking-session": "正在探测 Core sales 会话。",
  "session-established": "Core sales 会话探测成功。",
}

export interface CliRuntimeOptions {
  directory?: string
  fetch?: typeof fetch
  signal?: AbortSignal
  stdout?: (line: string) => void
  stderr?: (line: string) => void
}

export async function runCli(
  args: readonly string[],
  login: CliDependencies["login"],
  options: CliRuntimeOptions = {},
): Promise<number> {
  const stdout =
    options.stdout ??
    ((line: string) => {
      process.stdout.write(`${line}\n`)
    })
  const stderr =
    options.stderr ??
    ((line: string) => {
      process.stderr.write(`${line}\n`)
    })
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    stdout(
      "my-dlsite login [--browser-proxy <server>] | library | plan <workId>",
    )
    return 0
  }
  try {
    const command = parseCommand(args)
    const client = createClient({ fetch: options.fetch })
    await executeCommand(command, {
      client,
      directory: options.directory ?? defaultSessionDirectory(),
      login,
      signal: options.signal,
      write: (summary) => stdout(JSON.stringify(summary)),
      onStage: (stage) => stderr(STAGE_MESSAGES[stage]),
    })
    return 0
  } catch (error) {
    stderr(safeErrorMessage(error))
    return 1
  }
}
