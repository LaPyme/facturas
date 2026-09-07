import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import forge from "node-forge";
import { afterEach, describe, expect, it } from "vitest";
import { runCert } from "./cert";
import { createArcaCsrMaterial } from "./csr";
import { type CliIo, type CliOutputStream, createWriter } from "./output";

const TAX_ID = "20123456786";
const created: string[] = [];

afterEach(() => {
  for (const directory of created.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("runCert", () => {
  it("saves the pasted certificate next to the key and points at check", async () => {
    const context = createTestIo();
    const material = writeMaterial(context.directory, "test");
    const pem = certificateFor(material.privateKeyPem);

    const running = runCert(
      context.io,
      { dir: context.directory },
      createWriter(context.io.stdout, { color: false })
    );
    context.stdin.write(pem);

    expect(await running).toBe(0);
    expect(readFileSync(join(context.directory, "arca-test.crt"), "utf8")).toBe(
      pem
    );
    expect(context.stdout()).toMatchInlineSnapshot(`
      "✓ arca-test.crt          certificado guardado, vence 2027-09-07

      Después:

        $ npx facturas check
      "
    `);
  });

  it("prints the prompt and the way out on a terminal", async () => {
    const context = createTestIo({ tty: true });
    const material = writeMaterial(context.directory, "test");

    const running = runCert(
      context.io,
      { dir: context.directory },
      createWriter(context.io.stdout, { color: false })
    );
    context.stdin.write(certificateFor(material.privateKeyPem));

    expect(await running).toBe(0);
    expect(context.stdout()).toContain(
      "Pegá el certificado que te dio ARCA. Termina solo al ver"
    );
    expect(context.stdout()).toContain("Ctrl-C para salir.");
    expect(context.stdout()).toContain("> ");
  });

  it("takes the CUIT from the CSR and refuses another one", async () => {
    const context = createTestIo();
    const material = writeMaterial(context.directory, "test");

    const running = runCert(
      context.io,
      { dir: context.directory },
      createWriter(context.io.stdout, { color: false })
    );
    context.stdin.write(
      certificateFor(material.privateKeyPem, { taxId: "20111111112" })
    );

    expect(await running).toBe(1);
    expect(context.stderr()).toBe(
      "El certificado es de otro CUIT: 20111111112.\n"
    );
    expect(existsSync(join(context.directory, "arca-test.crt"))).toBe(false);
  });

  it("accepts any CUIT when the CSR is not there any more", async () => {
    const context = createTestIo();
    const material = writeMaterial(context.directory, "test");
    rmSync(join(context.directory, "arca-test.csr"));

    const running = runCert(
      context.io,
      { dir: context.directory },
      createWriter(context.io.stdout, { color: false })
    );
    context.stdin.write(
      certificateFor(material.privateKeyPem, { taxId: "20111111112" })
    );

    expect(await running).toBe(0);
    expect(existsSync(join(context.directory, "arca-test.crt"))).toBe(true);
  });

  it("ignores a CSR it cannot parse", async () => {
    const context = createTestIo();
    const material = writeMaterial(context.directory, "test");
    writeFileSync(join(context.directory, "arca-test.csr"), "no soy un CSR");

    const running = runCert(
      context.io,
      { dir: context.directory },
      createWriter(context.io.stdout, { color: false })
    );
    context.stdin.write(certificateFor(material.privateKeyPem));

    expect(await running).toBe(0);
  });

  it("refuses a certificate that belongs to another key", async () => {
    const context = createTestIo();
    writeMaterial(context.directory, "test");

    const running = runCert(
      context.io,
      { dir: context.directory },
      createWriter(context.io.stdout, { color: false })
    );
    context.stdin.write(certificateFor(OTHER_KEY_PEM));

    expect(await running).toBe(1);
    expect(context.stderr()).toBe(
      "El certificado no corresponde a arca-test.key. ¿Subiste otro CSR?\n"
    );
    expect(existsSync(join(context.directory, "arca-test.crt"))).toBe(false);
  });

  it("says so when the key on disk is not a PEM", async () => {
    const context = createTestIo();
    const material = writeMaterial(context.directory, "test");
    writeFileSync(join(context.directory, "arca-test.key"), "no soy una clave");

    const running = runCert(
      context.io,
      { dir: context.directory },
      createWriter(context.io.stdout, { color: false })
    );
    context.stdin.write(certificateFor(material.privateKeyPem));

    expect(await running).toBe(1);
    expect(context.stderr()).toBe(
      "No pude leer arca-test.key como clave PEM.\n"
    );
  });

  it("asks again when the paste is not a certificate, three times", async () => {
    const context = createTestIo({ tty: true });
    writeMaterial(context.directory, "test");

    const running = runCert(
      context.io,
      { dir: context.directory },
      createWriter(context.io.stdout, { color: false })
    );
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await waitFor(() => context.stdout().split("> ").length - 1 === attempt);
      context.stdin.write("hola\n-----END CERTIFICATE-----\n");
    }

    expect(await running).toBe(1);
    expect(context.stderr().split("Eso no parece").length - 1).toBe(3);
    expect(context.stdout()).toContain(
      "Cuando tengas el certificado, guardalo acá como arca-test.crt,"
    );
  });

  it("exits 0 saying how to come back when nobody pastes anything", async () => {
    const context = createTestIo({ tty: true });
    writeMaterial(context.directory, "test");

    const running = runCert(
      context.io,
      { dir: context.directory },
      createWriter(context.io.stdout, { color: false })
    );
    context.stdin.end();

    expect(await running).toBe(0);
    expect(context.stdout()).toContain(
      "Cuando lo tengas, volvé a correr npx facturas cert, o"
    );
    expect(existsSync(join(context.directory, "arca-test.crt"))).toBe(false);
  });

  it("says which init to run when there is no key", async () => {
    const context = createTestIo();

    const code = await runCert(
      context.io,
      { dir: context.directory },
      createWriter(context.io.stdout, { color: false })
    );

    expect(code).toBe(1);
    expect(context.stderr()).toBe(
      `No encontré arca-test.key ni arca-production.key en este directorio.
Generá la clave y el CSR con npx facturas init.
`
    );
  });

  it("does not guess when both keys are there", async () => {
    const context = createTestIo();
    writeMaterial(context.directory, "test");
    writeMaterial(context.directory, "production");

    const code = await runCert(
      context.io,
      { dir: context.directory },
      createWriter(context.io.stdout, { color: false })
    );

    expect(code).toBe(1);
    expect(context.stderr()).toContain(
      "Están arca-test.key y arca-production.key en este directorio"
    );
    expect(context.stderr()).toContain(
      "Elegí con --env test o --env production."
    );
  });

  it("takes the pair --env names when both are there", async () => {
    const context = createTestIo();
    writeMaterial(context.directory, "test");
    const material = writeMaterial(context.directory, "production");

    const running = runCert(
      context.io,
      { dir: context.directory, env: "production" },
      createWriter(context.io.stdout, { color: false })
    );
    context.stdin.write(certificateFor(material.privateKeyPem));

    expect(await running).toBe(0);
    expect(existsSync(join(context.directory, "arca-production.crt"))).toBe(
      true
    );
    expect(existsSync(join(context.directory, "arca-test.crt"))).toBe(false);
  });

  it("refuses an environment ARCA does not have", async () => {
    const context = createTestIo();

    const code = await runCert(
      context.io,
      { dir: context.directory, env: "staging" },
      createWriter(context.io.stdout, { color: false })
    );

    expect(code).toBe(2);
    expect(context.stderr()).toBe(
      "Falta el entorno. Pasá --env test o --env production.\n"
    );
  });

  it("does not overwrite a certificate without --force", async () => {
    const context = createTestIo();
    writeMaterial(context.directory, "test");
    writeFileSync(join(context.directory, "arca-test.crt"), "no me pises");

    const code = await runCert(
      context.io,
      { dir: context.directory },
      createWriter(context.io.stdout, { color: false })
    );

    expect(code).toBe(1);
    expect(context.stderr()).toBe(
      "Ya existe arca-test.crt. Usá --force para sobrescribir.\n"
    );
    expect(readFileSync(join(context.directory, "arca-test.crt"), "utf8")).toBe(
      "no me pises"
    );
  });

  it("overwrites with --force", async () => {
    const context = createTestIo();
    const material = writeMaterial(context.directory, "test");
    writeFileSync(join(context.directory, "arca-test.crt"), "no me pises");

    const running = runCert(
      context.io,
      { dir: context.directory, force: true },
      createWriter(context.io.stdout, { color: false })
    );
    context.stdin.write(certificateFor(material.privateKeyPem));

    expect(await running).toBe(0);
    expect(
      readFileSync(join(context.directory, "arca-test.crt"), "utf8")
    ).toContain("BEGIN CERTIFICATE");
  });

  it("takes an absolute --dir as it is", async () => {
    const context = createTestIo();
    const material = writeMaterial(context.directory, "test");

    const running = runCert(
      context.io,
      { dir: context.directory },
      createWriter(context.io.stdout, { color: false })
    );
    context.stdin.write(certificateFor(material.privateKeyPem));

    expect(await running).toBe(0);
    expect(existsSync(join(context.directory, "arca-test.crt"))).toBe(true);
  });

  it("ignores whatever came before the BEGIN line", async () => {
    const context = createTestIo();
    const material = writeMaterial(context.directory, "test");
    const pem = certificateFor(material.privateKeyPem);

    const running = runCert(
      context.io,
      { dir: context.directory },
      createWriter(context.io.stdout, { color: false })
    );
    context.stdin.write(`\n\nCertificado emitido:\n${pem}`);

    expect(await running).toBe(0);
    expect(readFileSync(join(context.directory, "arca-test.crt"), "utf8")).toBe(
      pem
    );
  });
});

/** The pair `init` leaves in a directory, without running `init` itself. */
function writeMaterial(directory: string, environment: string) {
  const material = createArcaCsrMaterial({
    taxId: TAX_ID,
    commonName: "facturas",
    organization: TAX_ID,
  });
  writeFileSync(
    join(directory, `arca-${environment}.key`),
    material.privateKeyPem
  );
  writeFileSync(join(directory, `arca-${environment}.csr`), material.csrPem);
  return material;
}

const OTHER_KEY_PEM = forge.pki.privateKeyToPem(
  forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x01_00_01 }).privateKey
);

