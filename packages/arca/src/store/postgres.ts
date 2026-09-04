import { ArcaConfigurationError } from "../errors";
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
  };
}
