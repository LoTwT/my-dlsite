import { createClientInternal } from "../src/client.js"
import type { CoreRuntimeOptions, DlsiteClient } from "../src/model.js"
import {
  createClock,
  createFakeServer,
  type FakeClock,
  type FakeHandler,
  type FakeServer,
} from "./helpers.js"

export interface Harness {
  client: DlsiteClient
  server: FakeServer
  clock: FakeClock
}

export function createHarness(
  handler: FakeHandler,
  options: CoreRuntimeOptions = {},
): Harness {
  const server = createFakeServer(handler)
  const clock = createClock()
  const client = createClientInternal({
    fetch: server.fetch,
    now: () => clock.now(),
    sleep: (milliseconds, signal) => clock.sleep(milliseconds, signal),
    transactionTimeoutMs: 2_000,
    hostRateLimitMs: 1_000,
    language: "zh_CN",
    ...options,
  })
  return { client, server, clock }
}
