import { describe, expect, it } from "vitest"
import { Aborted, UnexpectedResponse } from "../src/errors.js"
import type { Track } from "../src/model.js"
import { createHarness } from "./client-helpers.js"
import {
  jsonResponse,
  manifestFixture,
  playSessionCookie,
  salesResponse,
  signResponse,
} from "./helpers.js"

const workId = "RJ123456"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolver) => {
    resolve = resolver
  })
  return { promise, resolve }
}

function playbackHandler(
  options: {
    fixture?: unknown
    sign?: (call: number) => unknown
  } = {},
) {
  let signCalls = 0
  return (url: URL) => {
    if (url.pathname === "/api/v4/content/sales")
      return jsonResponse(salesResponse([]))
    if (url.pathname === "/api/v4/download/sign/url") {
      signCalls += 1
      const value =
        options.sign?.(signCalls) ??
        signResponse(workId, Math.floor(Date.now() / 1_000) + 3_600)
      return jsonResponse(value)
    }
    if (url.pathname.endsWith("/ziptree.json")) {
      return jsonResponse(options.fixture ?? manifestFixture(workId))
    }
    return new Response("", { status: 404 })
  }
}

async function playbackHarness(
  options: {
    fixture?: unknown
    sign?: (call: number) => unknown
  } = {},
) {
  const harness = createHarness(playbackHandler(options))
  await harness.client.auth.importCookies([playSessionCookie()])
  const manifest = await harness.client.manifest.get(workId)
  return { harness, manifest }
}

