import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loginWithBrowser } from "@my-dlsite/browser-auth"
import { createClient } from "@my-dlsite/core"
import { afterEach, expect, it, vi } from "vitest"
import { runCli } from "../src/cli.js"

// Only the browser boundary is synthetic. Both consumers below use the real
// public login, Core client, library reader and acquisition implementation.
const browserState = vi.hoisted(() => ({ closed: false, opens: 0 }))
vi.mock("../../browser-auth/dist/browser.js", () => ({
  openLoginBrowser: async () => {
    browserState.closed = false
    browserState.opens += 1
    return {
      capture: async () => [
        {
          name: "session",
          value: "SYNTHETIC_PUBLIC_SECRET",
          domain: "dlsite.com",
          path: "/",
          secure: true,
          hostOnly: false,
        },
      ],
      close: async () => {
        browserState.closed = true
      },
    }
  },
}))

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

function syntheticService() {
  let finalCalls = 0
  let authorizeCalls = 0
  let candidateProbes = 0
  const probeAfterClose: boolean[] = []
  const worksBodies: unknown[] = []
  const fetchImpl = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.host === "download.dlsite.com") {
      finalCalls += 1
      throw new Error("final request forbidden")
    }
    if (url.pathname === "/api/authorize") {
      authorizeCalls += 1
      throw new Error("active authorize forbidden")
    }
    if (url.pathname === "/api/v4/content/sales") {
      probeAfterClose.push(browserState.closed)
      if (!url.searchParams.has("last")) candidateProbes += 1
      return Response.json([{ workno: "RJ000001", sales_date: "2026-11-14" }])
    }
    if (url.pathname === "/api/v4/content/count")
      return Response.json({ user: 1 })
    if (url.pathname === "/api/v4/content/works") {
      worksBodies.push(
        typeof init?.body === "string" ? JSON.parse(init.body) : null,
      )
      return Response.json({
        works: [
          {
            workno: "RJ000001",
            work_type: "SOU",
            name: { ja_JP: "Synthetic work" },
          },
        ],
      })
    }
    if (url.pathname === "/api/v3/download")
      return new Response("", {
        status: 302,
        headers: {
          "location":
            "https://www.dlsite.com/home/download/=/product_id/RJ000001.html",
          "set-cookie":
            "rotated=SYNTHETIC_ROTATION_SECRET; Domain=dlsite.com; Path=/; Secure",
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
    throw new Error("unexpected synthetic request")
  }) as typeof fetch
  return {
    fetchImpl,
    finalCalls: () => finalCalls,
    authorizeCalls: () => authorizeCalls,
    candidateProbes: () => candidateProbes,
    probeAfterClose,
    worksBodies,
  }
}

it("connects a Node consumer through the public login, library, full plan and snapshot restore", async () => {
  const service = syntheticService()
  const client = createClient({ fetch: service.fetchImpl })
  const openedBefore = browserState.opens
  await expect(loginWithBrowser(client.auth)).resolves.toBeUndefined()
  const library = await client.library.list()
  expect(library.works[0]?.purchase.workId).toBe("RJ000001")
  const plan = await client.acquisition.plan("RJ000001")
  expect(plan.filename).toBe("RJ000001.zip")
  expect(plan.headers["Cookie"]).toContain("SYNTHETIC_ROTATION_SECRET")
  expect(plan.url).toContain("download.dlsite.com")
  const snapshot = await client.auth.export()
  await client.auth.restore(snapshot)
  expect((await client.auth.export()).cookies).toEqual(snapshot.cookies)
  expect(browserState.opens - openedBefore).toBe(1)
  expect(service.candidateProbes()).toBe(2)
  expect(service.authorizeCalls()).toBe(0)
  expect(service.finalCalls()).toBe(0)
  expect(service.probeAfterClose.every(Boolean)).toBe(true)
  expect(service.worksBodies).toEqual([{ worknos: ["RJ000001"] }])
}, 15_000)

it("connects CLI commands to that same public login and restores the file in later invocations", async () => {
  const directory = await mkdtemp(
    join(await realpath(tmpdir()), "my-dlsite-public-cli-test-"),
  )
  directories.push(directory)
  const service = syntheticService()
  const stdout: string[] = []
  const stderr: string[] = []
  const options = {
    directory,
    fetch: service.fetchImpl,
    stdout: (line: string) => {
      stdout.push(line)
    },
    stderr: (line: string) => {
      stderr.push(line)
    },
  }
  const openedBefore = browserState.opens
  expect(await runCli(["login"], loginWithBrowser, options)).toBe(0)
  expect(await runCli(["library"], loginWithBrowser, options)).toBe(0)
  expect(await runCli(["plan", "RJ000001"], loginWithBrowser, options)).toBe(0)
  expect(await runCli(["library"], loginWithBrowser, options)).toBe(0)
  expect(stdout.map((line) => JSON.parse(line).outcome)).toEqual([
    "session-established",
    "library-complete",
    "plan-created",
    "library-complete",
  ])
  expect(browserState.opens - openedBefore).toBe(1)
  expect(service.candidateProbes()).toBe(4)
  expect(service.authorizeCalls()).toBe(0)
  expect(service.finalCalls()).toBe(0)
  expect(service.probeAfterClose.every(Boolean)).toBe(true)
  expect(service.worksBodies).toEqual([
    { worknos: ["RJ000001"] },
    { worknos: ["RJ000001"] },
  ])
  expect([...stdout, ...stderr].join("\n")).not.toMatch(
    /SECRET|download\.dlsite\.com|Cookie|\.zip/,
  )
}, 20_000)
