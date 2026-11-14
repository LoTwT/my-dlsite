import { describe, expect, it } from "vitest"
import { scopedCookiesFromChromium } from "../src/cookies.js"
import type { ChromiumCookie } from "../src/cookies.js"

export function chromiumCookie(
  overrides: Partial<ChromiumCookie> = {},
): ChromiumCookie {
  return {
    name: "synthetic",
    value: "SYNTHETIC_VALUE",
    domain: ".dlsite.com",
    path: "/",
    expires: -1,
    size: 25,
    httpOnly: true,
    secure: true,
    session: true,
    sameSite: "Lax",
    priority: "Medium",
    sourceScheme: "Secure",
    sourcePort: 443,
    ...overrides,
  }
}

describe("Chromium cookie projection", () => {
  it("retains scope, empty values, all paths and absolute expiry without reviving expired cookies", () => {
    const input = [
      chromiumCookie({ value: "" }),
      chromiumCookie({
        domain: "www.dlsite.com",
        path: "/account",
        session: false,
        expires: 100.75,
      }),
      chromiumCookie({ name: "expired", session: false, expires: 50 }),
      chromiumCookie({ domain: "unrelated.example" }),
    ]
    expect(scopedCookiesFromChromium(input, 60)).toEqual([
      {
        name: "synthetic",
        value: "",
        domain: "dlsite.com",
        path: "/",
        secure: true,
        hostOnly: false,
        httpOnly: true,
        sameSite: "Lax",
      },
      {
        name: "synthetic",
        value: "SYNTHETIC_VALUE",
        domain: "www.dlsite.com",
        path: "/account",
        secure: true,
        hostOnly: true,
        httpOnly: true,
        sameSite: "Lax",
        expires: 100.75,
      },
    ])
    expect(input[0]?.domain).toBe(".dlsite.com")
  })

  it.each([
    {
      partitionKey: {
        topLevelSite: "https://dlsite.com",
        hasCrossSiteAncestor: false,
      },
    },
    { partitionKeyOpaque: true },
    { sourceScheme: "NonSecure" as const },
    { sourcePort: 8443 },
    { expires: 0 },
    { session: false, expires: NaN },
    { session: false, expires: Number.MAX_VALUE },
    { name: "bad name" },
    { value: "SYNTHETIC;SECRET" },
    { path: "/bad;path" },
  ])("rejects unsupported semantics without exposing input", (overrides) => {
    let error: unknown
    try {
      scopedCookiesFromChromium([chromiumCookie(overrides)])
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({ code: "unsupported-cookie" })
    expect(String(error)).not.toContain("SYNTHETIC")
    expect(JSON.stringify(error)).not.toContain("SECRET")
  })

  it("rejects a host-only/domain collision instead of choosing or merging either record", () => {
    expect(() =>
      scopedCookiesFromChromium([
        chromiumCookie({ domain: "www.dlsite.com" }),
        chromiumCookie({
          domain: ".www.dlsite.com",
          session: false,
          expires: Date.now() / 1_000 + 600,
        }),
      ]),
    ).toThrow("unsupported-cookie")
  })
})
