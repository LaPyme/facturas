import { randomUUID } from "node:crypto";
import { ArcaConfigurationError } from "../errors";

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
 * loses the lease when it expires; a holder that works keeps renewing it.
 */
export async function withLease<T>(
  key: string,
  driver: ArcaLeaseDriver,
  fn: () => Promise<T>
): Promise<T> {
  const owner = randomUUID();
  const deadline = Date.now() + MAX_WAIT_MS;
  let held = await driver.acquire(owner);
  while (!held) {
    if (Date.now() >= deadline) {
      throw new ArcaConfigurationError(
        `ARCA store lock ${key} stayed held; no work was attempted.`
      );
    }
    await delay(POLL_MS + Math.floor(Math.random() * POLL_MS));
    held = await driver.acquire(owner);
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
