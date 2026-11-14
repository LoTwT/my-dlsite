import { afterEach, describe, expect, it, vi } from "vitest"
import { createClientInternal } from "../src/client.js"
import { createClient } from "../src/index.js"
import type { ScopedCookie } from "../src/model.js"

const base = 1_700_000_000_000
const expiry = 1_700_000_120.123456
const otherExpiry = 1_700_000_240.654321
const precise: ScopedCookie = {
  name: "precise",
  value: "SYNTHETIC_PRECISE",
  domain: "dlsite.com",
  hostOnly: false,
  path: "/",
  secure: true,
  expires: expiry,
}
const other: ScopedCookie = {
  ...precise,
  name: "other",
  value: "SYNTHETIC_OTHER",
  expires: otherExpiry,
}
afterEach(() => {
  vi.restoreAllMocks()
})

describe("exact absolute cookie expiry", () => {
  it("preserves submillisecond seconds through import, export and a new public Client restore", async () => {
    vi.spyOn(Date, "now").mockReturnValue(base)
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json([]))
    const client = createClient({ fetch: fetchImpl })
    await client.auth.importCookies([precise, other])
    const snapshot = await client.auth.export()
    expect(snapshot.cookies.map((cookie) => cookie.expires)).toEqual([
      expiry,
      otherExpiry,
    ])
    const restored = createClient({ fetch: fetchImpl })
    await restored.auth.restore(snapshot)
    expect(await restored.auth.export()).toEqual(snapshot)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("uses the same exact deadline for ordinary sending, export and final plan headers", async () => {
    let now = base
    vi.spyOn(Date, "now").mockImplementation(() => now)
    const sent: string[] = []
    let finalRequests = 0
    const client = createClientInternal({
      now: () => now,
      hostRateLimitMs: 0,
      fetch: (async (input, init) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        )
        sent.push(new Headers(init?.headers).get("Cookie") ?? "")
        if (url.host === "download.dlsite.com") {
          finalRequests += 1
          throw new Error("final request forbidden")
        }
        if (url.pathname === "/api/v4/content/sales") return Response.json([])
        const location =
          url.host === "play.dlsite.com"
            ? "https://www.dlsite.com/home/download/=/product_id/RJ000001.html"
            : "https://download.dlsite.com/get/=/type/work/domain/doujin/dir/RJ000000/file/RJ000001.zip/_/20261016141106?update_date=2026-10-16"
        return new Response("", { status: 302, headers: { location } })
      }) as typeof fetch,
    })
    await client.auth.importCookies([precise, other])
    const floorMilliseconds = Math.floor(expiry * 1_000)
    now = floorMilliseconds + 0.25
    expect(now).toBeLessThan(expiry * 1_000)
    await client.auth.validate()
    expect(sent.at(-1)).toContain("precise=SYNTHETIC_PRECISE")
    expect((await client.auth.export()).cookies[0]?.expires).toBe(expiry)
    expect(
      (await client.acquisition.plan("RJ000001")).headers["Cookie"],
    ).toContain("precise=SYNTHETIC_PRECISE")

    now = floorMilliseconds + 0.75
    expect(now).toBeGreaterThan(expiry * 1_000)
    expect(
      (await client.auth.export()).cookies.map((cookie) => cookie.name),
    ).toEqual(["other"])
    await client.auth.validate()
    expect(sent.at(-1)).not.toContain("precise=")
    const plan = await client.acquisition.plan("RJ000001")
    expect(plan.headers["Cookie"]).not.toContain("precise=")
    expect(plan.headers["Cookie"]).toContain("other=SYNTHETIC_OTHER")
    expect(finalRequests).toBe(0)
  })

  it("replaces precision metadata on Max-Age, Expires, session overwrite and deletion without touching another cookie", async () => {
    let now = base
    vi.spyOn(Date, "now").mockImplementation(() => now)
    let nextCookie: string | undefined
    const sent: string[] = []
    const client = createClientInternal({
      now: () => now,
      hostRateLimitMs: 0,
      fetch: (async (_input, init) => {
        sent.push(new Headers(init?.headers).get("Cookie") ?? "")
        return Response.json([], {
          headers: nextCookie === undefined ? {} : { "set-cookie": nextCookie },
        })
      }) as typeof fetch,
    })
    await client.auth.importCookies([precise, other])
    nextCookie = "precise=MAX_AGE; Domain=dlsite.com; Path=/; Secure; Max-Age=5"
    await client.auth.validate()
    expect(
      (await client.auth.export()).cookies.find(
        (cookie) => cookie.name === "precise",
      )?.expires,
    ).toBe(base / 1_000 + 5)
    const replacementExpiry = base + 180_000
    nextCookie = `precise=EXPIRES; Domain=dlsite.com; Path=/; Secure; Expires=${new Date(replacementExpiry).toUTCString()}`
    await client.auth.validate()
    expect(
      (await client.auth.export()).cookies.find(
        (cookie) => cookie.name === "precise",
      )?.expires,
    ).toBe(replacementExpiry / 1_000)
    nextCookie = "precise=SESSION; Domain=dlsite.com; Path=/; Secure"
    await client.auth.validate()
    expect(
      (await client.auth.export()).cookies.find(
        (cookie) => cookie.name === "precise",
      )?.expires,
    ).toBeNull()
    now = base + 130_000
    nextCookie = "precise=; Domain=dlsite.com; Path=/; Secure; Max-Age=0"
    await client.auth.validate()
    expect(sent.at(-1)).toContain("precise=SESSION")
    expect((await client.auth.export()).cookies).toMatchObject([
      { name: "other", expires: otherExpiry },
    ])
    nextCookie = undefined
    await client.auth.validate()
    expect(sent.at(-1)).not.toContain("precise=")
    expect(sent.at(-1)).toContain("other=SYNTHETIC_OTHER")
  })
})
