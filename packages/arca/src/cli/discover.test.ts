import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  certificateFileName,
  discoverCredentials,
  privateKeyFileName,
} from "./discover";

const created: string[] = [];

afterEach(() => {
  for (const directory of created.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("discoverCredentials", () => {
  it("finds nothing in an empty directory", () => {
    expect(discoverCredentials(directoryWith([]))).toEqual({ kind: "none" });
  });

  it("finds the only pair there is, and its environment", () => {
    const directory = directoryWith([
      ["arca-test.crt", "certificado"],
      ["arca-test.key", "clave"],
    ]);

    expect(discoverCredentials(directory)).toEqual({
      kind: "found",
      credentials: {
        environment: "test",
        certificateFile: "arca-test.crt",
        keyFile: "arca-test.key",
        certificatePem: "certificado",
        privateKeyPem: "clave",
      },
    });
  });

  it("finds the production pair the same way", () => {
    const directory = directoryWith([
      ["arca-production.crt", "certificado"],
      ["arca-production.key", "clave"],
    ]);

    const found = discoverCredentials(directory);

    expect(found.kind === "found" && found.credentials.environment).toBe(
      "production"
    );
  });

  it("refuses to choose when both environments are there", () => {
    const directory = directoryWith([
      ["arca-test.crt", "c"],
      ["arca-test.key", "k"],
      ["arca-production.crt", "c"],
      ["arca-production.key", "k"],
    ]);

    expect(discoverCredentials(directory)).toEqual({
      kind: "ambiguous",
      files: ["arca-test.crt", "arca-production.crt"],
    });
  });

  it("takes the environment the caller already chose", () => {
    const directory = directoryWith([
      ["arca-test.crt", "c"],
      ["arca-test.key", "k"],
      ["arca-production.crt", "otro"],
      ["arca-production.key", "otra"],
    ]);

    const found = discoverCredentials(directory, "production");

    expect(found.kind === "found" && found.credentials.certificatePem).toBe(
      "otro"
    );
  });

  it("names the certificate that has not arrived yet", () => {
    const directory = directoryWith([["arca-test.key", "clave"]]);

    expect(discoverCredentials(directory)).toEqual({
      kind: "incomplete",
      present: "arca-test.key",
      missing: "arca-test.crt",
      missingKind: "certificate",
    });
  });

  it("names the key that is not next to the certificate", () => {
    const directory = directoryWith([["arca-production.crt", "certificado"]]);

    expect(discoverCredentials(directory)).toEqual({
      kind: "incomplete",
      present: "arca-production.crt",
      missing: "arca-production.key",
      missingKind: "key",
    });
  });

  it("looks only at the chosen environment", () => {
    const directory = directoryWith([
      ["arca-test.crt", "c"],
      ["arca-test.key", "k"],
    ]);

    expect(discoverCredentials(directory, "production")).toEqual({
      kind: "none",
    });
  });

  it("trims what it reads, because a PEM ends in a newline", () => {
    const directory = directoryWith([
      ["arca-test.crt", "certificado\n"],
      ["arca-test.key", "clave\n"],
    ]);

    const found = discoverCredentials(directory);

    expect(found.kind === "found" && found.credentials.certificatePem).toBe(
      "certificado"
    );
  });
});

describe("file names", () => {
  it("are the ones init writes", () => {
    expect(certificateFileName("test")).toBe("arca-test.crt");
    expect(privateKeyFileName("production")).toBe("arca-production.key");
  });
});

function directoryWith(files: [string, string][]): string {
  const directory = mkdtempSync(join(tmpdir(), "facturas-discover-"));
  created.push(directory);
  for (const [name, contents] of files) {
    writeFileSync(join(directory, name), contents);
  }
  return directory;
}
