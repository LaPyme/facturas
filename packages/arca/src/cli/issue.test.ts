import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import forge from "node-forge";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArcaClient } from "../client";
import { ArcaAuthenticationError, ArcaServiceError } from "../errors";
import type { ArcaAuthCredentials } from "../internal/types";
import type { IssueOutcome } from "../services/vouchers-types";
import { buildSmokeTestInput, formatMinorUnits, runIssue } from "./issue";
import { type CliIo, type CliOutputStream, createWriter } from "./output";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const PAIR = createSelfSigned();
const TICKET: ArcaAuthCredentials = {
  token: "TOKEN",
  sign: "FIRMA",
  expiresAt: "2099-01-01T00:00:00Z",
};

const AUTHORIZED = {
  kind: "authorized",
  recoveredByMatch: false,
  voucher: {
    salesPoint: 3,
    voucherType: 6,
    number: 7,
    voucherClass: "B",
    date: "20260906",
    cae: "74123456789012",
    caeExpiry: "20260916",
    amounts: { computedTotal: 100, sentTotal: 100, vatAdjustment: 0 },
  },
  authorization: { service: "wsfe", operation: "FECAESolicitar" },
} as unknown as IssueOutcome;

describe("buildSmokeTestInput", () => {
  it("sends one peso as a plain amount for a class C issuer", () => {
    expect(buildSmokeTestInput("monotributo", 3)).toEqual({
      issuer: "monotributo",
      salesPoint: 3,
      to: { condition: "consumidor_final" },
      items: [{ amount: 100 }],
    });
  });

  it("sends one peso with VAT for a responsable inscripto", () => {
    expect(buildSmokeTestInput("responsable_inscripto", 3)).toEqual({
      issuer: "responsable_inscripto",
      salesPoint: 3,
      to: { condition: "consumidor_final" },
      items: [{ gross: 100, vat: 21 }],
    });
  });
});

describe("formatMinorUnits", () => {
  it.each([
    [100, "1,00"],
    [1, "0,01"],
    [0, "0,00"],
    [150_000, "1.500,00"],
    [123_456_789, "1.234.567,89"],
    [-100, "-1,00"],
  ])("formats %i as %s", (minorUnits, expected) => {
    expect(formatMinorUnits(minorUnits)).toBe(expected);
  });
});

