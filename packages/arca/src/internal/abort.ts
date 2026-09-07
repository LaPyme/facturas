import { ArcaTransportError } from "../errors";

/** The caller's deadline, reported as a transport failure with its reason. */
export function abortedError(signal?: AbortSignal): ArcaTransportError {
  return new ArcaTransportError("The ARCA call was aborted", {
    cause: signal?.reason,
  });
}

/**
 * Stops waiting when the caller's deadline fires. Shared work, such as a WSAA
 * login another call is also waiting for, keeps running for its other waiters.
 */
export function abortable<T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    // The caller still owns the promise; keep its rejection handled.
    promise.catch(() => undefined);
    return Promise.reject(abortedError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortedError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}