/** The certificate ARCA answers with, signed by the key it was asked for. */
function certificateFor(
  privateKeyPem: string,
  options: { taxId?: string } = {}
): string {
  const key = forge.pki.privateKeyFromPem(privateKeyPem);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = forge.pki.setRsaPublicKey(key.n, key.e);
  certificate.serialNumber = "01";
  certificate.validity.notBefore = new Date("2026-09-07T00:00:00Z");
  certificate.validity.notAfter = new Date("2027-09-07T00:00:00Z");
  certificate.setSubject([
    { name: "commonName", value: "facturas" },
    { name: "serialNumber", value: `CUIT ${options.taxId ?? TAX_ID}` },
  ]);
  certificate.setIssuer([{ name: "commonName", value: "ARCA" }]);
  certificate.sign(key, forge.md.sha256.create());
  return forge.pki.certificateToPem(certificate).replace(/\r\n/g, "\n");
}

function createTestIo(options: { tty?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "facturas-cert-"));
  created.push(directory);
  const out: string[] = [];
  const err: string[] = [];
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  if (options.tty === true) {
    stdin.isTTY = true;
  }
  const io: CliIo = {
    stdout: { write: (chunk) => out.push(chunk) } as CliOutputStream,
    stderr: { write: (chunk) => err.push(chunk) } as CliOutputStream,
    stdin,
    env: {},
    cwd: directory,
    cacheDir: directory,
    now: () => new Date("2026-09-07T00:00:00Z"),
    copyToClipboard: () => Promise.resolve(false),
    createClient: () => {
      throw new Error("cert never builds a client");
    },
    createAuth: () => {
      throw new Error("cert never logs in");
    },
  };
  return {
    io,
    directory,
    stdin,
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

/** Waits for the next prompt before answering it: one readline at a time. */
async function waitFor(condition: () => boolean, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise((settle) => setImmediate(settle));
  }
  throw new Error("the prompt never appeared");
}
