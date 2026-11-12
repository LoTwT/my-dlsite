import { Access } from "./access.js"
import { Auth } from "./auth.js"
import { InvalidInput } from "./errors.js"
import { type Clock, systemClock } from "./internal/clock.js"
import { Library } from "./library.js"
import { Manifest } from "./manifest/index.js"
import {
  DEFAULT_LANGUAGE,
  type ClientConfig,
  type CoreRuntimeOptions,
  type DlsiteClient,
} from "./model.js"
import { Playback } from "./playback.js"
import { Transport } from "./transport.js"

const DEFAULT_USER_AGENT = "my-dlsite-core/0.0.0"

export function createClient(config: ClientConfig = {}): DlsiteClient {
  return createClientInternal(config)
}

export function createClientInternal(
  options: CoreRuntimeOptions = {},
): DlsiteClient {
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== "function")
    throw new InvalidInput("fetch_unavailable")

  const clock: Clock = {
    now: options.now ?? (() => systemClock.now()),
    sleep:
      options.sleep ??
      ((milliseconds, signal) => systemClock.sleep(milliseconds, signal)),
  }
  const transport = new Transport({
    fetch: fetchImpl,
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    clock,
    ...(options.transactionTimeoutMs === undefined
      ? {}
      : { transactionTimeoutMs: options.transactionTimeoutMs }),
    ...(options.hostRateLimitMs === undefined
      ? {}
      : { hostRateLimitMs: options.hostRateLimitMs }),
  })

  let clearCaches: () => void = () => {}
  const now = () => clock.now()
  const auth = new Auth(transport, now, () => clearCaches())
  const access = new Access(transport, auth, now)
  const manifest = new Manifest(transport, auth, access)
  const library = new Library(
    transport,
    auth,
    options.language ?? DEFAULT_LANGUAGE,
  )
  const playback = new Playback(auth, access, manifest)
  clearCaches = () => {
    access.clear()
    manifest.clear()
  }

  return { auth, library, manifest, playback }
}
