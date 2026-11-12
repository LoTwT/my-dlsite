import { createAccessOperation, type Access } from "./access.js"
import { type Auth, combineSignals, type SessionContext } from "./auth.js"
import { StaleManifest, UnsupportedDelivery } from "./errors.js"
import { buildResourceUrl } from "./internal/url.js"
import type { Manifest } from "./manifest/index.js"
import type {
  MediaSource,
  PlaybackApi,
  PlaybackOptions,
  Track,
} from "./model.js"

export class Playback implements PlaybackApi {
  private readonly auth: Auth
  private readonly access: Access
  private readonly manifest: Manifest

  constructor(auth: Auth, access: Access, manifest: Manifest) {
    this.auth = auth
    this.access = access
    this.manifest = manifest
  }

  async resolve(
    track: Track,
    options: PlaybackOptions = {},
  ): Promise<MediaSource> {
    return this.auth.operation(async (context) => {
      const signal = combineSignals(context.signal, options.signal)
      const workId = track.context.workId
      const optimized = track.optimized
      if (optimized === null) {
        throw new UnsupportedDelivery("no_optimized_audio", workId)
      }
      if (optimized.encrypted) {
        throw new UnsupportedDelivery("encrypted_media", workId)
      }

      this.assertTrackMatches(context, track)
      const operation = createAccessOperation()
      const grant = await this.access.getGrant(context, workId, {
        refreshAccess: options.refreshAccess === true,
        operation,
        ...(signal === undefined ? {} : { signal }),
      })
      this.auth.assertCurrent(context)
      this.assertTrackMatches(context, track)
      if (grant.baseUrl !== track.context.baseUrl) {
        throw new StaleManifest(workId, "base-url")
      }

      const url = buildResourceUrl(
        grant.baseUrl,
        optimized.resourcePath,
        grant.params,
        "playback.resolve",
      )
      const source: MediaSource = {
        url: url.href,
        headers: {},
        expiresAt: new Date(grant.expiresAt).toISOString(),
      }
      if (optimized.mediaType !== null) source.mimeType = optimized.mediaType
      if (optimized.sizeBytes !== null) source.sizeBytes = optimized.sizeBytes
      return source
    }, options)
  }

  private assertTrackMatches(context: SessionContext, track: Track): void {
    const workId = track.context.workId
    const latest = this.manifest.getLatestContext(context, workId)
    if (latest === null) throw new StaleManifest(workId, "unknown")
    if (latest.baseUrl !== track.context.baseUrl)
      throw new StaleManifest(workId, "base-url")
    if (latest.revision !== track.context.revision)
      throw new StaleManifest(workId, "revision")
    if (latest.hash !== track.context.hash)
      throw new StaleManifest(workId, "hash")
  }
}
