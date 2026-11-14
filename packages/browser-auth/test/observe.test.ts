import { createServer } from "node:http"
import type { Server, ServerResponse } from "node:http"
import { chromium } from "playwright"
import type { Browser } from "playwright"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { hasPlayIdentity, waitForPlayIdentity } from "../src/observe.js"

let browser: Browser
const servers: Server[] = []
beforeAll(async () => {
  browser = await chromium.launch({ headless: false })
})
afterEach(async () => {
  await Promise.all(browser.contexts().map((context) => context.close()))
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections()
          server.close((error) =>
            error === undefined ? resolve() : reject(error),
          )
        }),
    ),
  )
})
afterAll(async () => {
  await browser.close()
})

async function syntheticPage(
  options: {
    body?: string
    status?: number
    delayed?: boolean
    child?: boolean
    noRequest?: boolean
    query?: boolean
    post?: boolean
    delayDocument?: boolean
  } = {},
) {
  let authorizeCalls = 0
  let finish: (() => void) | undefined
  let finishDocument: (() => void) | undefined
  let requestStarted: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    requestStarted = resolve
  })
  const server = createServer((request, response: ServerResponse) => {
    if (request.url?.startsWith("/api/authorize")) {
      authorizeCalls += 1
      response.writeHead(options.status ?? 200, {
        "content-type": "application/json",
      })
      response.flushHeaders()
      finish = () => {
        response.end(
          options.body ?? '{"customer_id":"SYNTHETIC_IDENTITY_SECRET"}',
        )
      }
      requestStarted()
      if (!options.delayed) finish()
      return
    }
    const fetchIdentity = `<script>fetch("/api/authorize${options.query ? "?extra=1" : ""}",{method:"${options.post ? "POST" : "GET"}"}).then(r=>r.json()).catch(()=>{});</script>`
    const content =
      request.url === "/next"
        ? "Next document"
        : options.noRequest
          ? '<script>localStorage.setItem("play",JSON.stringify({customer_id:"OLD_IDENTITY_SECRET"}));document.cookie="synthetic=OLD";</script>'
          : options.child && request.url !== "/child"
            ? '<iframe src="/child"></iframe>'
            : fetchIdentity
    response.writeHead(200, { "content-type": "text/html" })
    const html = `<!doctype html><link rel="icon" href="data:,"><title>Synthetic</title>${content}`
    if (options.delayDocument) {
      response.write(html)
      finishDocument = () => {
        response.end("<p>Document complete</p>")
      }
    } else response.end(html)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string")
    throw new Error("missing loopback address")
  const origin = `http://127.0.0.1:${address.port}`
  const context = await browser.newContext()
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.abort(),
  )
  const page = await context.newPage()
  const controller = new AbortController()
  const observed = waitForPlayIdentity(page, controller.signal, {
    origin,
    authorizePath: "/api/authorize",
  })
  let complete = false
  void observed.then(
    () => {
      complete = true
    },
    () => {},
  )
  await page.goto(origin, {
    waitUntil: options.delayDocument ? "commit" : "domcontentloaded",
  })
  return {
    page,
    origin,
    observed,
    controller,
    started,
    finish: () => finish?.(),
    finishDocument: () => finishDocument?.(),
    calls: () => authorizeCalls,
    complete: () => complete,
  }
}

describe("first-party identity predicate", () => {
  it.each([
    { customer_id: 1 },
    { production_id: "synthetic" },
    { admin_id: 5 },
  ])("recognizes supported identity fields", (value) => {
    expect(hasPlayIdentity(value)).toBe(true)
  })
  it.each([
    null,
    [],
    {},
    { customer_id: 0 },
    { customer_id: false },
    { customer_id: " " },
    { customer_id: {} },
    { other_id: "SYNTHETIC_SECRET" },
  ])("rejects unproven identities", (value) => {
    expect(hasPlayIdentity(value)).toBe(false)
  })
})

it("observes the page's one natural response after navigation without issuing its own authorize request", async () => {
  const fixture = await syntheticPage()
  await expect(fixture.observed).resolves.toBeUndefined()
  expect(fixture.calls()).toBe(1)
  expect(fixture.page.url()).toBe(`${fixture.origin}/`)
})

it.each([
  { body: "[]" },
  { body: "{}" },
  { body: "null" },
  { body: "invalid IDENTITY_SECRET" },
  { status: 403 },
  { child: true },
  { noRequest: true },
  { query: true },
  { post: true },
])("keeps a nonmatching page unproven until canceled", async (options) => {
  const fixture = await syntheticPage(options)
  if (!options.noRequest) await fixture.started
  await fixture.page.waitForLoadState("load")
  await fixture.page.waitForTimeout(30)
  expect(fixture.complete()).toBe(false)
  fixture.controller.abort()
  await expect(fixture.observed).rejects.toMatchObject({ code: "canceled" })
  expect(
    JSON.stringify(await fixture.observed.catch((error: unknown) => error)),
  ).not.toContain("IDENTITY_SECRET")
})

it("does not accept a late identity body from the previous document", async () => {
  const fixture = await syntheticPage({ delayed: true })
  await fixture.started
  await fixture.page.goto(`${fixture.origin}/next`)
  fixture.finish()
  await fixture.page.waitForTimeout(30)
  expect(fixture.complete()).toBe(false)
  fixture.controller.abort()
  await expect(fixture.observed).rejects.toMatchObject({ code: "canceled" })
})

it("waits for the current document's DOM boundary after a positive identity body", async () => {
  const fixture = await syntheticPage({ delayDocument: true })
  await fixture.started
  await fixture.page.waitForTimeout(30)
  expect(fixture.complete()).toBe(false)
  fixture.finishDocument()
  await expect(fixture.observed).resolves.toBeUndefined()
  expect(fixture.calls()).toBe(1)
})

it("rejects a page close during the identity body read", async () => {
  const fixture = await syntheticPage({ delayed: true })
  await fixture.started
  await fixture.page.close()
  await expect(fixture.observed).rejects.toMatchObject({
    code: "browser-closed",
  })
})
