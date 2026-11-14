import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AuthRequired, createClient } from "@my-dlsite/core"
import type { AuthApi, ScopedCookie } from "@my-dlsite/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { executeCommand, parseCommand, safeErrorMessage } from "../src/app.js"
import { runCli } from "../src/cli.js"
import { withSessionStore } from "../src/session-store.js"

const directories: string[] = []
async function temporaryDirectory() {
  const directory = await mkdtemp(
    join(await realpath(tmpdir()), "my-dlsite-cli-test-"),
  )
  directories.push(directory)
  return directory
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})
const cookie: ScopedCookie = {
  name: "session",
  value: "SYNTHETIC_OLD_SECRET",
  domain: "play.dlsite.com",
  path: "/",
  secure: true,
  hostOnly: true,
}
const login = async (auth: AuthApi) =>
  auth.importCookies([{ ...cookie, value: "SYNTHETIC_NEW_SECRET" }])
function server() {
  const calls: string[] = []
  let fail: number | undefined
  let rotated = false
  const fetchImpl = (async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    calls.push(url.href)
    if (url.host === "download.dlsite.com")
      throw new Error("FINAL_FILE_REQUESTED")
    if (url.pathname === "/api/v4/content/sales") {
      if (fail !== undefined) rotated = true
      return new Response("[]", {
        headers: {
          "content-type": "application/json",
          ...(fail === undefined
            ? {}
            : {
                "set-cookie":
                  "session=SYNTHETIC_ROTATED_SECRET; Secure; HttpOnly; Path=/",
              }),
        },
      })
    }
    if (url.pathname === "/api/v4/content/count") {
      rotated = true
      return new Response(
        fail === undefined ? '{"user":0}' : "SYNTHETIC_RESPONSE_SECRET",
        {
          status: fail ?? 200,
          headers: {
            "content-type": "application/json",
            "set-cookie":
              "session=SYNTHETIC_ROTATED_SECRET; Secure; HttpOnly; Path=/",
          },
        },
      )
    }
    if (url.pathname === "/api/v3/download")
      return new Response("", {
        status: 302,
        headers: {
          location:
            "https://www.dlsite.com/home/download/=/product_id/RJ000001.html",
        },
      })
    if (url.host === "www.dlsite.com")
      return new Response("", {
        status: 302,
        headers: {
          location:
            "https://download.dlsite.com/get/=/type/work/domain/doujin/dir/RJ000000/file/RJ000001.zip/_/20261016141106?update_date=2026-10-16",
        },
      })
    throw new Error("UNEXPECTED_SYNTHETIC_REQUEST")
  }) as typeof fetch
  return {
    fetchImpl,
    calls,
    setFailure(value: number) {
      fail = value
    },
    rotated: () => rotated,
  }
}

