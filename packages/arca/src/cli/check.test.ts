import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import forge from "node-forge";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArcaClient } from "../client";
import {
  ArcaAuthenticationError,
  ArcaServiceError,
  ArcaSoapFaultError,
  ArcaTransportError,
} from "../errors";
import type {
  ArcaAuthCredentials,
  ArcaAuthOptions,
  ArcaWsaaServiceId,
} from "../internal/types";
import type { WsfeSalesPoint } from "../services/wsfe";
import { type CheckFlags, runCheck } from "./check";
import { type CliIo, type CliOutputStream, createWriter } from "./output";

const NOW = new Date("2026-09-06T00:00:00Z");
const TAX_ID = "20123456786";
const EXPIRES = new Date("2027-09-05T12:00:00Z");
const VALID = createSelfSigned(EXPIRES);
const OTHER = createSelfSigned(EXPIRES);
const ANONYMOUS = createSelfSigned(EXPIRES, null);
const SOMEONE_ELSE = createSelfSigned(EXPIRES, "33693450239");
const EXPIRING = createSelfSigned(new Date("2026-09-16T00:00:00Z"));
const EXPIRED = createSelfSigned(new Date("2026-01-31T00:00:00Z"));

const TICKET: ArcaAuthCredentials = {
  token: "TOKEN-SECRETO",
  sign: "FIRMA-SECRETA",
  expiresAt: "2099-01-01T00:00:00Z",
};

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("runCheck env layer", () => {
  it("names the missing CUIT", async () => {
    const context = createContext({ env: { ARCA_ENVIRONMENT: "test" } });

    expect(await run(context, {})).toBe(1);
    expect(context.stdout()).toMatchInlineSnapshot(`
      "✗ configuración
        Falta el CUIT.
        export ARCA_TAX_ID=20123456786
      "
    `);
  });

  it("names the missing environment", async () => {
    const context = createContext({ env: { ARCA_TAX_ID: "20123456786" } });

    expect(await run(context, {})).toBe(1);
    expect(context.stdout()).toContain("Falta el entorno.");
    expect(context.stdout()).toContain("export ARCA_ENVIRONMENT=test");
  });

  it("names the missing PEMs", async () => {
    const context = createContext({
      env: { ARCA_TAX_ID: "20123456786", ARCA_ENVIRONMENT: "test" },
    });

    expect(await run(context, {})).toBe(1);
    expect(context.stdout()).toContain("Falta el certificado o la clave.");
  });

  it("says a CUIT that is not eleven digits is wrong, not missing", async () => {
    const context = createContext({ env: fullEnv({ ARCA_TAX_ID: "123" }) });

    expect(await run(context, {})).toBe(1);
    expect(context.stdout()).toMatchInlineSnapshot(`
      "✗ configuración
        CUIT inválido: 123 tiene 3 dígitos y necesita 11.
        Son 11 dígitos y el último es el verificador; podés escribirlo con guiones.
      "
    `);
  });

  it("rejects a --tax-id that fails its check digit", async () => {
    const context = createContext({ env: fullEnv() });

    expect(await run(context, { taxId: "20123456789" })).toBe(1);
    expect(context.stdout()).toContain(
      "CUIT inválido: 20123456789 no pasa el dígito verificador."
    );
  });

  it("accepts a CUIT written with hyphens", async () => {
    const context = createContext({
      env: fullEnv({ ARCA_TAX_ID: "20-12345678-6" }),
      salesPoints: [],
    });

    expect(await run(context, {})).toBe(0);
  });

  it("rejects an environment ARCA does not have", async () => {
    const context = createContext({
      env: fullEnv({ ARCA_ENVIRONMENT: "staging" }),
    });

    expect(await run(context, {})).toBe(1);
    expect(context.stdout()).toContain("Falta el entorno.");
  });

  it("loads the PEMs from --cert and --key", async () => {
    const directory = createTemporaryDirectory();
    writeFileSync(join(directory, "arca.crt"), VALID.certificatePem);
    writeFileSync(join(directory, "arca.key"), VALID.privateKeyPem);
    const context = createContext({
      env: { ARCA_TAX_ID: "20123456786", ARCA_ENVIRONMENT: "test" },
      salesPoints: [{ number: 3, blocked: "N", emissionType: "CAE" }],
    });

    const code = await run(context, {
      cert: join(directory, "arca.crt"),
      key: join(directory, "arca.key"),
    });

    expect(code).toBe(0);
    expect(context.stdout()).toContain("ARCA_TAX_ID, ARCA_ENVIRONMENT=test");
  });

  it("reports a file it cannot read with the SDK's safe message", async () => {
    const context = createContext({
      env: { ARCA_TAX_ID: "20123456786", ARCA_ENVIRONMENT: "test" },
    });

    expect(await run(context, { cert: "/no/existe.crt" })).toBe(1);
    expect(context.stdout()).toContain("ENOENT");
  });

  it("names the flags when the values came from flags", async () => {
    const context = createContext({
      env: {
        ARCA_CERTIFICATE_PEM: VALID.certificatePem,
        ARCA_PRIVATE_KEY_PEM: VALID.privateKeyPem,
      },
      salesPoints: [],
    });

    await run(context, { taxId: "20123456786", env: "test" });

    expect(context.stdout()).toContain("--tax-id, --env=test");
  });
});

