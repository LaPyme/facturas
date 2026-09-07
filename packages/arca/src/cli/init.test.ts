import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import forge from "node-forge";
import { afterEach, describe, expect, it } from "vitest";
import { runInit } from "./init";
import { type CliIo, type CliOutputStream, createWriter } from "./output";

const created: string[] = [];

afterEach(() => {
  for (const directory of created.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("runInit", () => {
  it("creates the target directory when it does not exist", async () => {
    const { io, directory } = createTestIo();
    const nested = join(directory, "creds", "arca");

    const code = await runInit(
      io,
      { cuit: "20123456786", env: "test", dir: nested },
      createWriter(io.stdout, { color: false })
    );

    expect(code).toBe(0);
    expect(existsSync(join(nested, "arca-test.key"))).toBe(true);
  });

  it("writes the key and the CSR and prints the ARCA steps", async () => {
    const { io, stdout, directory } = createTestIo();

    const code = await runInit(
      io,
      { cuit: "20123456786", env: "test", dir: directory },
      createWriter(io.stdout, { color: false })
    );

    expect(code).toBe(0);
    expect(readFileSync(join(directory, "arca-test.key"), "utf8")).toContain(
      "-----BEGIN PRIVATE KEY-----"
    );
    expect(readFileSync(join(directory, "arca-test.csr"), "utf8")).toContain(
      "-----BEGIN CERTIFICATE REQUEST-----"
    );
    expect(stdout()).toMatchInlineSnapshot(`
      "✓ arca-test.key          clave privada RSA 2048, permisos 0600
      ✓ arca-test.csr          CSR para ARCA, CN=facturas

      Listo. Ahora en ARCA, para homologación:

        1. Entrá con clave fiscal en
           https://auth.afip.gob.ar/contribuyente_/login.xhtml
        2. Abrí "WSASS - Autogestión Certificados Homologación" en Mis Servicios.
           Si no está, agregalo en Administrador de Relaciones → Adherir Servicio
           → ARCA → Servicios Interactivos → WSASS, y volvé a entrar. Va con tu
           clave fiscal de persona física, nivel 2 o superior: no es delegable.
        3. En el menú, "Nuevo Certificado":
             Nombre simbólico del DN:    facturas-test
             Solicitud de certificado:   pegá arca-test.csr entero
           Apretá "Crear DN y Obtener Certificado".
           (cat arca-test.csr lo muestra; copiá también las líneas BEGIN y END)
        4. El certificado sale en el cuadro de resultado, de
           -----BEGIN CERTIFICATE----- a -----END CERTIFICATE-----.
           Copialo entero y guardalo acá como arca-test.crt.
        5. En el menú, "Crear autorización a servicio":
             Nombre simbólico del DN a autorizar:   facturas-test
             CUIT representado:                     20123456786
             Servicio al que desea acceder:         wsfe - Facturación Electrónica
           Apretá "Crear Autorización de Acceso".

      Después:

        $ npx facturas check

      Para tu app las variables son ARCA_TAX_ID, ARCA_ENVIRONMENT,
      ARCA_CERTIFICATE_PEM y ARCA_PRIVATE_KEY_PEM; ver docs/inicio-rapido.md.
      "
    `);
  });

  it.runIf(process.platform !== "win32")(
    "writes the private key with mode 0600",
    async () => {
      const { io, directory } = createTestIo();

      await runInit(
        io,
        { cuit: "20123456786", env: "test", dir: directory },
        createWriter(io.stdout, { color: false })
      );

      // biome-ignore lint/suspicious/noBitwiseOperators: POSIX modes are bit flags
      const mode = statSync(join(directory, "arca-test.key")).mode & 0o777;
      expect(mode.toString(8)).toBe("600");
    }
  );

  it("names the files after the environment and prints the production steps", async () => {
    const { io, stdout, directory } = createTestIo();

    await runInit(
      io,
      { cuit: "20123456786", env: "production", dir: directory },
      createWriter(io.stdout, { color: false })
    );

    expect(
      readFileSync(join(directory, "arca-production.key"), "utf8")
    ).toContain("PRIVATE KEY");
    expect(stdout()).toMatchInlineSnapshot(`
      "✓ arca-production.key    clave privada RSA 2048, permisos 0600
      ✓ arca-production.csr    CSR para ARCA, CN=facturas

      Listo. Ahora en ARCA, para producción:

        1. Entrá con clave fiscal en
           https://auth.afip.gob.ar/contribuyente_/login.xhtml
        2. Abrí "Administración de Certificados Digitales" en Mis Servicios.
           Si no está, agregalo en Administrador de Relaciones → Nueva Relación
           → BUSCAR → Servicios Interactivos → Administración de Certificados
           Digitales → Confirmar, y volvé a entrar.
        3. Apretá "Agregar alias":
             Alias:                 facturas-production
             Seleccionar archivo:   arca-production.csr
           Apretá "Agregar alias" para subirlo.
        4. En la lista, entrá con "Ver" y usá el icono "Descargar"
           para bajar el certificado (archivo CRT).
           Guardalo acá como arca-production.crt.
        5. Volvé a Administrador de Relaciones, "Nueva Relación":
             Servicio:        BUSCAR → Webservices → Facturación Electrónica
             Representante:   BUSCAR → el computador fiscal facturas-production
           Apretá "Confirmar", revisá y volvé a apretar "Confirmar".

      Después:

        $ npx facturas check

      Para tu app las variables son ARCA_TAX_ID, ARCA_ENVIRONMENT,
      ARCA_CERTIFICATE_PEM y ARCA_PRIVATE_KEY_PEM; ver docs/inicio-rapido.md.
      "
    `);
  });

  it.each([
    "test",
    "production",
  ] as const)("keeps every %s line under 80 columns and names one environment only", async (environment) => {
    const { io, stdout, directory } = createTestIo();

    await runInit(
      io,
      { cuit: "20123456786", env: environment, dir: directory },
      createWriter(io.stdout, { color: false })
    );

    const output = stdout();
    for (const line of output.split("\n")) {
      expect(line.length, line).toBeLessThanOrEqual(80);
    }
    expect(output).not.toContain("Homologación:");
    expect(output).not.toContain("Producción:");
  });

  it("refuses to overwrite an existing file", async () => {
    const { io, directory, stderr } = createTestIo();
    writeFileSync(join(directory, "arca-test.key"), "no me pises");

    const code = await runInit(
      io,
      { cuit: "20123456786", env: "test", dir: directory },
      createWriter(io.stdout, { color: false })
    );

    expect(code).toBe(1);
    expect(stderr()).toContain("Usá --force para sobrescribir.");
    expect(readFileSync(join(directory, "arca-test.key"), "utf8")).toBe(
      "no me pises"
    );
  });

  it("overwrites with --force", async () => {
    const { io, directory } = createTestIo();
    writeFileSync(join(directory, "arca-test.key"), "no me pises");

    const code = await runInit(
      io,
      { cuit: "20123456786", env: "test", dir: directory, force: true },
      createWriter(io.stdout, { color: false })
    );

    expect(code).toBe(0);
    expect(readFileSync(join(directory, "arca-test.key"), "utf8")).toContain(
      "PRIVATE KEY"
    );
  });

  it("appends the credential patterns to an existing .gitignore, once", async () => {
    const { io, directory, stdout } = createTestIo();
    writeFileSync(join(directory, ".gitignore"), "node_modules\n");

    await runInit(
      io,
      { cuit: "20123456786", env: "test", dir: directory },
      createWriter(io.stdout, { color: false })
    );
    expect(readFileSync(join(directory, ".gitignore"), "utf8")).toBe(
      "node_modules\narca-*.key\narca-*.crt\n"
    );
    expect(stdout()).toContain("agregué arca-*.key y arca-*.crt");

    await runInit(
      io,
      { cuit: "20123456786", env: "test", dir: directory, force: true },
      createWriter(io.stdout, { color: false })
    );
    expect(readFileSync(join(directory, ".gitignore"), "utf8")).toBe(
      "node_modules\narca-*.key\narca-*.crt\n"
    );
  });

  it("leaves a directory without .gitignore alone", async () => {
    const { io, directory, stdout } = createTestIo();

    await runInit(
      io,
      { cuit: "20123456786", env: "test", dir: directory },
      createWriter(io.stdout, { color: false })
    );

    expect(stdout()).not.toContain(".gitignore");
  });

  it("uses --org and --name in the CSR subject", async () => {
    const { io, directory, stdout } = createTestIo();

    await runInit(
      io,
      {
        cuit: "20123456786",
        env: "test",
        dir: directory,
        name: "mi-sistema",
        org: "Prueba SRL",
      },
      createWriter(io.stdout, { color: false })
    );

    expect(stdout()).toContain("CN=mi-sistema");
    expect(stdout()).toContain("Nombre simbólico del DN:");
    expect(stdout()).toContain("mi-sistema-test");
  });

  it("exits 2 without a TTY and without --cuit", async () => {
    const { io, directory, stderr } = createTestIo();

    const code = await runInit(
      io,
      { env: "test", dir: directory },
      createWriter(io.stdout, { color: false })
    );

    expect(code).toBe(2);
    expect(stderr()).toContain("Falta el CUIT.");
  });

  it("exits 2 without a TTY and without --env", async () => {
    const { io, directory, stderr } = createTestIo();

    const code = await runInit(
      io,
      { cuit: "20123456786", dir: directory },
      createWriter(io.stdout, { color: false })
    );

    expect(code).toBe(2);
    expect(stderr()).toContain("Falta el entorno.");
  });

  it("asks for the CUIT and the environment on a terminal", async () => {
    const context = createTestIo({ tty: true });

    const running = runInit(
      context.io,
      { dir: context.directory },
      createWriter(context.io.stdout, { color: false })
    );
    context.stdin.write("20123456786\n");
    await waitFor(() => context.prompts().includes("Entorno"));
    context.stdin.write("test\n");

    expect(await running).toBe(0);
    expect(context.prompts()).toContain("CUIT: ");
    expect(context.prompts()).toContain("Entorno [test/production]: ");
    expect(
      readFileSync(join(context.directory, "arca-test.csr"), "utf8")
    ).toContain("CERTIFICATE REQUEST");
  });

  it("asks again, with the reason, when the answered CUIT is wrong", async () => {
    const context = createTestIo({ tty: true });

    const running = runInit(
      context.io,
      { dir: context.directory },
      createWriter(context.io.stdout, { color: false })
    );
    context.stdin.write("123\n");
    await waitFor(() => context.stderr().includes("3 dígitos"));
    context.stdin.write("20-12345678-6\n");
    await waitFor(() => context.prompts().includes("Entorno"));
    context.stdin.write("test\n");

    expect(await running).toBe(0);
    expect(context.stderr()).toBe(
      "CUIT inválido: 123 tiene 3 dígitos y necesita 11.\n"
    );
    expect(
      readFileSync(join(context.directory, "arca-test.csr"), "utf8")
    ).toContain("CERTIFICATE REQUEST");
  });

  it("gives up after three wrong answers, naming the last reason", async () => {
    const context = createTestIo({ tty: true });

    const running = runInit(
      context.io,
      { dir: context.directory },
      createWriter(context.io.stdout, { color: false })
    );
    context.stdin.write("123\n");
    await waitFor(() => context.stderr().includes("3 dígitos"));
    context.stdin.write("\n");
    await waitFor(() => context.stderr().includes("Falta el CUIT."));
    context.stdin.write("20123456789\n");

    expect(await running).toBe(2);
    expect(context.stderr()).toContain(
      "CUIT inválido: 20123456789 no pasa el dígito verificador."
    );
    expect(context.prompts().split("CUIT: ").length - 1).toBe(3);
  });

  it("exits 2 when the answered environment is not one ARCA has", async () => {
    const context = createTestIo({ tty: true });

    const running = runInit(
      context.io,
      { cuit: "20123456786", dir: context.directory },
      createWriter(context.io.stdout, { color: false })
    );
    await waitFor(() => context.prompts().includes("Entorno"));
    context.stdin.write("staging\n");

    expect(await running).toBe(2);
    expect(context.stderr()).toContain("Falta el entorno.");
  });

  it("says a short CUIT is wrong, not missing", async () => {
    const { io, directory, stderr } = createTestIo();

    const code = await runInit(
      io,
      { cuit: "2012345678", env: "test", dir: directory },
      createWriter(io.stdout, { color: false })
    );

    expect(code).toBe(2);
    expect(stderr()).toBe(
      "CUIT inválido: 2012345678 tiene 10 dígitos y necesita 11.\n"
    );
  });

  it("says a CUIT that fails its check digit is wrong, not missing", async () => {
    const { io, directory, stderr } = createTestIo();

    const code = await runInit(
      io,
      { cuit: "20123456789", env: "test", dir: directory },
      createWriter(io.stdout, { color: false })
    );

    expect(code).toBe(2);
    expect(stderr()).toBe(
      "CUIT inválido: 20123456789 no pasa el dígito verificador.\n"
    );
  });

  it("accepts a CUIT written with hyphens and stores it without them", async () => {
    const { io, directory } = createTestIo();

    const code = await runInit(
      io,
      { cuit: "20-12345678-6", env: "test", dir: directory },
      createWriter(io.stdout, { color: false })
    );

    expect(code).toBe(0);
    const request = forge.pki.certificationRequestFromPem(
      readFileSync(join(directory, "arca-test.csr"), "utf8")
    );
    expect(request.subject.getField({ name: "serialNumber" })?.value).toBe(
      "CUIT 20123456786"
    );
  });

  it("rejects an environment ARCA does not have", async () => {
    const { io, directory, stderr } = createTestIo();

    const code = await runInit(
      io,
      { cuit: "20123456786", env: "staging", dir: directory },
      createWriter(io.stdout, { color: false })
    );

    expect(code).toBe(2);
    expect(stderr()).toContain("Falta el entorno.");
  });
});

function createTestIo(options: { tty?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "facturas-cli-"));
  created.push(directory);
  const out: string[] = [];
  const err: string[] = [];
  const prompted: string[] = [];
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  if (options.tty === true) {
    stdin.isTTY = true;
  }
  const terminal = new PassThrough();
  terminal.on("data", (chunk: Buffer) => prompted.push(chunk.toString()));
  const collector: CliOutputStream = { write: (chunk) => out.push(chunk) };
  const stdout =
    options.tty === true
      ? (Object.assign(terminal, {
          write: (chunk: string) => {
            out.push(chunk);
            return terminal.push(chunk);
          },
        }) as unknown as CliOutputStream)
      : collector;
  const stderr: CliOutputStream = { write: (chunk) => err.push(chunk) };
  const io: CliIo = {
    stdout,
    stderr,
    stdin,
    env: {},
    cwd: directory,
    cacheDir: directory,
    now: () => new Date("2026-09-06T00:00:00Z"),
    createClient: () => {
      throw new Error("init never builds a client");
    },
    createAuth: () => {
      throw new Error("init never logs in");
    },
  };
  return {
    io,
    directory,
    stdin,
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    prompts: () => prompted.join(""),
  };
}

/** Waits for the next prompt before answering it: one readline at a time. */
async function waitFor(condition: () => boolean, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("the prompt never appeared");
}
