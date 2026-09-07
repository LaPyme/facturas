import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli/main.ts",
    constants: "src/constants.ts",
    index: "src/index.ts",
    errors: "src/errors.ts",
    padron: "src/padron.ts",
    types: "src/types.ts",
    wsfe: "src/wsfe.ts",
    wsmtxca: "src/wsmtxca.ts",
  },
  target: "node20",
  format: ["esm"],
  outExtension() {
    return { js: ".mjs" };
  },
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  skipNodeModulesBundle: true,
  outDir: "dist",
});
