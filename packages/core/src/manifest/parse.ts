import * as v from "valibot"
import { UnexpectedResponse } from "../errors.js"
import type {
  AudioOptimized,
  Diagnostic,
  ImageOptimized,
  ManifestNode,
  PlayfileEntry,
  TextOptimized,
} from "../model.js"

const TOP_LEVEL_KEYS = new Set([
  "version",
  "workno",
  "revision",
  "hash",
  "updated_at",
  "tree",
  "playfile",
])

const documentSchema = v.object({
  version: v.string(),
  workno: v.string(),
  revision: v.string(),
  hash: v.string(),
  updated_at: v.optional(v.nullable(v.string())),
  tree: v.array(v.unknown()),
  playfile: v.record(v.string(), v.unknown()),
})

export interface ParsedManifest {
  version: string
  revision: string
  hash: string
  updatedAt: string | null
  tree: readonly ManifestNode[]
  playfiles: Readonly<Record<string, PlayfileEntry>>
  extra: Readonly<Record<string, unknown>>
  diagnostics: readonly Diagnostic[]
}

export function parseManifestDocument(
  value: unknown,
  workId: string,
): ParsedManifest {
  const parsed = v.safeParse(documentSchema, value)
  if (!parsed.success) {
    throw new UnexpectedResponse("manifest.get", "manifest_shape")
  }
  if (parsed.output.workno !== workId) {
    throw new UnexpectedResponse("manifest.get", "workno_mismatch")
  }

  const diagnostics: Diagnostic[] = []
  const tree: ManifestNode[] = []
  for (const node of parsed.output.tree) {
    const parsedNode = parseNode(node, diagnostics)
    if (parsedNode !== null) tree.push(parsedNode)
  }

  const playfiles: Record<string, PlayfileEntry> = {}
  for (const [hashname, entry] of Object.entries(parsed.output.playfile)) {
    const parsedEntry = parsePlayfile(entry, diagnostics)
    if (parsedEntry !== null) playfiles[hashname] = parsedEntry
  }

  const extra: Record<string, unknown> = {}
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (!TOP_LEVEL_KEYS.has(key)) extra[key] = entry
    }
  }

  return {
    version: parsed.output.version,
    revision: parsed.output.revision,
    hash: parsed.output.hash,
    updatedAt: parsed.output.updated_at ?? null,
    tree,
    playfiles,
    extra,
    diagnostics,
  }
}

function parseNode(
  value: unknown,
  diagnostics: Diagnostic[],
): ManifestNode | null {
  if (!isRecord(value)) {
    diagnostics.push({
      code: "invalid_tree_node",
      message: "A manifest tree node was not an object.",
    })
    return null
  }
  const type = typeof value["type"] === "string" ? value["type"] : null
  const name = typeof value["name"] === "string" ? value["name"] : null
  if (type === null || name === null) {
    diagnostics.push({
      code: "invalid_tree_node",
      message: "A manifest tree node did not contain a usable type and name.",
    })
    return null
  }
  if (type !== "file" && type !== "folder") {
    diagnostics.push({
      code: "unknown_node_type",
      message: "A manifest tree node used an unknown type; it was preserved.",
    })
  }

  const hashname =
    typeof value["hashname"] === "string" ? value["hashname"] : null
  const path = typeof value["path"] === "string" ? value["path"] : null
  if (type === "file" && hashname === null) {
    diagnostics.push({
      code: "missing_hashname",
      message: "A file tree node did not contain a hashname.",
      ...(path === null ? {} : { path }),
    })
  }

  let children: ManifestNode[] | null = null
  if (Array.isArray(value["children"])) {
    children = []
    for (const child of value["children"]) {
      const parsedChild = parseNode(child, diagnostics)
      if (parsedChild !== null) children.push(parsedChild)
    }
  }

  const extra: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (
      key !== "type" &&
      key !== "name" &&
      key !== "hashname" &&
      key !== "path" &&
      key !== "children"
    ) {
      extra[key] = entry
    }
  }

  return { type, name, hashname, path, children, extra }
}

function parsePlayfile(
  value: unknown,
  diagnostics: Diagnostic[],
): PlayfileEntry | null {
  if (!isRecord(value)) {
    diagnostics.push({
      code: "invalid_playfile_entry",
      message: "A playfile entry was not an object.",
    })
    return null
  }
  const type = typeof value["type"] === "string" ? value["type"] : "unknown"
  if (
    type !== "text" &&
    type !== "audio" &&
    type !== "image" &&
    type !== "pdf"
  ) {
    diagnostics.push({
      code: "unknown_playfile_type",
      message: "A playfile entry used an unknown type; it was preserved.",
    })
  }

  const extra: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (
      key !== "type" &&
      key !== "length" &&
      key !== "size" &&
      key !== "text" &&
      key !== "audio" &&
      key !== "image" &&
      key !== "pdf"
    ) {
      extra[key] = entry
    }
  }

  return {
    type,
    length: readNumber(value["length"]),
    size: readString(value["size"]),
    media: readMedia(value),
    audioOptimized: parseAudioOptimized(value["audio"], diagnostics),
    textOptimized: parseTextOptimized(value["text"]),
    imageOptimized: parseImageOptimized(value["image"]),
    pdfPageCount: parsePdfPageCount(value["pdf"]),
    extra,
  }
}

function readMedia(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const media: Record<string, unknown> = {}
  for (const key of ["text", "audio", "image", "pdf"] as const) {
    if (key in value) media[key] = value[key]
  }
  return media
}

function parseAudioOptimized(
  value: unknown,
  diagnostics: Diagnostic[],
): AudioOptimized | null {
  if (!isRecord(value)) return null
  const optimized = value["optimized"]
  if (!isRecord(optimized)) return null
  const name = readString(optimized["name"])
  if (name === null) {
    diagnostics.push({
      code: "invalid_audio_optimized",
      message: "An audio optimized entry did not contain a name.",
    })
    return null
  }
  return {
    name,
    durationSeconds: readNumber(optimized["duration"]),
    bitRate: readNumber(optimized["bit_rate"]),
    lengthBytes: readNumber(optimized["length"]),
    sizeLabel: readString(optimized["size"]),
    encrypted: optimized["crypt"] === true,
  }
}

function parseTextOptimized(value: unknown): TextOptimized | null {
  if (!isRecord(value)) return null
  const optimized = value["optimized"]
  if (!isRecord(optimized)) return null
  const name = readString(optimized["name"])
  if (name === null) return null
  return {
    name,
    encoding: readString(optimized["encoding"]),
    lengthBytes: readNumber(optimized["length"]),
    sizeLabel: readString(optimized["size"]),
  }
}

function parseImageOptimized(value: unknown): ImageOptimized | null {
  if (!isRecord(value)) return null
  const optimized = value["optimized"]
  if (!isRecord(optimized)) return null
  const name = readString(optimized["name"])
  if (name === null) return null
  return {
    name,
    width: readNumber(optimized["width"]),
    height: readNumber(optimized["height"]),
    lengthBytes: readNumber(optimized["length"]),
    sizeLabel: readString(optimized["size"]),
    encrypted: optimized["crypt"] === true,
  }
}

function parsePdfPageCount(value: unknown): number | null {
  if (!isRecord(value)) return null
  const pages = value["page"]
  return Array.isArray(pages) ? pages.length : null
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
