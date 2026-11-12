export const DEFAULT_LANGUAGE = "ja_JP"
export const WORKS_BATCH_SIZE = 10
export const GRANT_REFRESH_THRESHOLD_MS = 60_000
export const TRANSACTION_TIMEOUT_MS = 30_000
export const HOST_RATE_LIMIT_MS = 1_000
export const MAX_REDIRECTS = 10

export type Language = string
export type WorkType = string
export type WorkId = string

export interface ClientConfig {
  fetch?: typeof globalThis.fetch
  language?: Language
  userAgent?: string
}

export interface OperationOptions {
  signal?: AbortSignal
}

export interface LibraryOptions extends OperationOptions {
  language?: Language
  workTypes?: readonly WorkType[]
}

export interface ManifestOptions extends OperationOptions {
  refreshAccess?: boolean
}

export interface PlaybackOptions extends OperationOptions {
  refreshAccess?: boolean
}

export interface ScopedCookie {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  hostOnly: boolean
  httpOnly?: boolean
  expires?: number
  sameSite?: string
}

export interface SnapshotCookie {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  hostOnly: boolean
  httpOnly: boolean
  expires: number | null
  sameSite?: string
}

export interface SessionSnapshot {
  version: 1
  cookies: readonly SnapshotCookie[]
}

export interface Diagnostic {
  code: string
  message: string
  workId?: WorkId
  path?: string
}

export interface PurchaseRecord {
  workId: WorkId
  purchasedAt: string | null
}

export interface LocalizedText {
  readonly [language: string]: string
}

export interface MakerMetadata {
  id: string | null
  names: LocalizedText
  name: string | null
}

export interface WorkMetadata {
  workId: WorkId
  workType: WorkType | null
  names: LocalizedText
  name: string | null
  maker: MakerMetadata | null
  releaseDate: string | null
  siteId: string | null
  fileType: string | null
  ageCategory: string | null
  tags: readonly string[]
  pcFileSize: number | null
  playable: boolean | null
  downloadable: boolean | null
  encodable: boolean | null
}

export interface LibraryWork {
  purchase: PurchaseRecord
  metadata: WorkMetadata
}

export interface LibrarySnapshot {
  works: readonly LibraryWork[]
  missingMetadata: readonly PurchaseRecord[]
  otherPurchases: readonly LibraryWork[]
  diagnostics: readonly Diagnostic[]
}

export interface ResourceContext {
  workId: WorkId
  baseUrl: string
  revision: string
  hash: string
}

export interface OriginalMedia {
  extension: string | null
  sizeBytes: number | null
}

export interface OptimizedMedia {
  resourcePath: string
  extension: string
  mediaType: string | null
  sizeBytes: number | null
  durationSeconds: number | null
  bitRate: number | null
  encrypted: boolean
}

export interface Track {
  context: ResourceContext
  hashname: string
  path: string
  original: OriginalMedia
  optimized: OptimizedMedia | null
}

export interface SubtitleCandidate {
  context: ResourceContext
  hashname: string
  path: string
  format: string
  optimizedResourcePath: string | null
  encoding: string | null
}

export interface VersionCandidate {
  label: string
  kind: "folder" | "format" | "unknown"
  pathPrefix: string | null
  trackHashnames: readonly string[]
  reason: string
}

export interface ManifestNode {
  type: string
  name: string
  hashname: string | null
  path: string | null
  children: readonly ManifestNode[] | null
  extra: Readonly<Record<string, unknown>>
}

export interface PlayfileEntry {
  type: string
  length: number | null
  size: string | null
  media?: Readonly<Record<string, unknown>>
  audioOptimized: AudioOptimized | null
  textOptimized: TextOptimized | null
  imageOptimized: ImageOptimized | null
  pdfPageCount: number | null
  extra: Readonly<Record<string, unknown>>
}

export interface AudioOptimized {
  name: string
  durationSeconds: number | null
  bitRate: number | null
  lengthBytes: number | null
  sizeLabel: string | null
  encrypted: boolean
}

export interface TextOptimized {
  name: string
  encoding: string | null
  lengthBytes: number | null
  sizeLabel: string | null
}

export interface ImageOptimized {
  name: string
  width: number | null
  height: number | null
  lengthBytes: number | null
  sizeLabel: string | null
  encrypted: boolean
}

export interface WorkManifest {
  context: ResourceContext
  version: string
  updatedAt: string | null
  tree: readonly ManifestNode[]
  playfiles: Readonly<Record<string, PlayfileEntry>>
  extra: Readonly<Record<string, unknown>>
  tracks: readonly Track[]
  subtitles: readonly SubtitleCandidate[]
  versions: readonly VersionCandidate[]
  diagnostics: readonly Diagnostic[]
}

export interface MediaSource {
  url: string
  headers: Readonly<Record<string, string>>
  expiresAt: string
  mimeType?: string
  sizeBytes?: number
}

/**
 * A short-lived, credential-bearing plan for one original delivery.
 * `headers` is computed for `url` only; do not reuse it for another target or
 * log the plan. The URL may be single-use, so download it immediately.
 */
export interface AcquisitionPlan {
  url: string
  filename: string
  headers: Readonly<Record<string, string>>
  mimeType?: string
  sizeBytes?: number
  expiresAt?: string
}

export interface AuthApi {
  importCookies(
    cookies: readonly ScopedCookie[],
    options?: OperationOptions,
  ): Promise<void>
  restore(snapshot: SessionSnapshot, options?: OperationOptions): Promise<void>
  export(): Promise<SessionSnapshot>
  validate(options?: OperationOptions): Promise<void>
}

export interface LibraryApi {
  list(options?: LibraryOptions): Promise<LibrarySnapshot>
}

export interface ManifestApi {
  get(workId: WorkId, options?: ManifestOptions): Promise<WorkManifest>
}

export interface PlaybackApi {
  resolve(track: Track, options?: PlaybackOptions): Promise<MediaSource>
}

export interface AcquisitionApi {
  /**
   * Resolves the observed single-ZIP original delivery without downloading it.
   */
  plan(workId: WorkId, options?: OperationOptions): Promise<AcquisitionPlan>
}

export interface DlsiteClient {
  readonly auth: AuthApi
  readonly acquisition: AcquisitionApi
  readonly library: LibraryApi
  readonly manifest: ManifestApi
  readonly playback: PlaybackApi
}

export interface CoreRuntimeOptions extends ClientConfig {
  now?: () => number
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  transactionTimeoutMs?: number
  hostRateLimitMs?: number
}