describe("runCheck file discovery", () => {
  it("finds the pair in the directory and reads the CUIT from the certificate", async () => {
    const directory = directoryWith("test", VALID);
    const context = createContext({ env: {}, cwd: directory, salesPoints: [] });

    expect(await run(context, {})).toBe(0);
    expect(context.stdout()).toContain(
      "✓ configuración          arca-test.crt en este directorio, CUIT 20123456786 del certificado"
    );
  });

  it("takes the environment from the file name", async () => {
    const directory = directoryWith("production", VALID);
    const context = createContext({
      env: {},
      cwd: directory,
      salesPoints: [{ number: 3, blocked: "N", emissionType: "CAE" }],
    });

    await run(context, {});

    expect(context.authOptions?.environment).toBe("production");
    expect(context.stdout()).toContain(
      "arca-production.crt en este directorio"
    );
  });

  it("looks in --dir instead of the current directory", async () => {
    const directory = directoryWith("test", VALID);
    const context = createContext({
      env: {},
      cwd: tmpdir(),
      salesPoints: [],
    });

    expect(await run(context, { dir: directory })).toBe(0);
  });

  it("asks for --env when both environments are on disk", async () => {
    const directory = directoryWith("test", VALID);
    writeFileSync(join(directory, "arca-production.crt"), VALID.certificatePem);
    writeFileSync(join(directory, "arca-production.key"), VALID.privateKeyPem);
    const context = createContext({ env: {}, cwd: directory });

    expect(await run(context, {})).toBe(1);
    expect(context.stdout()).toMatchInlineSnapshot(`
      "✗ configuración
        Están arca-test.crt y arca-production.crt en este directorio y no sé cuál querés.
        Elegí con --env test o --env production.
      "
    `);
  });

  it("uses --env to choose between the two", async () => {
    const directory = directoryWith("test", VALID);
    writeFileSync(join(directory, "arca-production.crt"), VALID.certificatePem);
    writeFileSync(join(directory, "arca-production.key"), VALID.privateKeyPem);
    const context = createContext({
      env: {},
      cwd: directory,
      salesPoints: [{ number: 3, blocked: "N", emissionType: "CAE" }],
    });

    expect(await run(context, { env: "production" })).toBe(0);
    expect(context.stdout()).toContain(
      "arca-production.crt en este directorio, CUIT 20123456786 del certificado, --env=production"
    );
  });

  it("says which half of the pair is missing, right after init", async () => {
    const directory = createTemporaryDirectory();
    writeFileSync(join(directory, "arca-test.key"), VALID.privateKeyPem);
    const context = createContext({ env: {}, cwd: directory });

    expect(await run(context, {})).toBe(1);
    expect(context.stdout()).toMatchInlineSnapshot(`
      "✗ configuración
        Está arca-test.key pero falta arca-test.crt.
        Descargá el certificado de ARCA y guardalo acá como arca-test.crt.
      "
    `);
  });

  it("says which half is missing when the key is the one that is gone", async () => {
    const directory = createTemporaryDirectory();
    writeFileSync(join(directory, "arca-test.crt"), VALID.certificatePem);
    const context = createContext({ env: {}, cwd: directory });

    expect(await run(context, {})).toBe(1);
    expect(context.stdout()).toContain(
      "Está arca-test.crt pero falta arca-test.key."
    );
    expect(context.stdout()).toContain("o pasá --key.");
  });

  it("prefers the environment variables over the files", async () => {
    const directory = directoryWith("test", SOMEONE_ELSE);
    const context = createContext({
      env: fullEnv(),
      cwd: directory,
      salesPoints: [],
    });

    expect(await run(context, {})).toBe(0);
    expect(context.stdout()).toContain(
      "✓ configuración          ARCA_TAX_ID, ARCA_ENVIRONMENT=test"
    );
  });

  it("prefers --cert and --key over the files", async () => {
    const directory = directoryWith("test", SOMEONE_ELSE);
    const certificate = join(directory, "otro.crt");
    const key = join(directory, "otro.key");
    writeFileSync(certificate, VALID.certificatePem);
    writeFileSync(key, VALID.privateKeyPem);
    const context = createContext({
      env: { ARCA_ENVIRONMENT: "test" },
      cwd: directory,
      salesPoints: [],
    });

    expect(await run(context, { cert: certificate, key })).toBe(0);
    expect(context.stdout()).toContain(
      "--cert y --key, CUIT 20123456786 del certificado, ARCA_ENVIRONMENT=test"
    );
  });

  it("asks for the CUIT when the certificate does not carry one", async () => {
    const directory = directoryWith("test", ANONYMOUS);
    const context = createContext({ env: {}, cwd: directory });

    expect(await run(context, {})).toBe(1);
    expect(context.stdout()).toContain(
      "El certificado no dice de qué CUIT es."
    );
    expect(context.stdout()).toContain("Pasá --tax-id 20123456786");
  });

  it("takes the CUIT that was given over the one in the certificate", async () => {
    const directory = directoryWith("test", ANONYMOUS);
    const context = createContext({ env: {}, cwd: directory, salesPoints: [] });

    expect(await run(context, { taxId: TAX_ID })).toBe(0);
    expect(context.stdout()).toContain(
      "arca-test.crt en este directorio, --tax-id"
    );
  });

  it("stops when the given CUIT and the certificate's disagree", async () => {
    const directory = directoryWith("test", SOMEONE_ELSE);
    const context = createContext({ env: {}, cwd: directory });

    expect(await run(context, { taxId: TAX_ID })).toBe(1);
    expect(context.stdout()).toMatchInlineSnapshot(`
      "✓ configuración          arca-test.crt en este directorio, --tax-id
      ✗ certificado y clave
        El certificado es del CUIT 33693450239 y el configurado es 20123456786.
        Usá el certificado de ese CUIT, o corregí --tax-id o ARCA_TAX_ID.
      "
    `);
  });
});

