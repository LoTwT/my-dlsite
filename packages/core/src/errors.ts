export type TransportFailure = "network" | "timeout"
export type ManifestMismatch = "base-url" | "revision" | "hash" | "unknown"

export class CoreError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = code
    this.code = code
  }
}

export class TransportError extends CoreError {
  readonly reason: TransportFailure

  constructor(reason: TransportFailure) {
    super("TransportError", `Transport request failed (${reason}).`)
    this.reason = reason
  }
}

export class Aborted extends CoreError {
  constructor() {
    super("Aborted", "The operation was aborted.")
  }
}

export class SessionChanged extends CoreError {
  constructor() {
    super(
      "SessionChanged",
      "The session was replaced while the operation was running.",
    )
  }
}

export class StaleManifest extends CoreError {
  readonly workId: string
  readonly reason: ManifestMismatch

  constructor(workId: string, reason: ManifestMismatch) {
    super(
      "StaleManifest",
      `The track does not match the current manifest (${reason}).`,
    )
    this.workId = workId
    this.reason = reason
  }
}

export class RateLimited extends CoreError {
  readonly retryAfterMs: number | undefined

  constructor(retryAfterMs?: number) {
    super("RateLimited", "The service asked the client to slow down.")
    this.retryAfterMs = retryAfterMs
  }
}

export class HttpError extends CoreError {
  readonly status: number
  readonly endpoint: string

  constructor(status: number, endpoint: string) {
    super("HttpError", `HTTP ${status} for ${endpoint}.`)
    this.status = status
    this.endpoint = endpoint
  }
}

export class UnexpectedResponse extends CoreError {
  readonly endpoint: string
  readonly diagnostic: string

  constructor(endpoint: string, diagnostic: string) {
    super(
      "UnexpectedResponse",
      `Unexpected response for ${endpoint} (${diagnostic}).`,
    )
    this.endpoint = endpoint
    this.diagnostic = diagnostic
  }
}

export class AuthRequired extends CoreError {
  readonly endpoint: string | undefined

  constructor(endpoint?: string) {
    super("AuthRequired", "A valid Play session is required.")
    this.endpoint = endpoint
  }
}

export class NotEntitled extends CoreError {
  readonly workId: string | undefined

  constructor(workId?: string) {
    super("NotEntitled", "The account is not entitled to this work.")
    this.workId = workId
  }
}

export class NotFound extends CoreError {
  readonly workId: string | undefined

  constructor(workId?: string) {
    super("NotFound", "The requested work was not found.")
    this.workId = workId
  }
}

export class GrantExpired extends CoreError {
  readonly workId: string

  constructor(workId: string) {
    super("GrantExpired", "The access grant has already expired.")
    this.workId = workId
  }
}

export class UnsupportedDelivery extends CoreError {
  readonly workId: string | undefined
  readonly reason: string

  constructor(reason: string, workId?: string) {
    super("UnsupportedDelivery", `This delivery is not supported (${reason}).`)
    this.workId = workId
    this.reason = reason
  }
}

export class InvalidInput extends CoreError {
  readonly diagnostic: string

  constructor(diagnostic: string) {
    super("InvalidInput", `Invalid input (${diagnostic}).`)
    this.diagnostic = diagnostic
  }
}

export class IncompleteLibrary extends CoreError {
  readonly expected: number
  readonly received: number

  constructor(expected: number, received: number) {
    super(
      "IncompleteLibrary",
      `The library response is incomplete (expected ${expected}, received ${received}).`,
    )
    this.expected = expected
    this.received = received
  }
}
