import { createAccessOperation, type Access } from "../access.js"
import { type Auth, combineSignals, type SessionContext } from "../auth.js"
import { HttpError } from "../errors.js"
import { buildResourceUrl, pathPrefix } from "../internal/url.js"
import type {
  ManifestApi,
  ManifestOptions,
  ResourceContext,
  WorkId,
  WorkManifest,
} from "../model.js"
import type { Transport } from "../transport.js"
import { inferManifest } from "./infer.js"
import { parseManifestDocument } from "./parse.js"

const CDN_HOST = "play.dl.dlsite.com"
const MANIFEST_PATH = "ziptree.json"

export class Manifest implements ManifestApi {
  private readonly transport: Transport
  private readonly auth: Auth
  private readonly access: Access
  private readonly contexts = new Map<string, ResourceContext>()

  constructor(transport: Transport, auth: Auth, access: Access) {
    this.transport = transport
    this.auth = auth
    this.access = access
  }

  clear(): void {
    this.contexts.clear()
  }

  async get(
    workId: WorkId,
    options: ManifestOptions = {},
  ): Promise<WorkManifest> {
    return this.auth.operation(async (context) => {
      const signal = combineSignals(context.signal, options.signal)
      const operation = createAccessOperation()
      let grant = await this.access.getGrant(context, workId, {
        refreshAccess: options.refreshAccess === true,
        operation,
        ...(signal === undefined ? {} : { signal }),
      })
      this.auth.assertCurrent(context)

      let retriedFor403 = false
      let value: unknown
      for (;;) {
        const url = buildResourceUrl(
          grant.baseUrl,
          MANIFEST_PATH,
          grant.params,
          "manifest.get",
        )
        const allowedPath = pathPrefix(new URL(grant.baseUrl).pathname)
        try {
          value = await this.transport.requestJson({
            method: "GET",
            url,
            endpoint: "manifest.get",
            allowedHosts: [CDN_HOST],
            allowedPath,
            authContext: "none",
            credentials: "none",
            ...(signal === undefined ? {} : { signal }),
          })
          break
        } catch (error) {
          if (
            error instanceof HttpError &&
            error.status === 403 &&
            !retriedFor403
          ) {
            this.auth.assertCurrent(context)
            retriedFor403 = true
            this.access.invalidate(context, workId)
            this.auth.assertCurrent(context)
            grant = await this.access.getGrant(context, workId, {
              refreshAccess: true,
              operation,
              ...(signal === undefined ? {} : { signal }),
            })
            this.auth.assertCurrent(context)
            continue
          }
          throw error
        }
      }

      this.auth.assertCurrent(context)
      const parsed = parseManifestDocument(value, workId)
      const resourceContext: ResourceContext = {
        workId,
        baseUrl: grant.baseUrl,
        revision: parsed.revision,
        hash: parsed.hash,
      }
      const inferred = inferManifest(
        parsed.tree,
        parsed.playfiles,
        resourceContext,
        parsed.diagnostics,
      )
      this.auth.assertCurrent(context)
      this.contexts.set(this.key(context, workId), resourceContext)

      return {
        context: resourceContext,
        version: parsed.version,
        updatedAt: parsed.updatedAt,
        tree: parsed.tree,
        playfiles: parsed.playfiles,
        extra: parsed.extra,
        tracks: inferred.tracks,
        subtitles: inferred.subtitles,
        versions: inferred.versions,
        diagnostics: inferred.diagnostics,
      }
    }, options)
  }

  getLatestContext(
    context: SessionContext,
    workId: WorkId,
  ): ResourceContext | null {
    return this.contexts.get(this.key(context, workId)) ?? null
  }

  private key(context: SessionContext, workId: WorkId): string {
    return `${context.generation}:${workId}`
  }
}