describe("runCheck certificate layer", () => {
  it("reports a PEM that does not parse", async () => {
    const context = createContext({
      env: fullEnv({
        ARCA_CERTIFICATE_PEM: "-----BEGIN CERTIFICATE-----\nno\n",
      }),
    });

    expect(await run(context, {})).toBe(1);
    expect(context.stdout()).toContain("El archivo no es un PEM válido.");
  });

  it("reports a key that belongs to another certificate", async () => {
    const context = createContext({
      env: fullEnv({ ARCA_PRIVATE_KEY_PEM: OTHER.privateKeyPem }),
    });

    expect(await run(context, {})).toBe(1);
    expect(context.stdout()).toMatchInlineSnapshot(`
      "✓ configuración          ARCA_TAX_ID, ARCA_ENVIRONMENT=test
      ✗ certificado y clave
        La clave privada no corresponde a este certificado.
        Usá la clave con la que generaste el CSR (arca-<entorno>.key).
      "
    `);
  });

  it("reports an expired certificate with its date", async () => {
    const context = createContext({
      env: fullEnv({
        ARCA_CERTIFICATE_PEM: EXPIRED.certificatePem,
        ARCA_PRIVATE_KEY_PEM: EXPIRED.privateKeyPem,
      }),
    });

    expect(await run(context, {})).toBe(1);
    expect(context.stdout()).toContain("El certificado venció el 2026-01-31.");
  });

  it("warns under thirty days and still exits 0", async () => {
    const context = createContext({
      env: fullEnv({
        ARCA_CERTIFICATE_PEM: EXPIRING.certificatePem,
        ARCA_PRIVATE_KEY_PEM: EXPIRING.privateKeyPem,
      }),
      salesPoints: [{ number: 3, blocked: "N", emissionType: "CAE" }],
    });

    expect(await run(context, {})).toBe(0);
    expect(context.stdout()).toContain(
      "! certificado y clave    vence en 10 días"
    );
  });
});

