import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Tests run against the SDK source, so a clean checkout needs no build.
    alias: {
      facturas: fileURLToPath(new URL("../arca/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    testTimeout: 30_000,
  },
});
