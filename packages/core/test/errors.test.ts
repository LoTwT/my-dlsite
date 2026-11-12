import { describe, expect, it } from "vitest"
import {
  GrantExpired,
  NotEntitled,
  NotFound,
  StaleManifest,
  UnsupportedDelivery,
} from "../src/errors.js"

const unverifiedWorkId = "https://example.test/callback?token=SYNTHETIC_TOKEN"
const canonicalWorkId = "RJ123456"

function workIdErrors(workId: string) {
  return [
    new StaleManifest(workId, "unknown"),
    new GrantExpired(workId),
    new UnsupportedDelivery("test", workId),
    new NotEntitled(workId),
    new NotFound(workId),
  ]
}

describe("error work ID context", () => {
  it("does not retain an unverified work ID", () => {
    for (const error of workIdErrors(unverifiedWorkId)) {
      expect(String(error)).not.toContain("SYNTHETIC_TOKEN")
      expect(JSON.stringify(error)).not.toContain("SYNTHETIC_TOKEN")
      expect(JSON.stringify(error)).not.toContain("example.test")
    }
    expect(new StaleManifest(unverifiedWorkId, "unknown").workId).toBe(
      "[redacted]",
    )
    expect(new GrantExpired(unverifiedWorkId).workId).toBe("[redacted]")
    expect(
      new UnsupportedDelivery("test", unverifiedWorkId).workId,
    ).toBeUndefined()
    expect(new NotEntitled(unverifiedWorkId).workId).toBeUndefined()
    expect(new NotFound(unverifiedWorkId).workId).toBeUndefined()
  })

  it("keeps a canonical work ID available to callers", () => {
    for (const error of workIdErrors(canonicalWorkId)) {
      expect(JSON.parse(JSON.stringify(error))).toMatchObject({
        workId: canonicalWorkId,
      })
    }
  })
})