describe("runCheck WSAA layer", () => {
  it("lets the SDK reuse the cached ticket instead of forcing a login", async () => {
    const context = createContext({ env: fullEnv(), salesPoints: [] });

    await run(context, {});

    expect(context.login).toHaveBeenCalledWith("wsfe", { forceRefresh: false });
    expect(context.clientOptions?.store).toBeUndefined();
  });

  it("forces one in-memory login with --no-cache", async () => {
    const context = createContext({ env: fullEnv(), salesPoints: [] });

    await run(context, { noCache: true });

    expect(context.login).toHaveBeenCalledWith("wsfe", { forceRefresh: true });
    expect(context.authOptions?.wsaaSessionStore).toBeUndefined();
  });

  it("keeps the ticket so a second run does not log in again", async () => {
    const cacheDir = createTemporaryDirectory();
    const first = createContext({ env: fullEnv(), salesPoints: [], cacheDir });

    expect(await run(first, {})).toBe(0);
    expect(first.stdout()).toContain(
      "✓ WSAA                   ticket obtenido"
    );

    const second = createContext({ env: fullEnv(), salesPoints: [], cacheDir });
    expect(await run(second, {})).toBe(0);
    expect(second.stdout()).toContain(
      "✓ WSAA                   ticket vigente"
    );
    expect(second.login).not.toHaveBeenCalled();
  });

  it("writes nothing to the cache with --no-cache", async () => {
    const cacheDir = createTemporaryDirectory();
    const context = createContext({
      env: fullEnv(),
      salesPoints: [],
      cacheDir,
    });

    await run(context, { noCache: true });

    expect(existsSync(cacheDir) ? readdirSync(cacheDir) : []).toEqual([]);
  });

  it("names an unauthorized certificate", async () => {
    const context = createContext({
      env: fullEnv(),
      loginError: new ArcaSoapFaultError("rechazado", {
        faultCode: "ns1:coe.notAuthorized",
      }),
    });

    expect(await run(context, {})).toBe(1);
    expect(context.stdout()).toContain(
      "El certificado no está autorizado para wsfe."
    );
    expect(context.stdout()).toContain("Crear autorización a servicio");
  });

  it("names a clock that drifted", async () => {
    const context = createContext({
      env: fullEnv(),
      loginError: new ArcaSoapFaultError("rechazado", {
        faultCode: "ns1:xml.generationTime.invalid",
      }),
    });

    expect(await run(context, {})).toBe(1);
    expect(context.stdout()).toContain("Sincronizá el reloj (NTP)");
  });

  it("names the host it could not reach", async () => {
    const context = createContext({
      env: fullEnv(),
      loginError: new ArcaTransportError("sin red"),
    });

    expect(await run(context, {})).toBe(1);
    expect(context.stdout()).toContain(
      "No se pudo conectar con wsaahomo.afip.gov.ar."
    );
  });

  it("names a ticket another machine is holding", async () => {
    const context = createContext({
      env: fullEnv(),
      loginError: new ArcaSoapFaultError("ya autenticado", {
        faultCode: "ns1:coe.alreadyAuthenticated",
      }),
    });

    expect(await run(context, {})).toBe(1);
    expect(context.stdout()).toContain(
      "Ya hay un ticket vigente para este certificado."
    );
    expect(context.stdout()).toContain(
      "Otro proceso o máquina tiene el ticket vigente."
    );
  });

  it("falls back to the SDK's safe message for an unknown failure", async () => {
    const context = createContext({
      env: fullEnv(),
      loginError: new Error("algo raro"),
    });

    expect(await run(context, {})).toBe(1);
    expect(context.stdout()).toContain("algo raro");
  });
});

