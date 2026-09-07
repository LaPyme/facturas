import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { ARCA_LEASE_MS, withLease } from "./lock";
import { type ArcaStore, storeCall } from "./types";

type Holder = { owner: string; expiresAt: string };

/** Persistent store for a single server with a private durable volume. */
export function createFileStore(directory: string): ArcaStore {
  const path = (key: string) =>
    join(directory, createHash("sha256").update(key).digest("hex"));
  const ensure = () => mkdir(directory, { recursive: true, mode: 0o700 });
  return {
    get: (key) =>
      storeCall(async () => {
        try {
          return await readFile(path(key), "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return null;
          }
          throw error;
        }
      }),
    set: (key, value) =>
      storeCall(async () => {
        await ensure();
        const temporary = `${path(key)}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, value, { mode: 0o600, flag: "wx" });
          await rename(temporary, path(key));
        } finally {
          await unlink(temporary).catch(() => undefined);
        }
      }),
    add: (key, value) =>
      storeCall(async () => {
        await ensure();
        try {
          await writeFile(path(key), value, { flag: "wx", mode: 0o600 });
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            return false;
          }
          throw error;
        }
      }),
    delete: (key) =>
      storeCall(async () => {
        try {
          await unlink(path(key));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
      }),
    withLock: (key, fn) => {
      // A lock directory: mkdir is the atomic claim on every POSIX filesystem
      // and on Windows, and the holder file inside carries the lease.
      const directory = `${path(key)}.lock`;
      const holder = join(directory, "holder");
      const claim = (owner: string): Holder => ({
        owner,
        expiresAt: new Date(Date.now() + ARCA_LEASE_MS).toISOString(),
      });
      const readHolder = async (): Promise<Holder | null> => {
        try {
          return JSON.parse(await readFile(holder, "utf8")) as Holder;
        } catch {
          return null;
        }
      };
      const create = async () => {
        try {
          await mkdir(directory);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            return false;
          }
          throw error;
        }
      };
      return withLease(
        key,
        {
          acquire: (owner) =>
            storeCall(async () => {
              await ensure();
              if (!(await create())) {
                if (await stillHeld(directory, await readHolder())) {
                  return false;
                }
                await rm(directory, { recursive: true, force: true });
                if (!(await create())) {
                  return false;
                }
              }
              await writeFile(holder, JSON.stringify(claim(owner)), {
                mode: 0o600,
              });
              // Two processes can free the same stale lock; the holder file
              // decides which one of them actually took it.
              return (await readHolder())?.owner === owner;
            }),
          renew: (owner) =>
            storeCall(async () => {
              if ((await readHolder())?.owner === owner) {
                await writeFile(holder, JSON.stringify(claim(owner)), {
                  mode: 0o600,
                });
              }
            }),
          release: (owner) =>
            storeCall(async () => {
              if ((await readHolder())?.owner === owner) {
                await rm(directory, { recursive: true, force: true });
              }
            }),
        },
        fn
      );
    },
  };
}

/** A directory with no readable holder is still fresh for one lease. */
async function stillHeld(
  directory: string,
  holder: Holder | null
): Promise<boolean> {
  if (holder) {
    return Date.parse(holder.expiresAt) > Date.now();
  }
  try {
    return (await stat(directory)).mtimeMs + ARCA_LEASE_MS > Date.now();
  } catch {
    return false;
  }
}