describe("runIssue", () => {
  it("takes homologación from the file names when nothing else says", async () => {
    const directory = createTemporaryDirectory();
    writeFileSync(join(directory, "arca-test.crt"), PAIR.certificatePem);
    writeFileSync(join(directory, "arca-test.key"), PAIR.privateKeyPem);
    const context = createContext({ bare: true, cwd: directory });

    const code = await run(context, { salesPoint: 3, issuer: "monotributo" });

    expect(code).toBe(0);
    expect(context.issue).toHaveBeenCalledTimes(1);
  });

  it("refuses when the only pair in the directory is production", async () => {
    const directory = createTemporaryDirectory();
    writeFileSync(join(directory, "arca-production.crt"), PAIR.certificatePem);
    writeFileSync(join(directory, "arca-production.key"), PAIR.privateKeyPem);
    const context = createContext({ bare: true, cwd: directory });

    const code = await run(context, { salesPoint: 3, issuer: "monotributo" });

    expect(code).toBe(1);
    expect(context.stderr()).toContain("issue solo emite en homologación.");
    expect(context.issue).not.toHaveBeenCalled();
  });

  it("refuses outside homologación", async () => {
    const context = createContext({ environment: "production" });

    expect(await run(context, { issuer: "monotributo", salesPoint: 3 })).toBe(
      1
    );
    expect(context.stderr()).toBe(
      "issue solo emite en homologación. Cambiá ARCA_ENVIRONMENT=test.\n"
    );
    expect(context.issue).not.toHaveBeenCalled();
  });

  it("refuses when no environment is set at all", async () => {
    const context = createContext({ environment: undefined });

    expect(await run(context, { issuer: "monotributo", salesPoint: 3 })).toBe(
      1
    );
    expect(context.issue).not.toHaveBeenCalled();
  });

  it("exits 2 without a TTY and without --sales-point", async () => {
    const context = createContext({});

    expect(await run(context, { issuer: "monotributo" })).toBe(2);
    expect(context.stderr()).toContain("Falta el punto de venta.");
  });

  it("exits 2 without a TTY and without --issuer", async () => {
    const context = createContext({});

    expect(await run(context, { salesPoint: 3 })).toBe(2);
    expect(context.stderr()).toContain("Falta la condición del emisor.");
  });

  it("exits 2 for an issuer condition ARCA does not have", async () => {
    const context = createContext({});

    expect(await run(context, { salesPoint: 3, issuer: "sociedad" })).toBe(2);
    expect(context.stderr()).toContain("Falta la condición del emisor.");
  });

  it("asks for the sales point and the issuer on a terminal", async () => {
    const context = createContext({ outcome: AUTHORIZED, tty: true });

    const running = runIssue(
      context.io,
      {},
      createWriter(context.io.stdout, { color: false }),
      false
    );
    context.stdin.write("3\n");
    await waitFor(() => context.prompts().includes("Emisor"));
    context.stdin.write("monotributo\n");

    expect(await running).toBe(0);
    expect(context.prompts()).toContain("Punto de venta: ");
    expect(context.issue).toHaveBeenCalledWith({
      issuer: "monotributo",
      salesPoint: 3,
      to: { condition: "consumidor_final" },
      items: [{ amount: 100 }],
    });
  });

  // The prompt reads the answer the way `--sales-point` reads its value: a
  // number the answer only starts with is a typo, never a sales point.
  it.each([
    "tres",
    "3foo",
    "3.5",
    "1e2",
    "0",
  ])("exits 2 when the answered sales point is %j", async (answer) => {
    const context = createContext({ tty: true });

    const running = runIssue(
      context.io,
      {},
      createWriter(context.io.stdout, { color: false }),
      false
    );
    context.stdin.write(`${answer}\n`);

    expect(await running).toBe(2);
    expect(context.stderr()).toContain("Falta el punto de venta.");
    expect(context.issue).not.toHaveBeenCalled();
  });

  // The layers pass, then WSFE falls over on the next number or the
  // authorization. Before this was caught the rejection escaped runIssue and
  // node printed its own unhandled error, with no report and no JSON.
  it("reports a failed issue instead of throwing out of runIssue", async () => {
    const context = createContext({
      issueError: new ArcaServiceError("WSFE no responde"),
    });

    expect(await run(context, { salesPoint: 3, issuer: "monotributo" })).toBe(
      1
    );
    expect(context.stdout()).toContain("✗ emisión");
    expect(context.stdout()).toContain("WSFE no responde");
    expect(context.stdout()).toContain("antes de repetir");
  });

  it("never prints a stack or a PEM for a failed issue", async () => {
    const context = createContext({ issueError: new Error("boom") });

    expect(await run(context, { salesPoint: 3, issuer: "monotributo" })).toBe(
      1
    );
    expect(context.stdout()).toContain("boom");
    expect(context.stdout()).not.toContain("BEGIN");
    expect(context.stdout()).not.toContain("at ");
  });

  it("emits one JSON object for a failed issue", async () => {
    const context = createContext({
      issueError: new ArcaServiceError("WSFE no responde"),
    });

    expect(
      await run(context, { salesPoint: 3, issuer: "monotributo" }, true)
    ).toBe(1);
    expect(JSON.parse(context.stdout())).toEqual({
      ok: false,
      environment: "test",
      taxId: "20123456786",
      error: { code: "ARCA_SERVICE_ERROR", message: "WSFE no responde" },
    });
  });

  it("leaves out the code when the error has none", async () => {
    const context = createContext({ issueError: new Error("se cortó la red") });

    expect(
      await run(context, { salesPoint: 3, issuer: "monotributo" }, true)
    ).toBe(1);
    expect(JSON.parse(context.stdout())).toMatchObject({
      ok: false,
      error: { message: "se cortó la red" },
    });
    expect(context.stdout()).not.toContain('"code"');
  });

  it("runs the check layers first and stops when one fails", async () => {
    const context = createContext({
      salesPointsError: new ArcaAuthenticationError("rechazado", {
        reason: "missing_relationship",
        service: "wsfe",
        operation: "FEParamGetPtosVenta",
      }),
    });

    expect(await run(context, { salesPoint: 3, issuer: "monotributo" })).toBe(
      1
    );
    expect(context.stdout()).toContain(
      "El certificado no tiene la relación con Facturación Electrónica."
    );
    expect(context.issue).not.toHaveBeenCalled();
  });

  it("issues one invoice with no store and no idempotency key", async () => {
    const context = createContext({ outcome: AUTHORIZED });

    expect(
      await run(context, { salesPoint: 3, issuer: "responsable_inscripto" })
    ).toBe(0);
    expect(context.issue).toHaveBeenCalledTimes(1);
    expect(context.issue).toHaveBeenCalledWith({
      issuer: "responsable_inscripto",
      salesPoint: 3,
      to: { condition: "consumidor_final" },
      items: [{ gross: 100, vat: 21 }],
    });
    expect(context.clientOptions?.store).toBeUndefined();
  });

  it("prints the voucher and the exact call it made", async () => {
    const context = createContext({ outcome: AUTHORIZED });

    await run(context, { salesPoint: 3, issuer: "responsable_inscripto" });

    expect(stripCheck(context.stdout())).toMatchInlineSnapshot(`
      "✓ Factura B emitida - 00003-00000007   CAE 74123456789012   Vto. CAE 2026-09-16   ARS 1,00

      Esta es la llamada que hizo el CLI. Pegala en tu aplicación:

        const factura = await arca.issue({
          issuer: "responsable_inscripto",
          salesPoint: 3,
          to: { condition: "consumidor_final" },
          items: [{ gross: 100, vat: 21 }],
        });
      "
    `);
  });

  it("issues even when homologación reports no sales points", async () => {
    const context = createContext({ outcome: AUTHORIZED, salesPoints: [] });

    expect(await run(context, { salesPoint: 3, issuer: "monotributo" })).toBe(
      0
    );
    expect(context.issue).toHaveBeenCalledTimes(1);
    expect(context.stdout()).toContain("✓ Factura B emitida - 00003-00000007");
  });

  it("prints the class C call for a monotributista", async () => {
    const context = createContext({ outcome: AUTHORIZED });

    await run(context, { salesPoint: 3, issuer: "monotributo" });

    expect(context.stdout()).toContain("items: [{ amount: 100 }],");
    expect(context.stdout()).toContain('issuer: "monotributo",');
  });

  it("lists ARCA's errors when the invoice is rejected", async () => {
    const context = createContext({
      outcome: {
        kind: "rejected",
        attempted: { salesPoint: 3, voucherType: 6, number: 7 },
        issues: [
          { code: "10016", message: "El numero de comprobante no es correcto" },
          { message: "Sin código" },
        ],
        authorization: {},
      } as unknown as IssueOutcome,
    });

    expect(await run(context, { salesPoint: 3, issuer: "monotributo" })).toBe(
      1
    );
    expect(stripCheck(context.stdout())).toMatchInlineSnapshot(`
      "✗ Factura rechazada - 00003-00000007
        10016 El numero de comprobante no es correcto
        Sin código
      "
    `);
  });

  it("keeps the number and the advice when the result is indeterminate", async () => {
    const context = createContext({
      outcome: {
        kind: "indeterminate",
        attempted: { salesPoint: 3, voucherType: 6, number: 7 },
        attempt: { reason: "transport_error" },
        lookup: { kind: "not_found" },
      } as unknown as IssueOutcome,
    });

    expect(await run(context, { salesPoint: 3, issuer: "monotributo" })).toBe(
      1
    );
    expect(stripCheck(context.stdout())).toMatchInlineSnapshot(`
      "✗ indeterminado 00003-00000007
        transport_error, consulta not_found
        Conservá el número y la evidencia; conciliá o repetí el mismo input con su clave.
      "
    `);
  });

  it("stops the flow on a conflict", async () => {
    const context = createContext({
      outcome: {
        kind: "conflict",
        attempted: { salesPoint: 3, voucherType: 6, number: 7 },
        attempt: { reason: "transport_error" },
        found: { number: 7 },
        reason: "totalAmount difiere",
      } as unknown as IssueOutcome,
    });

    expect(await run(context, { salesPoint: 3, issuer: "monotributo" })).toBe(
      1
    );
    expect(stripCheck(context.stdout())).toMatchInlineSnapshot(`
      "✗ conflicto en 00003-00000007
        totalAmount difiere
        Hay otro comprobante en ese número; detené el flujo e investigá.
      "
    `);
  });

  it("prints the outcome object with --json", async () => {
    const context = createContext({ outcome: AUTHORIZED });

    const code = await runIssue(
      context.io,
      { salesPoint: 3, issuer: "monotributo" },
      createWriter(context.io.stdout, { color: false }),
      true
    );

    expect(code).toBe(0);
    expect(JSON.parse(context.stdout())).toEqual(AUTHORIZED);
  });

  it("prints the failing check report with --json", async () => {
    const context = createContext({
      salesPointsError: new ArcaAuthenticationError("rechazado", {
        reason: "invalid_token",
        service: "wsfe",
        operation: "FEParamGetPtosVenta",
      }),
    });

    const code = await runIssue(
      context.io,
      { salesPoint: 3, issuer: "monotributo" },
      createWriter(context.io.stdout, { color: false }),
      true
    );

    expect(code).toBe(1);
    expect(JSON.parse(context.stdout()).ok).toBe(false);
  });
});