describe("playback", () => {
  it("resolves a signed URL without probing audio and keeps headers empty", async () => {
    const { harness, manifest } = await playbackHarness()
    const track = manifest.tracks[0]
    expect(track).toBeDefined()
    if (track === undefined) return

    const before = harness.server.calls.length
    const source = await harness.client.playback.resolve(track)
    expect(harness.server.calls.length).toBe(before)
    expect(source.headers).toEqual({})
    expect(source.mimeType).toBe("audio/mpeg")
    expect(source.sizeBytes).toBe(1_000)
    expect(source.expiresAt).toBe(
      new Date(Date.parse(source.expiresAt)).toISOString(),
    )

    const url = new URL(source.url)
    expect(url.protocol).toBe("https:")
    expect(url.hostname).toBe("play.dl.dlsite.com")
    expect(url.pathname).toBe(
      `/content/work/doujin/RJ00000000/${workId}/optimized/optimized-01.mp3`,
    )
    expect(url.searchParams.get("Policy")).toBeTruthy()
    expect(url.searchParams.get("Signature")).toBe("FAKE_SIGNATURE")
    expect(url.searchParams.get("Key-Pair-Id")).toBe("FAKE_KEY_PAIR")
    expect(
      harness.server.calls.some((call) =>
        call.url.pathname.includes("/optimized/"),
      ),
    ).toBe(false)
  })

  it("rejects a pre-aborted signal even when the manifest and grant are cached", async () => {
    const { harness, manifest } = await playbackHarness()
    const track = manifest.tracks[0]
    expect(track).toBeDefined()
    if (track === undefined) return
    const before = harness.server.calls.length
    const controller = new AbortController()
    controller.abort()
    await expect(
      harness.client.playback.resolve(track, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(Aborted)
    expect(harness.server.calls.length).toBe(before)
  })

  it("rechecks the latest manifest after waiting for a refreshed grant", async () => {
    const sign = deferred<unknown>()
    const signStarted = deferred<void>()
    let signCalls = 0
    let fixture = manifestFixture(workId)
    const harness = createHarness((url) => {
      if (url.pathname === "/api/v4/content/sales")
        return jsonResponse(salesResponse([]))
      if (url.pathname === "/api/v4/download/sign/url") {
        signCalls += 1
        if (signCalls === 1)
          return jsonResponse(signResponse(workId, 2_000_000_000))
        signStarted.resolve()
        return sign.promise.then((value) => jsonResponse(value))
      }
      if (url.pathname.endsWith("/ziptree.json")) return jsonResponse(fixture)
      return new Response("", { status: 404 })
    })
    await harness.client.auth.importCookies([playSessionCookie()])
    const first = await harness.client.manifest.get(workId)
    const track = first.tracks[0]
    expect(track).toBeDefined()
    if (track === undefined) return

    const pending = harness.client.playback.resolve(track, {
      refreshAccess: true,
    })
    await signStarted.promise
    fixture = {
      ...manifestFixture(workId),
      revision: "revision-0002",
      hash: "hash-0002",
    }
    await harness.client.manifest.get(workId)
    sign.resolve(signResponse(workId, 2_000_000_000))

    await expect(pending).rejects.toMatchObject({
      code: "StaleManifest",
      reason: "revision",
    })
  })

  it("rejects a track whose revision or hash differs from the latest manifest", async () => {
    const { harness, manifest } = await playbackHarness()
    const track = manifest.tracks[0]
    expect(track).toBeDefined()
    if (track === undefined) return

    const staleRevision: Track = {
      ...track,
      context: { ...track.context, revision: "old-revision" },
    }
    await expect(
      harness.client.playback.resolve(staleRevision),
    ).rejects.toMatchObject({
      code: "StaleManifest",
      reason: "revision",
    })

    const staleHash: Track = {
      ...track,
      context: { ...track.context, hash: "old-hash" },
    }
    await expect(
      harness.client.playback.resolve(staleHash),
    ).rejects.toMatchObject({
      code: "StaleManifest",
      reason: "hash",
    })
  })

  it("requires a known manifest context and rejects unknown tracks", async () => {
    const { harness, manifest } = await playbackHarness()
    const track = manifest.tracks[0]
    expect(track).toBeDefined()
    if (track === undefined) return
    const unknown: Track = {
      ...track,
      context: { ...track.context, workId: "RJ999999" },
    }
    await expect(
      harness.client.playback.resolve(unknown),
    ).rejects.toMatchObject({
      code: "StaleManifest",
      reason: "unknown",
    })
  })

  it("returns UnsupportedDelivery for missing optimized media and encrypted media", async () => {
    const { harness, manifest } = await playbackHarness()
    const noOptimized = manifest.tracks[1]
    expect(noOptimized).toBeDefined()
    if (noOptimized === undefined) return
    await expect(
      harness.client.playback.resolve(noOptimized),
    ).rejects.toMatchObject({
      code: "UnsupportedDelivery",
      reason: "no_optimized_audio",
    })

    const fixture = manifestFixture(workId)
    const audio = fixture.playfile["audio-01.flac"] as {
      audio: { optimized: Record<string, unknown> }
    }
    audio.audio.optimized["crypt"] = true
    const encryptedHarness = createHarness(playbackHandler({ fixture }))
    await encryptedHarness.client.auth.importCookies([playSessionCookie()])
    const encryptedManifest = await encryptedHarness.client.manifest.get(workId)
    const encryptedTrack = encryptedManifest.tracks[0]
    expect(encryptedTrack).toBeDefined()
    if (encryptedTrack === undefined) return
    await expect(
      encryptedHarness.client.playback.resolve(encryptedTrack),
    ).rejects.toMatchObject({
      code: "UnsupportedDelivery",
      reason: "encrypted_media",
    })
  })

  it("rejects a refreshed grant with a different base URL as StaleManifest", async () => {
    const { harness, manifest } = await playbackHarness({
      sign: (call) =>
        call === 1
          ? signResponse(workId, Math.floor(Date.now() / 1_000) + 3_600)
          : {
              ...(signResponse(
                workId,
                Math.floor(Date.now() / 1_000) + 3_600,
              ) as Record<string, unknown>),
              url: `https://play.dl.dlsite.com/content/work/doujin/RJ99999999/${workId}/`,
            },
    })
    const track = manifest.tracks[0]
    expect(track).toBeDefined()
    if (track === undefined) return
    await expect(
      harness.client.playback.resolve(track, { refreshAccess: true }),
    ).rejects.toMatchObject({ code: "StaleManifest", reason: "base-url" })
  })

  it("rejects a track resource path that escapes the grant base", async () => {
    const { harness, manifest } = await playbackHarness()
    const track = manifest.tracks[0]
    expect(track).toBeDefined()
    if (track === undefined || track.optimized === null) return
    const malicious: Track = {
      ...track,
      optimized: { ...track.optimized, resourcePath: "../secret.mp3" },
    }
    await expect(
      harness.client.playback.resolve(malicious),
    ).rejects.toBeInstanceOf(UnexpectedResponse)
  })
})
