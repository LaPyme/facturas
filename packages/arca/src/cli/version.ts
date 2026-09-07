import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_DEPTH = 5;

/**
 * Reads the published version from the nearest `package.json`. Walking up is
 * needed because the bundled `dist/cli.mjs` and `src/cli/version.ts` sit at
 * different depths from the manifest.
 */
export function readCliVersion(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    try {
      const raw = readFileSync(join(directory, "package.json"), "utf8");
      const parsed = JSON.parse(raw) as { version?: string };
      if (typeof parsed.version === "string") {
        return parsed.version;
      }
    } catch {
      // Keep walking up: bundled output and source sit at different depths.
    }
    directory = dirname(directory);
  }
  return "0.0.0";
}
