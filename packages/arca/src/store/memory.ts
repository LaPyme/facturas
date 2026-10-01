import { abortable } from "../internal/abort";
import { throwIfAborted } from "./lock";
import type { ArcaStore } from "./types";

/** In-process store for tests; reservations do not survive a restart. */
export function createMemoryStore(): ArcaStore {
  const values = new Map<string, string>();
  const locks = new Map<string, Promise<void>>();
  return {
    get: (key) => Promise.resolve(values.get(key) ?? null),
    set(key, value) {
      values.set(key, value);
      return Promise.resolve();
    },
    add(key, value) {
      if (values.has(key)) {
        return Promise.resolve(false);
      }
      values.set(key, value);
      return Promise.resolve(true);
    },
    delete(key) {
      values.delete(key);
      return Promise.resolve();
    },
    async withLock(key, fn, { signal } = {}) {
      throwIfAborted(key, signal);
      const previous = locks.get(key) ?? Promise.resolve();
      let release: () => void = () => undefined;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      const queued = previous.catch(() => undefined).then(() => current);
      locks.set(key, queued);
      // An abort ends the wait early; the check below reports it.
      await abortable(
        previous.catch(() => undefined),
        signal
      ).catch(() => undefined);
      if (signal?.aborted) {
        // Hand the turn on: whoever queued behind this call waits for it.
        release();
        if (locks.get(key) === queued) {
          locks.delete(key);
        }
        throwIfAborted(key, signal);
      }
      try {
        return await fn();
      } finally {
        release();
        if (locks.get(key) === queued) {
          locks.delete(key);
        }
      }
    },
  };
}
