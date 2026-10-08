import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  target: "node22",
  format: ["esm"],
  outExtension() {
    return { js: ".mjs" };
  },
  // The build resolves `facturas` as the published package, never its source:
  // tsconfig.json maps it to ../arca/src for typechecking only.
  tsconfig: "tsconfig.build.json",
  // tsup injects `baseUrl` into the declaration build, which TypeScript 6 deprecates.
  dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
  sourcemap: true,
  clean: true,
  skipNodeModulesBundle: true,
  external: ["facturas", "react", "@react-pdf/renderer", "qrcode"],
  outDir: "dist",
});