describe("runCheck WSFE layer", () => {
  it("names a missing relationship", async () => {
    const context = createContext({
      env: fullEnv(),
      salesPointsError: new ArcaAuthenticationError("rechazado", {
        reason: "missing_relationship",
        service: "wsfe",
        operation: "FEParamGetPtosVenta",
      }),
    });

    expect(await run(context, {})).toBe(1);
    expect(context.stdout()).toMatchInlineSnapshot(`
      "✓ configuración          ARCA_TAX_ID, ARCA_ENVIRONMENT=test
      ✓ certificado y clave    coinciden, vence 2027-09-05
      ✓ WSAA                   ticket obtenido
      ✗ WSFE
        El certificado no tiene la relación con Facturación Electrónica.
        Administrador de Relaciones → Nueva Relación → Webservices → Facturación Electrónica.
      "
    `);
  });

  it("names a service error with ARCA's own message", async () => {
    const context = createContext({
      env: fullEnv(),
      salesPointsError: new ArcaServiceError("602 no encontrado"),
    });

    expect(await run(context, {})).toBe(1);
    expect(context.stdout()).toContain(
      "ARCA respondió con un error: 602 no encontrado."
    );
  });

  it("fails when a WSFE component is down", async () => {
    const context = createContext({
      env: fullEnv(),
      serverStatus: { appServer: "OK", dbServer: "ERROR", authServer: "OK" },
    });

    expect(await run(context, {})).toBe(1);
    expect(context.stdout()).toContain("dbServer=ERROR");
  });

  it("hands WSFE the same ticket store the WSAA layer used", async () => {
    const context = createContext({ env: fullEnv(), salesPoints: [] });

    await run(context, {});

    expect(context.clientOptions?.wsaaSessionStore).toBe(
      context.authOptions?.wsaaSessionStore
    );
    expect(context.login).toHaveBeenCalledTimes(1);
  });

  it("hands WSFE the in-memory ticket with --no-cache", async () => {
    const context = createContext({ env: fullEnv(), salesPoints: [] });

    await run(context, { noCache: true });

    const stored = await context.clientOptions?.wsaaSessionStore?.get({
      environment: "test",
      service: "wsfe",
      certificateFingerprint: "cualquiera",
    });
    expect(stored).toEqual(TICKET);
    expect(context.login).toHaveBeenCalledTimes(1);
  });
});

