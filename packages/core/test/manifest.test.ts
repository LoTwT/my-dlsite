import { describe, expect, it } from "vitest"
import { HttpError, UnexpectedResponse } from "../src/errors.js"
import { createHarness } from "./client-helpers.js"
import {
  jsonResponse,
  manifestFixture,
  playSessionCookie,
  salesResponse,
  signResponse,
} from "./helpers.js"

const workId = "RJ123456"

interface ManifestHandlerOptions {
  manifest?: unknown
  failManifest?: (call: number) => Response | null
}

function manifestHandler(options: ManifestHandlerOptions = {}) {
  let signCalls = 0
  let manifestCalls = 0
  return (url: URL) => {
    if (url.pathname === "/api/v4/content/sales")
      return jsonResponse(salesResponse([]))
    if (url.pathname === "/api/v4/download/sign/url") {
      signCalls += 1
      return jsonResponse(
        signResponse(workId, Math.floor(Date.now() / 1_000) + 3_600),
      )
    }
    if (url.pathname.endsWith("/ziptree.json")) {
      manifestCalls += 1
      const failure = options.failManifest?.(manifestCalls)
      if (failure !== null && failure !== undefined) return failure
      return jsonResponse(options.manifest ?? manifestFixture(workId))
    }
    return new Response("", { status: 404 })
  }
}

async function manifestHarness(options: ManifestHandlerOptions = {}) {
  const harness = createHarness(manifestHandler(options))
  await harness.client.auth.importCookies([playSessionCookie()])
  return harness
}

describe("manifest", () => {
  it("parses tree/playfile/hashname data, preserves unknown fields, and infers tracks", async () => {
    const harness = await manifestHarness()
    const manifest = await harness.client.manifest.get(workId)

    expect(manifest.context.workId).toBe(workId)
    expect(manifest.context.revision).toBe("revision-0001")
    expect(manifest.context.hash).toBe("hash-0001")
    expect(manifest.updatedAt).toBe("2026-01-03T00:00:00Z")
    expect(manifest.tracks).toHaveLength(3)
    expect(manifest.subtitles).toHaveLength(1)
    expect(manifest.versions.map((entry) => entry.label)).toEqual([
      "SE",
      "MP3",
      ".flac",
      ".wav",
      ".mp3",
    ])

    const firstTrack = manifest.tracks[0]
    expect(firstTrack?.path).toBe("SE/disc1/01.flac")
    expect(firstTrack?.original.extension).toBe(".flac")
    expect(firstTrack?.optimized?.resourcePath).toBe(
      "optimized/optimized-01.mp3",
    )
    expect(firstTrack?.optimized?.mediaType).toBe("audio/mpeg")
    expect(firstTrack?.optimized?.sizeBytes).toBe(1_000)
    expect(manifest.tracks[1]?.optimized).toBeNull()

    expect(manifest.subtitles[0]?.format).toBe(".txt")
    expect(manifest.subtitles[0]?.optimizedResourcePath).toBe(
      "optimized/optimized-text.txt",
    )

    const seNode = manifest.tree[0]
    expect(seNode?.extra["custom_node_field"]).toBe("preserved")
    expect(manifest.playfiles["unknown-playfile"]?.extra["extra_field"]).toBe(
      "preserved",
    )

    const codes = manifest.diagnostics.map((entry) => entry.code)
    expect(codes).toContain("missing_optimized_audio")
    expect(codes).toContain("missing_playfile")
    expect(codes).toContain("unknown_playfile_type")
  })

  it("requests ziptree with signature parameters only and no login cookies", async () => {
    const harness = await manifestHarness()
    await harness.client.manifest.get(workId)

    const ziptreeCall = harness.server.calls.find((call) =>
      call.url.pathname.endsWith("/ziptree.json"),
    )
    expect(ziptreeCall).toBeDefined()
    expect(ziptreeCall?.url.hostname).toBe("play.dl.dlsite.com")
    expect(ziptreeCall?.url.pathname).toBe(
      `/content/work/doujin/RJ00000000/${workId}/ziptree.json`,
    )
    expect(ziptreeCall?.url.searchParams.get("Policy")).toBeTruthy()
    expect(ziptreeCall?.url.searchParams.get("Signature")).toBe(
      "FAKE_SIGNATURE",
    )
    expect(ziptreeCall?.url.searchParams.get("Key-Pair-Id")).toBe(
      "FAKE_KEY_PAIR",
    )
    expect(ziptreeCall?.url.searchParams.has("v")).toBe(false)
    const headers = ziptreeCall?.init.headers as Record<string, string>
    expect(headers["Cookie"]).toBeUndefined()
    expect(headers["Authorization"]).toBeUndefined()
  })

  it("rejects a manifest for a different work id", async () => {
    const fixture = manifestFixture(workId)
    fixture.workno = "RJ999999"
    const harness = await manifestHarness({ manifest: fixture })
    await expect(harness.client.manifest.get(workId)).rejects.toMatchObject({
      code: "UnexpectedResponse",
      diagnostic: "workno_mismatch",
    })
  })

  it("rejects an invalid manifest structure", async () => {
    const harness = await manifestHarness({ manifest: { version: "1.0" } })
    await expect(harness.client.manifest.get(workId)).rejects.toBeInstanceOf(
      UnexpectedResponse,
    )
  })

  it("refreshes the grant once after a CDN 403 and then succeeds", async () => {
    const harness = await manifestHarness({
      failManifest: (call) =>
        call === 1 ? new Response("", { status: 403 }) : null,
    })
    const manifest = await harness.client.manifest.get(workId)
    expect(manifest.context.workId).toBe(workId)
    expect(
      harness.server.calls.filter((call) =>
        call.url.pathname.endsWith("/sign/url"),
      ),
    ).toHaveLength(2)
    expect(
      harness.server.calls.filter((call) =>
        call.url.pathname.endsWith("/ziptree.json"),
      ),
    ).toHaveLength(2)
  })

  it("does not loop after a second CDN 403", async () => {
    const harness = await manifestHarness({
      failManifest: () => new Response("", { status: 403 }),
    })
    await expect(harness.client.manifest.get(workId)).rejects.toBeInstanceOf(
      HttpError,
    )
    expect(
      harness.server.calls.filter((call) =>
        call.url.pathname.endsWith("/sign/url"),
      ),
    ).toHaveLength(2)
    expect(
      harness.server.calls.filter((call) =>
        call.url.pathname.endsWith("/ziptree.json"),
      ),
    ).toHaveLength(2)
  })

  it("forces a new grant when refreshAccess is requested", async () => {
    const harness = await manifestHarness()
    await harness.client.manifest.get(workId)
    await harness.client.manifest.get(workId, { refreshAccess: true })
    expect(
      harness.server.calls.filter((call) =>
        call.url.pathname.endsWith("/sign/url"),
      ),
    ).toHaveLength(2)
  })
})
