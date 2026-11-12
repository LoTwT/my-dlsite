import type { ScopedCookie } from "../src/model.js"

export type FakeHandler = (
  url: URL,
  init: RequestInit,
  call: number,
) => Response | Promise<Response>

export interface FakeCall {
  url: URL
  init: RequestInit
}

export interface FakeServer {
  calls: FakeCall[]
  fetch: typeof globalThis.fetch
  setHandler(handler: FakeHandler): void
}

export function createFakeServer(handler: FakeHandler): FakeServer {
  let current = handler
  const calls: FakeCall[] = []
  const fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const call = calls.length + 1
    const requestInit = init ?? {}
    calls.push({ url, init: requestInit })
    return current(url, requestInit, call)
  }
  return {
    calls,
    fetch: fetch as typeof globalThis.fetch,
    setHandler(next) {
      current = next
    },
  }
}

export function jsonResponse(
  data: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  })
}

export function textResponse(
  text: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(text, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...headers,
    },
  })
}

export interface FakeClock {
  now(): number
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>
  advance(milliseconds: number): void
  sleeps: number[]
}

export function createClock(startMilliseconds = 1_700_000_000_000): FakeClock {
  let milliseconds = startMilliseconds
  const sleeps: number[] = []
  return {
    now: () => milliseconds,
    sleep: async (duration, signal) => {
      if (signal?.aborted === true)
        throw new DOMException("Aborted", "AbortError")
      sleeps.push(duration)
      milliseconds += duration
    },
    advance: (duration) => {
      milliseconds += duration
    },
    sleeps,
  }
}

export function playSessionCookie(
  overrides: Partial<ScopedCookie> = {},
): ScopedCookie {
  return {
    name: "play_session",
    value: "FAKE_PLAY_SESSION",
    domain: "play.dlsite.com",
    path: "/",
    secure: true,
    hostOnly: true,
    httpOnly: true,
    expires: 1_999_999_999,
    ...overrides,
  }
}

export function policy(expirySeconds: number, marker = ""): string {
  return Buffer.from(
    JSON.stringify({
      Statement: [
        {
          Resource: "https://play.dl.dlsite.com/*",
          Condition: { DateLessThan: { "AWS:EpochTime": expirySeconds } },
        },
      ],
      ...(marker.length === 0 ? {} : { marker }),
    }),
  ).toString("base64")
}

export function cloudFrontPolicy(expirySeconds: number, marker = ""): string {
  return policy(expirySeconds, marker)
    .replace(/\+/g, "-")
    .replace(/=/g, "_")
    .replace(/\//g, "~")
}

export function signResponse(workId: string, expirySeconds: number): unknown {
  return {
    url: `https://play.dl.dlsite.com/content/work/doujin/RJ00000000/${workId}/`,
    params: {
      "Policy": policy(expirySeconds),
      "Signature": "FAKE_SIGNATURE",
      "Key-Pair-Id": "FAKE_KEY_PAIR",
    },
    expires: new Date(expirySeconds * 1_000).toISOString(),
  }
}

export function salesResponse(workIds: readonly string[]): unknown {
  return workIds.map((workno) => ({
    workno,
    sales_date: "2026-01-02T03:04:05Z",
  }))
}

export function workResponse(
  workno: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    workno,
    work_type: "SOU",
    name: {
      ja_JP: `作品 ${workno}`,
      zh_CN: `作品 ${workno}`,
      en_US: `Work ${workno}`,
    },
    maker: {
      id: "RG000001",
      name: { ja_JP: "メーカー", zh_CN: "社团" },
      name_phonetic: {},
    },
    release_date: "2026-01-01",
    site_id: "maniax",
    file_type: "WAV",
    age_category: "r18",
    tags: [{ name: "tag" }],
    pc_file_size: 123,
    playable: true,
    downloadable: true,
    encodable: true,
    ...overrides,
  }
}

export function worksResponse(works: readonly unknown[]): unknown {
  return { works }
}

export interface ManifestFixture {
  version: string
  workno: string
  revision: string
  hash: string
  updated_at: string
  tree: unknown[]
  playfile: Record<string, unknown>
}

export function manifestFixture(workId: string): ManifestFixture {
  return {
    version: "1.0",
    workno: workId,
    revision: "revision-0001",
    hash: "hash-0001",
    updated_at: "2026-01-03T00:00:00Z",
    tree: [
      {
        type: "folder",
        name: "SE",
        path: "SE",
        custom_node_field: "preserved",
        children: [
          {
            type: "folder",
            name: "disc1",
            path: "SE/disc1",
            children: [
              {
                type: "file",
                name: "01.flac",
                hashname: "audio-01.flac",
                path: "SE/disc1/01.flac",
              },
              {
                type: "file",
                name: "02.wav",
                hashname: "audio-02.wav",
                path: "SE/disc1/02.wav",
              },
            ],
          },
          {
            type: "file",
            name: "readme.txt",
            hashname: "text-01.txt",
            path: "SE/readme.txt",
          },
          {
            type: "file",
            name: "cover.png",
            hashname: "image-01.png",
            path: "SE/cover.png",
          },
          {
            type: "file",
            name: "unknown.bin",
            hashname: "missing-playfile.bin",
            path: "SE/unknown.bin",
          },
        ],
      },
      {
        type: "folder",
        name: "MP3",
        path: "MP3",
        children: [
          {
            type: "file",
            name: "01.mp3",
            hashname: "audio-03.mp3",
            path: "MP3/01.mp3",
          },
        ],
      },
    ],
    playfile: {
      "audio-01.flac": {
        type: "audio",
        length: 100,
        size: "100B",
        audio: {
          optimized: {
            name: "optimized-01.mp3",
            duration: 60,
            bit_rate: 128000,
            length: 1000,
            size: "1KB",
          },
        },
      },
      "audio-02.wav": {
        type: "audio",
        length: 200,
        size: "200B",
        audio: {},
      },
      "audio-03.mp3": {
        type: "audio",
        length: 300,
        size: "300B",
        audio: {
          optimized: {
            name: "optimized-03.mp3",
            duration: 90,
            bit_rate: 192000,
            length: 3000,
            size: "3KB",
          },
        },
      },
      "text-01.txt": {
        type: "text",
        length: 10,
        size: "10B",
        text: {
          optimized: {
            name: "optimized-text.txt",
            encoding: "utf-8",
            length: 10,
            size: "10B",
          },
        },
      },
      "image-01.png": {
        type: "image",
        length: 50,
        size: "50B",
        image: {
          files: {
            name: "image-01.png",
            width: 100,
            height: 100,
            length: 50,
            size: "50B",
            crypt: false,
          },
          optimized: {
            name: "optimized-image.png",
            width: 50,
            height: 50,
            length: 20,
            size: "20B",
            crypt: true,
          },
        },
      },
      "unknown-playfile": {
        type: "future",
        length: null,
        size: null,
        extra_field: "preserved",
      },
    },
  }
}
