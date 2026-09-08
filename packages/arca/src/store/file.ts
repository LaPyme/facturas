import { createHash, randomUUID } from "node:crypto";
import {
  type FileHandle,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { ARCA_LEASE_MS, type ArcaLeaseDriver, withLease } from "./lock";
import { type ArcaStore, storeCall } from "./types";

type Holder = { owner: string; expiresAt: string };
type HolderFile = { raw: string; value: Holder | null };

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
    withLock: (key, fn) =>
      // A lock directory: mkdir is the atomic claim on every POSIX filesystem
      // and on Windows, and the holder file inside carries the lease.
      withLease(key, fileLease(`${path(key)}.lock`, ensure), fn),
  };
}

function fileLease(
  directory: string,
  ensure: () => Promise<unknown>
): ArcaLeaseDriver {
  const holder = join(directory, "holder");
  const claim = (owner: string) =>
    JSON.stringify({
      owner,
      expiresAt: new Date(Date.now() + ARCA_LEASE_MS).toISOString(),
    } satisfies Holder);
  return {
    acquire: (owner) =>
      storeCall(async () => {
        await ensure();
        if (!(await createDirectory(directory))) {
          const current = await readHolder(holder);
          if (await stillHeld(directory, current?.value ?? null)) {
            return false;
          }
          if (current) {
            await retireHolder(directory, holder, current.raw);
          } else {
            await removeEmptyDirectory(directory);
          }
          // Do not recreate the directory in the same attempt. Another
          // contender may still be removing the stale path it also observed.
          // The lease retry makes every contender claim it again with mkdir.
          return false;
        }
        return await writeHolder(holder, claim(owner));
      }),
    renew: (owner) => storeCall(() => renewHolder(holder, owner, claim(owner))),
    release: (owner) =>
      storeCall(async () => {
        const current = await readHolder(holder);
        if (current?.value?.owner === owner) {
          await retireHolder(directory, holder, current.raw);
        }
      }),
  };
}

async function createDirectory(directory: string): Promise<boolean> {
  try {
    await mkdir(directory);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

async function writeHolder(holder: string, value: string): Promise<boolean> {
  try {
    await writeFile(holder, value, { mode: 0o600, flag: "wx" });
    return true;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "EEXIST" ||
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

async function readHolder(holder: string): Promise<HolderFile | null> {
  let raw: string;
  try {
    raw = await readFile(holder, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  try {
    return { raw, value: JSON.parse(raw) as Holder };
  } catch {
    return { raw, value: null };
  }
}

async function renewHolder(
  holder: string,
  owner: string,
  value: string
): Promise<void> {
  let file: FileHandle;
  try {
    file = await open(holder, "r+");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  try {
    let current: Holder | null = null;
    try {
      current = JSON.parse(await file.readFile("utf8")) as Holder;
    } catch {
      // An invalid claim is not ours to renew.
    }
    if (current?.owner === owner) {
      await file.truncate(0);
      await file.write(value, 0, "utf8");
    }
  } finally {
    await file.close();
  }
}

async function retireHolder(
  directory: string,
  holder: string,
  expected: string
): Promise<void> {
  const retired = `${directory}.${randomUUID()}.stale`;
  try {
    await rename(holder, retired);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  let removed = false;
  try {
    if ((await readFile(retired, "utf8")) !== expected) {
      return;
    }
    try {
      await rmdir(directory);
      removed = true;
    } catch (error) {
      if (!isDirectoryContention(error)) {
        throw error;
      }
    }
  } finally {
    if (!removed) {
      await restoreHolder(retired, holder);
    }
    await unlink(retired).catch(() => undefined);
  }
}

async function restoreHolder(retired: string, holder: string): Promise<void> {
  try {
    await link(retired, holder);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "ENOENT") {
      throw error;
    }
  }
}

async function removeEmptyDirectory(directory: string): Promise<void> {
  try {
    await rmdir(directory);
  } catch (error) {
    if (!isDirectoryContention(error)) {
      throw error;
    }
  }
}

function isDirectoryContention(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST";
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