describe("CLI session lifecycle", () => {
  it("assembles one public Core client for the command and emits a safe login summary", async () => {
    const directory = await temporaryDirectory()
    const fake = server()
    const stdout: string[] = []
    const stderr: string[] = []
    const code = await runCli(["login"], login, {
      directory,
      fetch: fake.fetchImpl,
      stdout: (line) => {
        stdout.push(line)
      },
      stderr: (line) => {
        stderr.push(line)
      },
    })
    expect(code).toBe(0)
    expect(fake.calls).toEqual(["https://play.dlsite.com/api/v4/content/sales"])
    expect(stdout).toEqual(['{"outcome":"session-established","saved":true}'])
    expect(stderr).toEqual([])
  })
  it("uses one Core client per process for login, complete empty library, plan and later restore with safe output", async () => {
    const directory = await temporaryDirectory()
    const fake = server()
    const summaries: Readonly<Record<string, unknown>>[] = []
    const write = (value: Readonly<Record<string, unknown>>) => {
      summaries.push(value)
    }
    const client = createClient({ fetch: fake.fetchImpl })
    await executeCommand({ name: "login" }, { client, directory, login, write })
    await executeCommand(
      { name: "library" },
      { client, directory, login, write },
    )
    await executeCommand(
      { name: "plan", workId: "RJ000001" },
      { client, directory, login, write },
    )
    const later = createClient({ fetch: fake.fetchImpl })
    await executeCommand(
      { name: "library" },
      { client: later, directory, login, write },
    )
    expect(summaries).toContainEqual({
      outcome: "library-complete",
      works: 0,
      otherPurchases: 0,
      missingMetadata: 0,
      diagnostics: 0,
    })
    expect(summaries).toContainEqual({
      outcome: "plan-created",
      workId: "RJ000001",
      filenamePresent: true,
      headersSufficiency: "NOT_TESTED",
      fileTransfer: "NOT_TESTED",
    })
    expect(JSON.stringify(summaries)).not.toContain("SECRET")
    expect(JSON.stringify(summaries)).not.toContain("download.dlsite.com")
    expect(
      fake.calls.filter((url) => new URL(url).host === "download.dlsite.com"),
    ).toHaveLength(0)
    expect((await later.auth.export()).cookies[0]?.value).toBe(
      "SYNTHETIC_ROTATED_SECRET",
    )
  }, 15_000)

  it("preserves old file bytes and memory when a login candidate fails", async () => {
    const directory = await temporaryDirectory()
    const fake = server()
    const client = createClient({ fetch: fake.fetchImpl })
    await client.auth.importCookies([cookie])
    await withSessionStore(directory, async (store) =>
      store.save(await client.auth.export()),
    )
    const before = await readFile(join(directory, "session.json"), "utf8")
    await expect(
      executeCommand(
        { name: "login" },
        {
          client,
          directory,
          login: async () => {
            throw new AuthRequired()
          },
          write: () => {},
        },
      ),
    ).rejects.toBeInstanceOf(AuthRequired)
    expect(await readFile(join(directory, "session.json"), "utf8")).toBe(before)
    expect((await client.auth.export()).cookies[0]?.value).toBe(
      "SYNTHETIC_OLD_SECRET",
    )
  }, 10_000)

  it("reports established but not saved and retains old file if export fails after commit", async () => {
    const directory = await temporaryDirectory()
    const client = createClient({ fetch: server().fetchImpl })
    await client.auth.importCookies([cookie])
    await withSessionStore(directory, async (store) =>
      store.save(await client.auth.export()),
    )
    const before = await readFile(join(directory, "session.json"), "utf8")
    const write = vi.fn<(summary: Readonly<Record<string, unknown>>) => void>()
    await expect(
      executeCommand(
        { name: "login" },
        {
          client,
          directory,
          write,
          login: async (auth) => {
            await auth.importCookies([
              { ...cookie, value: "SYNTHETIC_COMMITTED" },
            ])
            vi.spyOn(auth, "export").mockRejectedValueOnce(
              new Error("EXPORT_SECRET"),
            )
          },
        },
      ),
    ).rejects.toMatchObject({ code: "session-not-saved" })
    expect(await readFile(join(directory, "session.json"), "utf8")).toBe(before)
    expect((await client.auth.export()).cookies[0]?.value).toBe(
      "SYNTHETIC_COMMITTED",
    )
    expect(write).not.toHaveBeenCalled()
  }, 10_000)

  it.each([403, 401])(
    "handles rotated cookies on business HTTP %i without writing invalid or empty state",
    async (status) => {
      const directory = await temporaryDirectory()
      const fake = server()
      const client = createClient({ fetch: fake.fetchImpl })
      await executeCommand(
        { name: "login" },
        { client, directory, login, write: () => {} },
      )
      const before = await readFile(join(directory, "session.json"), "utf8")
      fake.setFailure(status)
      await expect(
        executeCommand(
          { name: "library" },
          { client, directory, login, write: () => {} },
        ),
      ).rejects.toBeInstanceOf(Error)
      const after = await readFile(join(directory, "session.json"), "utf8")
      expect(fake.rotated()).toBe(true)
      expect(JSON.parse(after).cookies[0].value).toBe(
        status === 401 ? "SYNTHETIC_NEW_SECRET" : "SYNTHETIC_ROTATED_SECRET",
      )
      expect(status === 401 && before !== after).toBe(false)
    },
    10_000,
  )

  it("rejects damaged Core snapshot fields before opening a browser and preserves the file", async () => {
    const directory = await temporaryDirectory()
    const bytes = JSON.stringify({
      version: 1,
      cookies: [{ value: "CORRUPT_SECRET" }],
    })
    await writeFile(join(directory, "session.json"), bytes, { mode: 0o600 })
    const opened = vi.fn<typeof login>(login)
    const fake = server()
    await expect(
      executeCommand(
        { name: "login" },
        {
          client: createClient({ fetch: fake.fetchImpl }),
          directory,
          login: opened,
          write: () => {},
        },
      ),
    ).rejects.toMatchObject({ code: "snapshot-invalid" })
    expect(opened).not.toHaveBeenCalled()
    expect(fake.calls).toHaveLength(0)
    expect(await readFile(join(directory, "session.json"), "utf8")).toBe(bytes)
  })

  it("rejects unknown CLI options and keeps raw errors and argument credentials out of output", () => {
    for (const args of [
      ["plan", "https://SECRET"],
      ["login", "--browser-proxy", "http://user:SECRET@localhost:8888"],
      ["plan", "RJ000001", "--export"],
    ]) {
      let error: unknown
      try {
        parseCommand(args)
      } catch (caught) {
        error = caught
      }
      expect(error).toMatchObject({ code: "usage" })
      expect(safeErrorMessage(error)).not.toContain("SECRET")
    }
    expect(safeErrorMessage(new Error("SYNTHETIC_SECRET"))).not.toContain(
      "SECRET",
    )
  })
})