describe("runCheck sales points layer", () => {
  it("lists each point on its own line", async () => {
    const context = createContext({
      env: fullEnv(),
      salesPoints: [
        { number: 3, blocked: "N", emissionType: "CAE" },
        { number: 4, blocked: "N", emissionType: "CAE" },
      ],
    });

    expect(await run(context, {})).toBe(0);
    expect(context.stdout()).toMatchInlineSnapshot(`
      "✓ configuración          ARCA_TAX_ID, ARCA_ENVIRONMENT=test
      ✓ certificado y clave    coinciden, vence 2027-09-05
      ✓ WSAA                   ticket obtenido
      ✓ WSFE                   servidor ok
      ✓ puntos de venta        2 informados
        3 (habilitado, CAE)
        4 (habilitado, CAE)
      "
    `);
  });

  it("warns instead of failing when homologación reports none", async () => {
    const context = createContext({ env: fullEnv(), salesPoints: [] });

    expect(await run(context, {})).toBe(0);
    expect(context.stdout()).toContain(
      "✓ puntos de venta        ninguno informado"
    );
    expect(context.stdout()).toContain(
      "en homologación ARCA suele no informarlos"
    );
  });

  it("fails when production reports none: nothing can be issued", async () => {
    const context = createContext({
      env: fullEnv({ ARCA_ENVIRONMENT: "production" }),
      salesPoints: [],
    });

    expect(await run(context, {})).toBe(1);
    expect(context.stdout()).toContain("✗ puntos de venta");
    expect(context.stdout()).toContain(
      "ARCA no informa ningún punto de venta para web services."
    );
    expect(context.stdout()).toContain(
      "Administración de Puntos de Venta y Domicilios"
    );
    expect(context.stdout()).toContain("RECE para aplicativo y Web Services");
    expect(context.stdout()).not.toContain("en homologación ARCA suele");
  });

  it("reports the failed production layer in --json", async () => {
    const context = createContext({
      env: fullEnv({ ARCA_ENVIRONMENT: "production" }),
      salesPoints: [],
    });

    expect(await run(context, {}, true)).toBe(1);
    const report = JSON.parse(context.stdout()) as {
      ok: boolean;
      salesPoints: unknown[];
      layers: { name: string; ok: boolean; diagnosis?: string }[];
    };
    expect(report.ok).toBe(false);
    expect(report.salesPoints).toEqual([]);
    expect(report.layers.at(-1)).toMatchObject({
      name: "salesPoints",
      ok: false,
      diagnosis: "ARCA no informa ningún punto de venta para web services.",
    });
  });

  it("fails when the requested point is not listed", async () => {
    const context = createContext({
      env: fullEnv(),
      salesPoints: [{ number: 3, blocked: "N", emissionType: "CAE" }],
    });

    expect(await run(context, { salesPoint: 9 })).toBe(1);
    expect(context.stdout()).toContain(
      "El punto de venta 9 no está habilitado para web services."
    );
  });

  it("accepts a point homologación does not report", async () => {
    const context = createContext({ env: fullEnv(), salesPoints: [] });

    expect(await run(context, { salesPoint: 3 })).toBe(0);
    expect(context.stdout()).toContain(
      "✓ puntos de venta        3 (no informado)"
    );
    expect(context.stdout()).toContain(
      "en homologación ARCA suele no informarlos"
    );
  });

  it("still fails for an unlisted point in production", async () => {
    const context = createContext({
      env: fullEnv({ ARCA_ENVIRONMENT: "production" }),
      salesPoints: [],
    });

    expect(await run(context, { salesPoint: 3 })).toBe(1);
    expect(context.stdout()).toContain(
      "El punto de venta 3 no está habilitado para web services."
    );
  });

  it("fails when the requested point is blocked", async () => {
    const context = createContext({
      env: fullEnv(),
      salesPoints: [{ number: 3, blocked: "S", emissionType: "CAE" }],
    });

    expect(await run(context, { salesPoint: 3 })).toBe(1);
    expect(context.stdout()).toContain("El punto de venta 3 está bloqueado.");
  });

  it("shows only the requested point when one is given", async () => {
    const context = createContext({
      env: fullEnv(),
      salesPoints: [
        { number: 3, blocked: "N", emissionType: "CAE" },
        { number: 4, blocked: "N", emissionType: "CAE" },
      ],
    });

    expect(await run(context, { salesPoint: 4 })).toBe(0);
    expect(context.stdout()).toContain(
      "✓ puntos de venta        4 (habilitado, CAE)"
    );
  });
});

