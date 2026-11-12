import { extensionOf } from "../internal/url.js"
import type {
  Diagnostic,
  ManifestNode,
  PlayfileEntry,
  ResourceContext,
  SubtitleCandidate,
  Track,
  VersionCandidate,
} from "../model.js"

export interface InferenceResult {
  tracks: readonly Track[]
  subtitles: readonly SubtitleCandidate[]
  versions: readonly VersionCandidate[]
  diagnostics: readonly Diagnostic[]
}

interface FolderCandidate {
  label: string
  pathPrefix: string
  trackHashnames: string[]
}

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
}

export function inferManifest(
  tree: readonly ManifestNode[],
  playfiles: Readonly<Record<string, PlayfileEntry>>,
  context: ResourceContext,
  parseDiagnostics: readonly Diagnostic[],
): InferenceResult {
  const diagnostics: Diagnostic[] = [...parseDiagnostics]
  const tracks: Track[] = []
  const subtitles: SubtitleCandidate[] = []
  const folders: FolderCandidate[] = []

  for (const node of tree) {
    const topFolder =
      node.type === "folder"
        ? {
            label: node.name,
            pathPrefix: node.path ?? node.name,
            trackHashnames: [] as string[],
          }
        : null
    if (topFolder !== null) folders.push(topFolder)
    walkNode(
      node,
      "",
      topFolder,
      playfiles,
      context,
      tracks,
      subtitles,
      diagnostics,
    )
  }

  const folderVersions: VersionCandidate[] = []
  for (const folder of folders) {
    if (folder.trackHashnames.length === 0) continue
    folderVersions.push({
      label: folder.label,
      kind: "folder",
      pathPrefix: folder.pathPrefix,
      trackHashnames: folder.trackHashnames,
      reason:
        "Top-level folder contains audio tracks; this is a candidate grouping, not an automatic choice.",
    })
  }

  const formatGroups = new Map<string, string[]>()
  for (const track of tracks) {
    const extension = track.original.extension
    if (extension === null) continue
    const group = formatGroups.get(extension) ?? []
    group.push(track.hashname)
    formatGroups.set(extension, group)
  }
  const formatVersions: VersionCandidate[] = []
  for (const [extension, trackHashnames] of formatGroups) {
    formatVersions.push({
      label: extension,
      kind: "format",
      pathPrefix: null,
      trackHashnames,
      reason:
        "Grouped by original file extension; no equivalence or preference is implied.",
    })
  }

  return {
    tracks,
    subtitles,
    versions: [...folderVersions, ...formatVersions],
    diagnostics,
  }
}

function walkNode(
  node: ManifestNode,
  parentPath: string,
  topFolder: FolderCandidate | null,
  playfiles: Readonly<Record<string, PlayfileEntry>>,
  context: ResourceContext,
  tracks: Track[],
  subtitles: SubtitleCandidate[],
  diagnostics: Diagnostic[],
): void {
  const nodePath = node.path ?? joinPath(parentPath, node.name)
  if (node.type === "folder") {
    for (const child of node.children ?? []) {
      walkNode(
        child,
        nodePath,
        topFolder,
        playfiles,
        context,
        tracks,
        subtitles,
        diagnostics,
      )
    }
    return
  }
  if (node.type !== "file" || node.hashname === null) return

  const playfile = playfiles[node.hashname]
  if (playfile === undefined) {
    diagnostics.push({
      code: "missing_playfile",
      message: "A file tree node has no matching playfile entry.",
      path: nodePath,
    })
    return
  }

  if (playfile.type === "audio") {
    const optimized = playfile.audioOptimized
    const extension = extensionOf(node.name)
    if (optimized === null) {
      diagnostics.push({
        code: "missing_optimized_audio",
        message: "An audio file has no optimized media entry.",
        path: nodePath,
      })
    } else if (optimized.encrypted) {
      diagnostics.push({
        code: "encrypted_optimized",
        message: "An optimized audio entry is marked as encrypted.",
        path: nodePath,
      })
    }

    const optimizedExtension =
      optimized === null ? null : extensionOf(optimized.name)
    const track: Track = {
      context,
      hashname: node.hashname,
      path: nodePath,
      original: {
        extension,
        sizeBytes: playfile.length,
      },
      optimized:
        optimized === null
          ? null
          : {
              resourcePath: `optimized/${optimized.name}`,
              extension: optimizedExtension ?? "",
              mediaType:
                optimizedExtension === null
                  ? null
                  : (MEDIA_TYPES[optimizedExtension] ?? null),
              sizeBytes: optimized.lengthBytes,
              durationSeconds: optimized.durationSeconds,
              bitRate: optimized.bitRate,
              encrypted: optimized.encrypted,
            },
    }
    tracks.push(track)
    topFolder?.trackHashnames.push(node.hashname)
    return
  }

  if (playfile.type === "text") {
    const optimized = playfile.textOptimized
    const subtitleExtension =
      extensionOf(node.name) ??
      (optimized === null ? null : extensionOf(optimized.name))
    subtitles.push({
      context,
      hashname: node.hashname,
      path: nodePath,
      format: subtitleExtension ?? "unknown",
      optimizedResourcePath:
        optimized === null ? null : `optimized/${optimized.name}`,
      encoding: optimized?.encoding ?? null,
    })
  }
}

function joinPath(parent: string, name: string): string {
  return parent.length === 0 ? name : `${parent}/${name}`
}
