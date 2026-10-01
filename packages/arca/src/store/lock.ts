import { randomUUID } from "node:crypto";
import { ArcaLockTimeoutError } from "../errors";
import type { ArcaLockOptions } from "./types";

/**
 * Lease duration and renewal are internal. A holder renews while it works, so
 * the lease only expires when its process is gone, and a caller never tunes it.
 */
export const ARCA_LEASE_MS = 60_000;
const RENEW_MS = 20_000;
const POLL_MS = 50;
const MAX_WAIT_MS = 2 * ARCA_LEASE_MS;

/** One lease backend: acquire, keep alive, and give back only what it owns. */
export type ArcaLeaseDriver = {
  acquire(owner: string): Promise<boolean>;
  renew(owner: string): Promise<void>;
  release(owner: string): Promise<void>;
};

/**
 * Runs `fn` while holding a lease other processes honor. A holder that dies
 * loses the lease when it expires; a holder that works keeps renewing it. The
 * caller's signal only stops the wait: once the lease is taken, `fn` runs.
 */
export async function withLease<T>(
  key: string,
  driver: ArcaLeaseDriver,
  fn: () => Promise<T>,
  { signal }: ArcaLockOptions = {}
): Promise<T> {
  const owner = randomUUID();
  const deadline = Date.now() + MAX_WAIT_MS;
  throwIfAborted(key, signal);
  let held = await driver.acquire(owner);
  while (!held) {
    if (Date.now() >= deadline) {
      throw new ArcaLockTimeoutError(
        `ARCA store lock ${key} stayed held; no work was attempted.`,
        { reason: "held" }
      );
    }
    // An abort ends the wait early; the check below reports it.
    await delay(POLL_MS + Math.floor(Math.random() * POLL_MS), signal);
    throwIfAborted(key, signal);
    held = await driver.acquire(owner);
  }
  if (signal?.aborted) {
    // The signal fired while the winning acquire was in flight: give the
    // lease back before any work, so the caller's deadline still holds.
    await driver.release(owner).catch(() => undefined);
    throwIfAborted(key, signal);
  }
  const renewal = setInterval(() => {
    driver.renew(owner).catch(() => undefined);
  }, RENEW_MS);
  renewal.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(renewal);
    await driver.release(owner).catch(() => undefined);
  }
}

/** Stops a wait for a lock the caller no longer wants. Nothing was taken. */
export function throwIfAborted(key: string, signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ArcaLockTimeoutError(
      `Stopped waiting for ARCA store lock ${key}: the caller's signal aborted; no work was attempted.`,
      { reason: "aborted", cause: signal.reason }
    );
  }
}

/** Sleeps between polls, and wakes early when the signal aborts. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    // An abort already past never fires again: skip the sleep.
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", wake);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener("abort", wake, { once: true });
  });
}