describe("runCheck --json", () => {
  it("prints the whole report and omits the layers it never reached", async () => {
    const context = createContext({
      env: fullEnv(),
      salesPointsError: new ArcaAuthenticationError("rechazado", {
        reason: "missing_relationship",
        service: "wsfe",
        operation: "FEParamGetPtosVenta",
      }),
    });

    await runCheck(
      context.io,
      {},
      createWriter(context.io.stdout, { color: false }),
      true
    );

    expect(JSON.parse(context.stdout())).toEqual({
      ok: false,
      environment: "test",
      taxId: "20123456786",
      layers: [
        {
          name: "config",
          ok: true,
          detail: "ARCA_TAX_ID, ARCA_ENVIRONMENT=test",
        },
        {
          name: "certificate",
          ok: true,
          detail: "coinciden, vence 2027-09-05",
          expiresAt: "2027-09-05",
        },
        { name: "wsaa", ok: true, detail: "ticket obtenido" },
        {
          name: "wsfe",
          ok: false,
          code: "ARCA_AUTHENTICATION_ERROR",
          reason: "missing_relationship",
          diagnosis:
            "El certificado no tiene la relación con Facturación Electrónica.",
          fix: "Administrador de Relaciones → Nueva Relación → Webservices → Facturación Electrónica.",
        },
      ],
    });
  });

  it("carries the sales points as data", async () => {
    const context = createContext({
      env: fullEnv(),
      salesPoints: [{ number: 3, blocked: "N", emissionType: "CAE" }],
    });

    await runCheck(
      context.io,
      {},
      createWriter(context.io.stdout, { color: false }),
      true
    );

    expect(JSON.parse(context.stdout()).salesPoints).toEqual([
      { number: 3, blocked: false, system: "CAE" },
    ]);
  });

  it("never prints the ticket, the certificate or the key", async () => {
    const context = createContext({
      env: fullEnv(),
      salesPoints: [{ number: 3, blocked: "N", emissionType: "CAE" }],
    });

    await runCheck(
      context.io,
      {},
      createWriter(context.io.stdout, { color: false }),
      true
    );

    const printed = context.stdout();
    expect(printed).not.toContain("TOKEN-SECRETO");
    expect(printed).not.toContain("FIRMA-SECRETA");
    expect(printed).not.toContain("BEGIN CERTIFICATE");
    expect(printed).not.toContain("BEGIN RSA PRIVATE KEY");
  });
});

type TestContext = ReturnType<typeof createContext>;

function run(context: TestContext, flags: CheckFlags, json = false) {
  return runCheck(
    context.io,
    flags,
    createWriter(context.io.stdout, { color: false }),
    json
  );
}

function fullEnv(overrides: Record<string, string> = {}) {
  return {
    ARCA_TAX_ID: "20123456786",
    ARCA_ENVIRONMENT: "test",
    ARCA_CERTIFICATE_PEM: VALID.certificatePem,
    ARCA_PRIVATE_KEY_PEM: VALID.privateKeyPem,
    ...overrides,
  };
}

