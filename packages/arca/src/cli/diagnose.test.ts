import { describe, expect, it } from "vitest";
import {
  ArcaAuthenticationError,
  ArcaSoapFaultError,
  ArcaTransportError,
} from "../errors";
import { ARCA_PAGES } from "./arca-steps";
import {
  CLI_DIAGNOSES,
  type CliDiagnosisKey,
  describeUnknownError,
  diagnose,
  diagnoseAuthenticationReason,
  diagnoseWsaaFaultCode,
  findSoapFault,
  findTransportError,
} from "./diagnose";

/** Every published row, asserted one by one. This is the contract. */
const ROWS: [CliDiagnosisKey, string, string | undefined][] = [
  ["config.taxId", "Falta el CUIT.", "export ARCA_TAX_ID=20123456786"],
  [
    "config.taxIdUnknown",
    "El certificado no dice de qué CUIT es.",
    "Pasá --tax-id 20123456786 o definí ARCA_TAX_ID.",
  ],
  ["config.environment", "Falta el entorno.", "export ARCA_ENVIRONMENT=test"],
  [
    "config.pem",
    "Falta el certificado o la clave.",
    "Guardá arca-<entorno>.crt y arca-<entorno>.key acá, o pasá --cert y --key, o definí las variables ARCA_*_PEM.",
  ],
  [
    "config.files.ambiguous",
    "Están {files} en este directorio y no sé cuál querés.",
    "Elegí con --env test o --env production.",
  ],
  [
    "config.files.missingCertificate",
    "Está {file} pero falta {missingFile}.",
    "Descargá el certificado de ARCA y guardalo acá como {missingFile}.",
  ],
  [
    "config.files.missingKey",
    "Está {file} pero falta {missingFile}.",
    "Poné acá la clave con la que generaste el CSR, o pasá --key.",
  ],
  [
    "cert.invalid",
    "El archivo no es un PEM válido.",
    "Revisá que copiaste el bloque completo, con BEGIN y END.",
  ],
  [
    "cert.taxIdMismatch",
    "El certificado es del CUIT {certificateTaxId} y el configurado es {taxId}.",
    "Usá el certificado de ese CUIT, o corregí --tax-id o ARCA_TAX_ID.",
  ],
  [
    "cert.mismatch",
    "La clave privada no corresponde a este certificado.",
    "Usá la clave con la que generaste el CSR (arca-<entorno>.key).",
  ],
  [
    "cert.expired",
    "El certificado venció el {date}.",
    "Generá un CSR nuevo con npx facturas init y renovalo en ARCA.",
  ],
  [
    "wsaa.certExpired",
    "El certificado venció.",
    "Generá un CSR nuevo con npx facturas init y renovalo en ARCA.",
  ],
  [
    "wsaa.certUntrusted",
    "ARCA no reconoce este certificado en este entorno.",
    "Homologación y producción tienen certificados propios; revisá ARCA_ENVIRONMENT.",
  ],
  [
    "wsaa.signInvalid",
    "La firma del pedido no es válida.",
    "La clave no corresponde al certificado, o el PEM está truncado.",
  ],
  [
    "wsaa.notAuthorized",
    "El certificado no está autorizado para wsfe.",
    `${ARCA_PAGES.wsassService} → ${ARCA_PAGES.wsassAuthorizeService} (homologación) / ${ARCA_PAGES.relationships} (producción).`,
  ],
  [
    "wsaa.alreadyAuthenticated",
    "Ya hay un ticket vigente para este certificado.",
    "Otro proceso o máquina tiene el ticket vigente. Esperá hasta 12 horas, o corré check desde donde lo pediste.",
  ],
  [
    "wsaa.clockSkew",
    "La hora de tu máquina difiere de la de ARCA.",
    "Sincronizá el reloj (NTP) y volvé a probar.",
  ],
  [
    "wsaa.transport",
    "No se pudo conectar con {host}.",
    "Revisá red, proxy o firewall; ARCA homologación suele caerse los fines de semana.",
  ],
  [
    "wsfe.missing_relationship",
    "El certificado no tiene la relación con Facturación Electrónica.",
    `${ARCA_PAGES.relationships} → ${ARCA_PAGES.relationshipsPath}.`,
  ],
  [
    "wsfe.unauthorized_computer",
    "El certificado o computador no está autorizado.",
    "Verificá que el alias esté asociado al servicio en este entorno.",
  ],
  [
    "wsfe.invalid_token",
    "El ticket fue rechazado.",
    "Volvé a ejecutar check; si persiste, revisá el reloj.",
  ],
  [
    "wsfe.authentication_rejected",
    "ARCA denegó el acceso al servicio.",
    "Revisá entorno y relación del certificado.",
  ],
  ["wsfe.serviceError", "ARCA respondió con un error: {message}.", undefined],
  [
    "salesPoint.missing",
    "El punto de venta {salesPoint} no está habilitado para web services.",
    `ARCA → ${ARCA_PAGES.salesPoints} → Nuevo → el sistema de web services de tu condición ("${ARCA_PAGES.salesPointsSystem}" para responsable inscripto).`,
  ],
  [
    "salesPoint.none",
    "ARCA no informa ningún punto de venta para web services.",
    `ARCA → ${ARCA_PAGES.salesPoints} → Nuevo → "${ARCA_PAGES.salesPointsSystem}" para responsable inscripto, "${ARCA_PAGES.salesPointsSystemMonotributo}" para monotributo.`,
  ],
  [
    "salesPoint.blocked",
    "El punto de venta {salesPoint} está bloqueado.",
    "Revisalo en ARCA.",
  ],
];

