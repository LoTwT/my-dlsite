import { describe, expect, it } from "vitest"
import {
  Aborted,
  AuthRequired,
  CoreError,
  createClient,
  UnexpectedResponse,
} from "../src/index.js"

describe("package entry", () => {
  it("exposes one client with the implemented modules and no internal surfaces", () => {
    const client = createClient({
      fetch: async () => {
        throw new Error("not used")
      },
    })
    expect(Object.keys(client).sort()).toEqual([
      "acquisition",
      "auth",
      "library",
      "manifest",
      "playback",
    ])
    expect("transport" in client).toBe(false)
    expect("access" in client).toBe(false)
    expect(typeof client.auth.importCookies).toBe("function")
    expect(typeof client.auth.restore).toBe("function")
    expect(typeof client.auth.export).toBe("function")
    expect(typeof client.auth.validate).toBe("function")
    expect(typeof client.acquisition.plan).toBe("function")
    expect(typeof client.library.list).toBe("function")
    expect(typeof client.manifest.get).toBe("function")
    expect(typeof client.playback.resolve).toBe("function")
  })

  it("exports public errors with safe messages", () => {
    const error = new UnexpectedResponse("library.works", "works_shape")
    expect(error).toBeInstanceOf(CoreError)
    expect(error.code).toBe("UnexpectedResponse")
    expect(error.message).not.toContain("FAKE_COOKIE")
    expect(new Aborted().code).toBe("Aborted")
    expect(new AuthRequired().code).toBe("AuthRequired")
  })
})
