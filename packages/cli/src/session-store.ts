import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, parse, resolve } from "node:path"
import type { SessionSnapshot } from "@my-dlsite/core"

export type StoreFailure =
  | "unsafe-path"
  | "busy"
  | "read"
  | "invalid-snapshot"
  | "save"
  | "unlock"

export class SessionStoreError extends Error {
  readonly code: StoreFailure

  constructor(code: StoreFailure) {
    super(`Session storage failed (${code}).`)
    this.name = "SessionStoreError"
    this.code = code
  }
}

export function defaultSessionDirectory(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "my-dlsite")
  }
  if (process.platform !== "linux") throw new SessionStoreError("unsafe-path")
  const dataHome = process.env["XDG_DATA_HOME"]
  if (dataHome !== undefined && !isAbsolute(dataHome)) {
    throw new SessionStoreError("unsafe-path")
  }
  return join(dataHome ?? join(homedir(), ".local", "share"), "my-dlsite")
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

async function ensureDirectory(directory: string): Promise<void> {
  const absolute = resolve(directory)
  const root = parse(absolute).root
  let current = root
  for (const component of absolute.slice(root.length).split("/")) {
    if (component.length === 0) continue
    current = join(current, component)
    try {
      await mkdir(current, { mode: 0o700 })
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      ) {
        throw new SessionStoreError("unsafe-path")
      }
    }
    const stat = await lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new SessionStoreError("unsafe-path")
    if (
      current === absolute &&
      (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700)
    ) {
      throw new SessionStoreError("unsafe-path")
    }
  }
}

async function checkFile(path: string): Promise<void> {
  const stat = await lstat(path)
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o600
  ) {
    throw new SessionStoreError("unsafe-path")
  }
}

async function checkOptionalFile(path: string): Promise<void> {
  try {
    await checkFile(path)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
}

export interface LockedSessionStore {
  read(): Promise<SessionSnapshot | null>
  save(snapshot: SessionSnapshot): Promise<void>
}

// One lock covers restore, operation and save. A crashed process leaves the
// lock for explicit operator recovery; guessing that it is stale risks losing
// a more recent session written by another process.
export async function withSessionStore<T>(
  directory: string,
  run: (store: LockedSessionStore) => Promise<T>,
): Promise<T> {
  await ensureDirectory(directory)
  const file = join(directory, "session.json")
  const lockPath = join(directory, "session.lock")
  let lock: FileHandle
  try {
    lock = await open(
      lockPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    )
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new SessionStoreError("busy")
    }
    throw new SessionStoreError("unsafe-path")
  }

  let failed = false
  let operationError: unknown
  let unlockFailed = false
  let result: T | undefined
  try {
    await checkOptionalFile(file)
    result = await run({
      async read() {
        let handle: FileHandle | undefined
        try {
          await checkFile(file)
          handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
          const stat = await handle.stat()
          if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            stat.uid !== process.getuid?.() ||
            (stat.mode & 0o777) !== 0o600
          ) {
            throw new SessionStoreError("unsafe-path")
          }
          const value: unknown = JSON.parse(await handle.readFile("utf8"))
          // Core owns the full versioned schema and validates it before any
          // network request in restore(). Keep malformed data explicit here.
          if (
            typeof value !== "object" ||
            value === null ||
            !("version" in value) ||
            value.version !== 1 ||
            !("cookies" in value) ||
            !Array.isArray(value.cookies)
          ) {
            throw new SessionStoreError("invalid-snapshot")
          }
          return value as SessionSnapshot
        } catch (error) {
          if (isMissing(error)) return null
          if (error instanceof SessionStoreError) throw error
          throw new SessionStoreError(
            error instanceof SyntaxError ? "invalid-snapshot" : "read",
          )
        } finally {
          await handle?.close()
        }
      },
      async save(snapshot) {
        const temporary = join(dirname(file), `.session-${randomUUID()}.tmp`)
        let handle: FileHandle | undefined
        let replaced = false
        try {
          handle = await open(
            temporary,
            constants.O_CREAT |
              constants.O_EXCL |
              constants.O_WRONLY |
              constants.O_NOFOLLOW,
            0o600,
          )
          await handle.writeFile(JSON.stringify(snapshot), "utf8")
          await handle.sync()
          await handle.close()
          handle = undefined
          await checkOptionalFile(file)
          await rename(temporary, file)
          replaced = true
        } catch (error) {
          if (error instanceof SessionStoreError) throw error
          throw new SessionStoreError("save")
        } finally {
          await handle?.close().catch(() => {})
          if (!replaced) await unlink(temporary).catch(() => {})
        }
      },
    })
  } catch (error) {
    failed = true
    operationError = error
  } finally {
    try {
      await lock.close()
      await unlink(lockPath)
    } catch {
      unlockFailed = true
    }
  }
  if (failed) throw operationError
  if (unlockFailed) throw new SessionStoreError("unlock")
  return result as T
}