describe("CLI_DIAGNOSES", () => {
  it.each(ROWS)("row %s", (key, expectedDiagnosis, expectedFix) => {
    expect(CLI_DIAGNOSES[key].diagnosis).toBe(expectedDiagnosis);
    expect(CLI_DIAGNOSES[key].fix).toBe(expectedFix);
  });

  it("covers every key exactly once, with no extra row", () => {
    expect(Object.keys(CLI_DIAGNOSES).sort()).toEqual(
      ROWS.map(([key]) => key).sort()
    );
  });

  it("never carries a PEM, a token or a signature", () => {
    for (const row of Object.values(CLI_DIAGNOSES)) {
      const text = `${row.diagnosis} ${row.fix ?? ""}`;
      expect(text).not.toContain("-----BEGIN");
      expect(text).not.toMatch(/token|sign(ature)?=/i);
    }
  });
});

describe("diagnose", () => {
  it("fills the date of an expired certificate", () => {
    expect(diagnose("cert.expired", { date: "2026-01-31" }).diagnosis).toBe(
      "El certificado venció el 2026-01-31."
    );
  });

  it("fills the host of a transport failure", () => {
    expect(
      diagnose("wsaa.transport", { host: "wsaahomo.afip.gov.ar" }).diagnosis
    ).toBe("No se pudo conectar con wsaahomo.afip.gov.ar.");
  });

  it("fills the sales point in both its rows", () => {
    expect(
      diagnose("salesPoint.missing", { salesPoint: 7 }).diagnosis
    ).toContain("punto de venta 7");
    expect(diagnose("salesPoint.blocked", { salesPoint: 7 }).diagnosis).toBe(
      "El punto de venta 7 está bloqueado."
    );
  });

  it("leaves a placeholder alone when no value is given", () => {
    expect(diagnose("wsfe.serviceError").diagnosis).toBe(
      "ARCA respondió con un error: {message}."
    );
  });
});

describe("diagnoseAuthenticationReason", () => {
  it.each([
    [
      "missing_relationship",
      "El certificado no tiene la relación con Facturación Electrónica.",
    ],
    [
      "unauthorized_computer",
      "El certificado o computador no está autorizado.",
    ],
    ["invalid_token", "El ticket fue rechazado."],
    ["authentication_rejected", "ARCA denegó el acceso al servicio."],
  ] as const)("maps %s", (reason, expected) => {
    expect(diagnoseAuthenticationReason(reason).diagnosis).toBe(expected);
  });
});

describe("diagnoseWsaaFaultCode", () => {
  it.each([
    ["ns1:cms.cert.expired", "wsaa.certExpired"],
    ["ns1:cms.cert.untrusted", "wsaa.certUntrusted"],
    ["cms.cert.invalid", "wsaa.certUntrusted"],
    ["ns1:cms.bad", "wsaa.signInvalid"],
    ["cms.sign.invalid", "wsaa.signInvalid"],
    ["ns1:coe.notAuthorized", "wsaa.notAuthorized"],
    ["ns1:coe.alreadyAuthenticated", "wsaa.alreadyAuthenticated"],
    ["ns1:xml.generationTime.invalid", "wsaa.clockSkew"],
    ["ns1:xml.expirationTime.invalid", "wsaa.clockSkew"],
    ["ns1:xml.expirationTime.expired", "wsaa.clockSkew"],
  ])("maps %s", (faultCode, expected) => {
    expect(diagnoseWsaaFaultCode(faultCode)).toBe(expected);
  });

  it("returns undefined for a fault it does not know", () => {
    expect(diagnoseWsaaFaultCode("ns1:something.else")).toBeUndefined();
    expect(diagnoseWsaaFaultCode(undefined)).toBeUndefined();
  });
});

describe("findSoapFault and findTransportError", () => {
  it("finds a fault the SDK wrapped in another error", () => {
    const fault = new ArcaSoapFaultError("fault", {
      faultCode: "ns1:coe.alreadyAuthenticated",
    });
    expect(findSoapFault(fault)).toBe(fault);
    expect(findSoapFault(new Error("wrapped", { cause: fault }))).toBe(fault);
    expect(findSoapFault(new Error("plain"))).toBeUndefined();
  });

  it("finds a transport failure the SDK wrapped in another error", () => {
    const transport = new ArcaTransportError("down");
    expect(findTransportError(transport)).toBe(transport);
    expect(findTransportError(new Error("wrapped", { cause: transport }))).toBe(
      transport
    );
    expect(findTransportError(new Error("plain"))).toBeUndefined();
  });
});

describe("describeUnknownError", () => {
  it("falls back to the SDK's safe message and code", () => {
    const error = new ArcaAuthenticationError("rechazado", {
      reason: "invalid_token",
      service: "wsfe",
      operation: "FEDummy",
    });
    expect(describeUnknownError(error)).toEqual({
      diagnosis: "rechazado",
      code: "ARCA_AUTHENTICATION_ERROR",
    });
  });

  it("keeps the SDK's redaction of tokens and signatures", () => {
    const fault = new ArcaSoapFaultError(
      "<token>SECRETO</token><sign>FIRMA</sign>"
    );
    const described = describeUnknownError(fault);
    expect(described.diagnosis).not.toContain("SECRETO");
    expect(described.diagnosis).not.toContain("FIRMA");
    expect(described.diagnosis).toContain("[REDACTED]");
  });

  it("stringifies a non-error without touching it", () => {
    expect(describeUnknownError("roto")).toEqual({ diagnosis: "roto" });
  });
});