function createContext(options: {
  env: Record<string, string | undefined>;
  cwd?: string;
  cacheDir?: string;
  loginError?: unknown;
  serverStatus?: { appServer: string; dbServer: string; authServer: string };
  salesPoints?: WsfeSalesPoint[];
  salesPointsError?: unknown;
  issue?: () => Promise<unknown>;
}) {
  const out: string[] = [];
  const stdout: CliOutputStream = { write: (chunk) => out.push(chunk) };
  const stderr: CliOutputStream = { write: () => undefined };
  const login = vi.fn(
    (_service: ArcaWsaaServiceId, _authOptions?: ArcaAuthOptions) =>
      options.loginError === undefined
        ? Promise.resolve(TICKET)
        : Promise.reject(options.loginError)
  );
  const context = {
    login,
    clientOptions: undefined as Record<string, never> | undefined,
    authOptions: undefined as Record<string, never> | undefined,
    stdout: () => out.join(""),
    io: {} as CliIo,
  } as unknown as {
    login: typeof login;
    authOptions?: {
      environment?: string;
      wsaaSessionStore?: {
        get(key: unknown): Promise<ArcaAuthCredentials | null>;
      };
    };
    clientOptions?: {
      store?: unknown;
      wsaaSessionStore?: {
        get(key: unknown): Promise<ArcaAuthCredentials | null>;
      };
    };
    stdout(): string;
    io: CliIo;
  };

  context.io = {
    stdout,
    stderr,
    stdin: new PassThrough(),
    env: options.env,
    cwd: options.cwd ?? tmpdir(),
    cacheDir: options.cacheDir ?? createTemporaryDirectory(),
    now: () => NOW,
    createClient: (clientOptions) => {
      context.clientOptions = clientOptions as never;
      return {
        wsfe: {
          getServerStatus: () =>
            Promise.resolve(
              options.serverStatus ?? {
                appServer: "OK",
                dbServer: "OK",
                authServer: "OK",
              }
            ),
          getSalesPoints: () =>
            options.salesPointsError === undefined
              ? Promise.resolve(options.salesPoints ?? [])
              : Promise.reject(options.salesPointsError),
        },
        issue: options.issue ?? (() => Promise.reject(new Error("no issue"))),
      } as unknown as ArcaClient;
    },
    createAuth: (authConfig) => {
      context.authOptions = authConfig as never;
      // Mirrors the SDK: a store is read unless the login is forced, and a
      // fresh ticket is written back to it.
      const store = authConfig.wsaaSessionStore;
      const sessionKey = {
        environment: authConfig.environment,
        service: "wsfe",
        certificateFingerprint: "prueba",
      } as const;
      return {
        login: async (
          service: ArcaWsaaServiceId,
          authOptions?: ArcaAuthOptions
        ) => {
          if (store && authOptions?.forceRefresh !== true) {
            const stored = await store.get(sessionKey);
            if (stored) {
              return stored;
            }
          }
          const credentials = await login(service, authOptions);
          await store?.set(sessionKey, credentials);
          return credentials;
        },
      } as never;
    },
  };

  return context;
}

/** A directory that looks like one where `init` ran and ARCA already answered. */
function directoryWith(
  environment: "test" | "production",
  material: { certificatePem: string; privateKeyPem: string }
): string {
  const directory = createTemporaryDirectory();
  writeFileSync(
    join(directory, `arca-${environment}.crt`),
    material.certificatePem
  );
  writeFileSync(
    join(directory, `arca-${environment}.key`),
    material.privateKeyPem
  );
  return directory;
}

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "facturas-check-"));
  temporary.push(directory);
  return directory;
}

/** ARCA writes the CUIT in `serialNumber`; `taxId: null` is a foreign one. */
function createSelfSigned(notAfter: Date, taxId: string | null = TAX_ID) {
  const keyPair = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x01_00_01 });
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keyPair.publicKey;
  certificate.serialNumber = "01";
  certificate.validity.notBefore = new Date("2020-01-01T00:00:00Z");
  certificate.validity.notAfter = notAfter;
  const attributes = [
    { name: "commonName", value: "facturas" },
    ...(taxId === null
      ? []
      : [{ name: "serialNumber", value: `CUIT ${taxId}` }]),
  ];
  certificate.setSubject(attributes);
  certificate.setIssuer([{ name: "commonName", value: "facturas" }]);
  certificate.sign(keyPair.privateKey, forge.md.sha256.create());
  return {
    certificatePem: forge.pki.certificateToPem(certificate),
    privateKeyPem: forge.pki.privateKeyToPem(keyPair.privateKey),
  };
}
