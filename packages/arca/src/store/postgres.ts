import { ArcaConfigurationError } from "../errors";
import { ARCA_LEASE_MS, withLease } from "./lock";
import { type ArcaStore, storeCall } from "./types";

type Row = { key?: string; value?: string };
/** Uses the caller's SQL client; provision the table before use. */
export function createPostgresStore({
  query,
  table = "arca_store",
}: {
  query: (text: string, params: string[]) => Promise<Row[] | { rows: Row[] }>;
  table?: string;
}): ArcaStore {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
    throw new ArcaConfigurationError("Invalid ARCA store table identifier.");
  }
  const name = `"${table}"`;
  const lease = Math.round(ARCA_LEASE_MS / 1000);
  const run = (text: string, params: string[]) =>
    storeCall(async () => {
      const result = await query(text, params);
      return Array.isArray(result) ? result : result.rows;
    });
  return {
    async get(key) {
      return (
        (await run(`SELECT value FROM ${name} WHERE key = $1`, [key]))[0]
          ?.value ?? null
      );
    },
    async set(key, value) {
      await run(
        `INSERT INTO ${name} (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, value]
      );
    },
    async add(key, value) {
      return (
        (
          await run(
            `INSERT INTO ${name} (key, value) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING key`,
            [key, value]
          )
        ).length > 0
      );
    },
    async delete(key) {
      await run(`DELETE FROM ${name} WHERE key = $1`, [key]);
    },
    withLock(key, fn) {
      // A lease row, not an advisory lock: it survives a transaction-mode
      // pooler, where a session-scoped lock would be taken on another backend.
      return withLease(
        key,
        {
          async acquire(owner) {
            const taken = await run(
              `INSERT INTO ${name} (key, value) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING key`,
              [key, owner]
            );
            if (taken.length > 0) {
              return true;
            }
            const expired = await run(
              `UPDATE ${name} SET value = $2, updated_at = now() WHERE key = $1 AND updated_at < now() - interval '${lease} seconds' RETURNING key`,
              [key, owner]
            );
            return expired.length > 0;
          },
          async renew(owner) {
            await run(
              `UPDATE ${name} SET updated_at = now() WHERE key = $1 AND value = $2`,
              [key, owner]
            );
          },
          async release(owner) {
            await run(`DELETE FROM ${name} WHERE key = $1 AND value = $2`, [
              key,
              owner,
            ]);
          },
        },
        fn
      );
    },
  };
}
