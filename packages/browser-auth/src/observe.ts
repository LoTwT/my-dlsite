import type { Frame, Page, Request, Response } from "playwright"
import { BrowserLoginError } from "./errors.js"
import { untilAborted } from "./transaction.js"

export const PLAY_ORIGIN = "https://play.dlsite.com"
const AUTHORIZE_PATH = "/api/authorize"

// auth-resource a() rejects arrays/empty objects; session r() selects these
// identity fields in this order. Values stay in memory and never leave here.
export function hasPlayIdentity(value: unknown): boolean {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length === 0
  )
    return false
  const record = value as Record<string, unknown>
  const identity =
    (Object.hasOwn(record, "customer_id") && record["customer_id"]) ||
    (Object.hasOwn(record, "production_id") && record["production_id"]) ||
    (Object.hasOwn(record, "admin_id") && record["admin_id"])
  return (
    (typeof identity === "string" && identity.trim().length > 0) ||
    (typeof identity === "number" &&
      Number.isFinite(identity) &&
      identity !== 0)
  )
}

interface ObservationTarget {
  origin: string
  authorizePath: string
}

function isPageAtOrigin(page: Page, target: ObservationTarget): boolean {
  try {
    const url = new URL(page.url())
    return (
      url.origin === target.origin &&
      url.username === "" &&
      url.password === "" &&
      !url.pathname.startsWith("/api/")
    )
  } catch {
    return false
  }
}

// The target parameter is internal so real browser tests can use loopback
// pages. The public login function always observes the fixed Play origin.
export async function waitForPlayIdentity(
  page: Page,
  signal: AbortSignal,
  target: ObservationTarget = {
    origin: PLAY_ORIGIN,
    authorizePath: AUTHORIZE_PATH,
  },
): Promise<void> {
  let epoch = 0
  let navigationPending = false
  let active = true
  const requests = new WeakMap<Request, number>()
  let resolveReady: () => void = () => {}
  let rejectClosed: (error: BrowserLoginError) => void = () => {}
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectClosed = reject
  })
  const onNavigation = (frame: Frame) => {
    if (frame === page.mainFrame()) navigationPending = false
  }
  const onRequest = (request: Request) => {
    try {
      if (request.frame() !== page.mainFrame()) return
      if (request.isNavigationRequest()) {
        epoch += 1
        navigationPending = true
        return
      }
      const url = new URL(request.url())
      if (
        !navigationPending &&
        isPageAtOrigin(page, target) &&
        request.method() === "GET" &&
        ["fetch", "xhr"].includes(request.resourceType()) &&
        url.origin === target.origin &&
        url.pathname === target.authorizePath &&
        url.search === "" &&
        url.username === "" &&
        url.password === ""
      )
        requests.set(request, epoch)
    } catch {
      /* Worker requests have no frame and cannot prove page identity. */
    }
  }
  const onResponse = (response: Response) => {
    const requestEpoch = requests.get(response.request())
    if (requestEpoch === undefined || !response.ok()) return
    const inspect = async () => {
      const contentType = response
        .headers()
        ["content-type"]?.split(";", 1)[0]
        ?.trim()
        .toLowerCase()
      if (contentType !== "application/json") return
      const body = await untilAborted(response.body(), signal)
      if (
        body.byteLength > 65_536 ||
        !hasPlayIdentity(JSON.parse(body.toString("utf8")))
      )
        return
      if (
        !active ||
        signal.aborted ||
        requestEpoch !== epoch ||
        navigationPending ||
        !isPageAtOrigin(page, target)
      )
        return
      await untilAborted(
        page.waitForLoadState("domcontentloaded", { timeout: 0 }),
        signal,
      )
      if (
        active &&
        !signal.aborted &&
        requestEpoch === epoch &&
        !navigationPending &&
        isPageAtOrigin(page, target)
      )
        resolveReady()
    }
    // Invalid bodies, canceled reads and vanished pages remain unproven.
    // The bounded wait, close handler or caller signal supplies the outcome.
    void inspect().catch(() => {})
  }
  const onClose = () => rejectClosed(new BrowserLoginError("browser-closed"))
  page.on("request", onRequest)
  page.on("response", onResponse)
  page.on("framenavigated", onNavigation)
  page.once("close", onClose)
  try {
    await untilAborted(ready, signal)
  } finally {
    active = false
    page.off("request", onRequest)
    page.off("response", onResponse)
    page.off("framenavigated", onNavigation)
    page.off("close", onClose)
  }
}

export async function observePlayLogin(
  _context: unknown,
  page: Page,
  signal: AbortSignal,
): Promise<void> {
  const controller = new AbortController()
  const observationSignal = AbortSignal.any([signal, controller.signal])
  // Install listeners synchronously before the first normal navigation. No
  // authorize fetch, poll, bundle execution or localStorage reads are added.
  const ready = waitForPlayIdentity(page, observationSignal)
  try {
    await Promise.all([
      ready,
      untilAborted(
        page.goto(PLAY_ORIGIN, { waitUntil: "domcontentloaded", timeout: 0 }),
        observationSignal,
      ),
    ])
  } finally {
    controller.abort()
  }
}
