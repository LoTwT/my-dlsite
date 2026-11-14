import { constants } from "node:fs"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionSnapshot } from "@my-dlsite/core"
import { afterEach, describe, expect, it } from "vitest"
import { withSessionStore } from "../src/session-store.js"

const directories: string[] = []
async function temporaryDirectory() {
  const directory = await mkdtemp(
    join(await realpath(tmpdir()), "my-dlsite-store-test-"),
  )
  directories.push(directory)
  return directory
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})
const snapshot: SessionSnapshot = {
  version: 1,
  cookies: [
    {
      name: "synthetic",
      value: "SYNTHETIC_SECRET",
      domain: "play.dlsite.com",
      path: "/",
      secure: true,
      hostOnly: true,
      httpOnly: true,
      expires: null,
    },
  ],
}

describe("session file transaction", () => {
  it("creates restricted files and atomically replaces the snapshot without modifying old file descriptors", async () => {
    const directory = join(await temporaryDirectory(), "state")
    await withSessionStore(directory, async (store) => {
      expect(await store.read()).toBeNull()
      await store.save(snapshot)
      expect((await lstat(directory)).mode & 0o777).toBe(0o700)
      expect((await lstat(join(directory, "session.json"))).mode & 0o777).toBe(
        0o600,
      )
      const previous = await open(
        join(directory, "session.json"),
        constants.O_RDONLY,
      )
      try {
        const first = snapshot.cookies[0]
        if (first === undefined) throw new Error("missing fixture")
        await store.save({
          ...snapshot,
          cookies: [{ ...first, value: "ROTATED" }],
        })
        expect(JSON.parse(await previous.readFile("utf8"))).toEqual(snapshot)
        expect((await store.read())?.cookies[0]?.value).toBe("ROTATED")
      } finally {
        await previous.close()
      }
      expect(await readdir(directory)).toEqual(["session.json", "session.lock"])
    })
    expect(await readdir(directory)).toEqual(["session.json"])
  })

  it("holds one exclusive lock across read and save and retains the completed state", async () => {
    const directory = await temporaryDirectory()
    await withSessionStore(directory, async (store) => {
      await store.save(snapshot)
      await expect(
        withSessionStore(directory, async () => {}),
      ).rejects.toMatchObject({ code: "busy" })
      expect(await store.read()).toEqual(snapshot)
    })
    await expect(
      withSessionStore(directory, async (store) => store.read()),
    ).resolves.toEqual(snapshot)
  })

  it.each(["json", "version"])(
    "reports corrupt %s without clearing it",
    async (kind) => {
      const directory = await temporaryDirectory()
      const contents =
        kind === "json"
          ? "SYNTHETIC_BAD_SECRET{"
          : JSON.stringify({ ...snapshot, version: 999 })
      await writeFile(join(directory, "session.json"), contents, {
        mode: 0o600,
      })
      await expect(
        withSessionStore(directory, (store) => store.read()),
      ).rejects.toMatchObject({ code: "invalid-snapshot" })
      expect(await readFile(join(directory, "session.json"), "utf8")).toBe(
        contents,
      )
    },
  )

  it("retains old bytes and removes its temporary file if serialization fails", async () => {
    const directory = await temporaryDirectory()
    await withSessionStore(directory, async (store) => {
      await store.save(snapshot)
      const bad = {
        ...snapshot,
        toJSON() {
          throw new Error("SYNTHETIC_SECRET")
        },
      }
      await expect(store.save(bad)).rejects.toMatchObject({ code: "save" })
      expect(await store.read()).toEqual(snapshot)
      expect(await readdir(directory)).toEqual(["session.json", "session.lock"])
    })
  })

  it("preserves the old snapshot on a filesystem write failure", async () => {
    const directory = await temporaryDirectory()
    await withSessionStore(directory, async (store) => {
      await store.save(snapshot)
      const before = await readFile(join(directory, "session.json"), "utf8")
      await chmod(directory, 0o500)
      try {
        await expect(store.save(snapshot)).rejects.toMatchObject({
          code: "save",
        })
        expect(await readFile(join(directory, "session.json"), "utf8")).toBe(
          before,
        )
      } finally {
        await chmod(directory, 0o700)
      }
    })
    expect(await readdir(directory)).toEqual(["session.json"])
  })

  it.each([
    "directory",
    "ancestor",
    "file",
    "file-mode",
    "directory-mode",
    "hard-link",
  ])("rejects unsafe %s boundaries", async (kind) => {
    const root = await temporaryDirectory()
    const directory = join(root, "state")
    await mkdir(directory, { mode: 0o700 })
    const outside = join(root, "outside")
    await writeFile(outside, "SYNTHETIC_SECRET", { mode: 0o600 })
    let target = directory
    if (kind === "directory") {
      target = join(root, "alias")
      await symlink(directory, target)
    } else if (kind === "ancestor") {
      await symlink(directory, join(root, "alias"))
      target = join(root, "alias", "nested")
    } else if (kind === "file") {
      await symlink(outside, join(directory, "session.json"))
    } else if (kind === "file-mode") {
      await writeFile(join(directory, "session.json"), "{}", { mode: 0o644 })
    } else if (kind === "directory-mode") {
      await chmod(directory, 0o755)
    } else {
      const { link } = await import("node:fs/promises")
      await link(outside, join(directory, "session.json"))
    }
    await expect(
      withSessionStore(target, async () => {}),
    ).rejects.toMatchObject({ code: "unsafe-path" })
    expect(await readFile(outside, "utf8")).toBe("SYNTHETIC_SECRET")
  })
})
