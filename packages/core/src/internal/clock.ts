export interface Clock {
  now(): number
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>
}

export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError")
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (milliseconds, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(abortReason(signal))
        return
      }
      const onAbort = () => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
        reject(
          signal === undefined
            ? new DOMException("Aborted", "AbortError")
            : abortReason(signal),
        )
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort)
        resolve()
      }, milliseconds)
      signal?.addEventListener("abort", onAbort, { once: true })
    }),
}

export function abortPromise(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    signal.addEventListener("abort", () => resolve(), { once: true })
  })
}
