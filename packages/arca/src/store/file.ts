import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ArcaStore, storeCall } from "./types";

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
  };
}