type TestContext = ReturnType<typeof createContext>;

function run(
  context: TestContext,
  flags: { salesPoint?: number; issuer?: string },
  json = false
) {
  return runIssue(
    context.io,
    flags,
    createWriter(context.io.stdout, { color: false }),
    json
  );
}

/** Drops the five check lines so the snapshots show only the issue output. */
function stripCheck(printed: string): string {
  return printed
    .split("\n")
    .filter(
      (line) =>
        !(
          line.startsWith("✓ variables") ||
          line.startsWith("✓ certificado") ||
          line.startsWith("✓ WSAA") ||
          line.startsWith("✓ WSFE") ||
          line.startsWith("✓ puntos") ||
          line.startsWith("  3 (habilitado")
        )
    )
    .join("\n");
}

function createContext(options: {
  environment?: string;
  /** With a directory the environment comes from the file names, not the env. */
  cwd?: string;
  bare?: boolean;
  outcome?: IssueOutcome;
  salesPoints?: { number: number; blocked: string; emissionType: string }[];
  salesPointsError?: unknown;
  /** What `client.issue` rejects with, once the layers have all passed. */
  issueError?: unknown;
  tty?: boolean;
}) {
  const out: string[] = [];
  const err: string[] = [];
  const prompted: string[] = [];
  const issue = vi.fn(() =>
    options.issueError === undefined
      ? Promise.resolve(options.outcome ?? (AUTHORIZED as IssueOutcome))
      : Promise.reject(options.issueError)
  );
  const context = {
    issue,
    clientOptions: undefined,
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    io: undefined,
  } as unknown as {
    issue: typeof issue;
    clientOptions?: { store?: unknown };
    stdout(): string;
    stderr(): string;
    io: CliIo;
  };

  const stderr: CliOutputStream = { write: (chunk) => err.push(chunk) };
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  if (options.tty === true) {
    stdin.isTTY = true;
  }
  const terminal = new PassThrough();
  terminal.on("data", (chunk: Buffer) => prompted.push(chunk.toString()));
  const stdout: CliOutputStream =
    options.tty === true
      ? (Object.assign(terminal, {
          write: (chunk: string) => {
            out.push(chunk);
            return terminal.push(chunk);
          },
        }) as unknown as CliOutputStream)
      : { write: (chunk) => out.push(chunk) };

  context.io = {
    stdout,
    stderr,
    stdin,
    env: options.bare
      ? {}
      : {
          ARCA_TAX_ID: "20123456786",
          ARCA_CERTIFICATE_PEM: PAIR.certificatePem,
          ARCA_PRIVATE_KEY_PEM: PAIR.privateKeyPem,
          ...("environment" in options
            ? { ARCA_ENVIRONMENT: options.environment }
            : { ARCA_ENVIRONMENT: "test" }),
        },
    cwd: options.cwd ?? tmpdir(),
    cacheDir: createTemporaryDirectory(),
    now: () => new Date("2026-09-06T00:00:00Z"),
    copyToClipboard: () => Promise.resolve(false),
    createClient: (clientOptions) => {
      context.clientOptions = clientOptions as never;
      return {
        wsfe: {
          getServerStatus: () =>
            Promise.resolve({
              appServer: "OK",
              dbServer: "OK",
              authServer: "OK",
            }),
          getSalesPoints: () =>
            options.salesPointsError === undefined
              ? Promise.resolve(
                  options.salesPoints ?? [
                    { number: 3, blocked: "N", emissionType: "CAE" },
                  ]
                )
              : Promise.reject(options.salesPointsError),
        },
        issue,
      } as unknown as ArcaClient;
    },
    createAuth: () => ({ login: () => Promise.resolve(TICKET) }) as never,
  };

  return Object.assign(context, {
    stdin,
    prompts: () => prompted.join(""),
  });
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

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "facturas-issue-"));
  temporary.push(directory);
  return directory;
}

function createSelfSigned() {
  const keyPair = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x01_00_01 });
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keyPair.publicKey;
  certificate.serialNumber = "01";
  certificate.validity.notBefore = new Date("2020-01-01T00:00:00Z");
  certificate.validity.notAfter = new Date("2030-01-01T00:00:00Z");
  certificate.setSubject([
    { name: "commonName", value: "facturas" },
    { name: "serialNumber", value: "CUIT 20123456786" },
  ]);
  certificate.setIssuer([{ name: "commonName", value: "facturas" }]);
  certificate.sign(keyPair.privateKey, forge.md.sha256.create());
  return {
    certificatePem: forge.pki.certificateToPem(certificate),
    privateKeyPem: forge.pki.privateKeyToPem(keyPair.privateKey),
  };
}
