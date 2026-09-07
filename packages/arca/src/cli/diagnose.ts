import {
  type ArcaAuthenticationReason,
  ArcaSoapFaultError,
  ArcaTransportError,
  toArcaSafeErrorMetadata,
} from "../errors";
import { ARCA_PAGES } from "./arca-steps";

/** Keys of {@link CLI_DIAGNOSES}. One row of the published diagnosis table. */
export type CliDiagnosisKey =
  | "config.taxId"
  | "config.taxIdUnknown"
  | "config.environment"
  | "config.pem"
  | "config.files.ambiguous"
  | "config.files.missingCertificate"
  | "config.files.missingKey"
  | "cert.invalid"
  | "cert.taxIdMismatch"
  | "cert.mismatch"
  | "cert.expired"
  | "wsaa.certExpired"
  | "wsaa.certUntrusted"
  | "wsaa.signInvalid"
  | "wsaa.notAuthorized"
  | "wsaa.alreadyAuthenticated"
  | "wsaa.clockSkew"
  | "wsaa.transport"
  | "wsfe.missing_relationship"
  | "wsfe.unauthorized_computer"
  | "wsfe.invalid_token"
  | "wsfe.authentication_rejected"
  | "wsfe.serviceError"
  | "salesPoint.missing"
  | "salesPoint.none"
  | "salesPoint.blocked";

/** What went wrong, and the page and action that fix it. Both in castellano. */
export type CliDiagnosis = {
  diagnosis: string;
  fix?: string;
};

/** Values substituted into the `{placeholders}` of a row. */
export type CliDiagnosisValues = {
  certificateTaxId?: string;
  date?: string;
  file?: string;
  files?: string;
  host?: string;
  message?: string;
  missingFile?: string;
  salesPoint?: number;
  taxId?: string;
};

/**
 * The diagnosis table. Every failure the CLI can name has exactly one row, and
 * every row is unit-tested. Nothing here interpolates a PEM, a token or a sign.
 */
export const CLI_DIAGNOSES: Record<CliDiagnosisKey, CliDiagnosis> = {
  "config.taxId": {
    diagnosis: "Falta el CUIT.",
    fix: "export ARCA_TAX_ID=20123456786",
  },
  "config.taxIdUnknown": {
    diagnosis: "El certificado no dice de qué CUIT es.",
    fix: "Pasá --tax-id 20123456786 o definí ARCA_TAX_ID.",
  },
  "config.environment": {
    diagnosis: "Falta el entorno.",
    fix: "export ARCA_ENVIRONMENT=test",
  },
  "config.pem": {
    diagnosis: "Falta el certificado o la clave.",
    fix: "Guardá arca-<entorno>.crt y arca-<entorno>.key acá, o pasá --cert y --key, o definí las variables ARCA_*_PEM.",
  },
  "config.files.ambiguous": {
    diagnosis: "Están {files} en este directorio y no sé cuál querés.",
    fix: "Elegí con --env test o --env production.",
  },
  "config.files.missingCertificate": {
    diagnosis: "Está {file} pero falta {missingFile}.",
    fix: "Descargá el certificado de ARCA y guardalo acá como {missingFile}.",
  },
  "config.files.missingKey": {
    diagnosis: "Está {file} pero falta {missingFile}.",
    fix: "Poné acá la clave con la que generaste el CSR, o pasá --key.",
  },
  "cert.invalid": {
    diagnosis: "El archivo no es un PEM válido.",
    fix: "Revisá que copiaste el bloque completo, con BEGIN y END.",
  },
  "cert.taxIdMismatch": {
    diagnosis:
      "El certificado es del CUIT {certificateTaxId} y el configurado es {taxId}.",
    fix: "Usá el certificado de ese CUIT, o corregí --tax-id o ARCA_TAX_ID.",
  },
  "cert.mismatch": {
    diagnosis: "La clave privada no corresponde a este certificado.",
    fix: "Usá la clave con la que generaste el CSR (arca-<entorno>.key).",
  },
  "cert.expired": {
    diagnosis: "El certificado venció el {date}.",
    fix: "Generá un CSR nuevo con npx facturas init y renovalo en ARCA.",
  },
  "wsaa.certExpired": {
    diagnosis: "El certificado venció.",
    fix: "Generá un CSR nuevo con npx facturas init y renovalo en ARCA.",
  },
  "wsaa.certUntrusted": {
    diagnosis: "ARCA no reconoce este certificado en este entorno.",
    fix: "Homologación y producción tienen certificados propios; revisá ARCA_ENVIRONMENT.",
  },
  "wsaa.signInvalid": {
    diagnosis: "La firma del pedido no es válida.",
    fix: "La clave no corresponde al certificado, o el PEM está truncado.",
  },
  "wsaa.notAuthorized": {
    diagnosis: "El certificado no está autorizado para wsfe.",
    fix: `${ARCA_PAGES.wsassService} → ${ARCA_PAGES.wsassAuthorizeService} (homologación) / ${ARCA_PAGES.relationships} (producción).`,
  },
  "wsaa.alreadyAuthenticated": {
    diagnosis: "Ya hay un ticket vigente para este certificado.",
    fix: "Otro proceso o máquina tiene el ticket vigente. Esperá hasta 12 horas, o corré check desde donde lo pediste.",
  },
  "wsaa.clockSkew": {
    diagnosis: "La hora de tu máquina difiere de la de ARCA.",
    fix: "Sincronizá el reloj (NTP) y volvé a probar.",
  },
  "wsaa.transport": {
    diagnosis: "No se pudo conectar con {host}.",
    fix: "Revisá red, proxy o firewall; ARCA homologación suele caerse los fines de semana.",
  },
  "wsfe.missing_relationship": {
    diagnosis:
      "El certificado no tiene la relación con Facturación Electrónica.",
    fix: `${ARCA_PAGES.relationships} → ${ARCA_PAGES.relationshipsPath}.`,
  },
  "wsfe.unauthorized_computer": {
    diagnosis: "El certificado o computador no está autorizado.",
    fix: "Verificá que el alias esté asociado al servicio en este entorno.",
  },
  "wsfe.invalid_token": {
    diagnosis: "El ticket fue rechazado.",
    fix: "Volvé a ejecutar check; si persiste, revisá el reloj.",
  },
  "wsfe.authentication_rejected": {
    diagnosis: "ARCA denegó el acceso al servicio.",
    fix: "Revisá entorno y relación del certificado.",
  },
  "wsfe.serviceError": {
    diagnosis: "ARCA respondió con un error: {message}.",
  },
  "salesPoint.missing": {
    diagnosis:
      "El punto de venta {salesPoint} no está habilitado para web services.",
    fix: `ARCA → ${ARCA_PAGES.salesPoints} → Nuevo → el sistema de web services de tu condición ("${ARCA_PAGES.salesPointsSystem}" para responsable inscripto).`,
  },
  "salesPoint.none": {
    diagnosis: "ARCA no informa ningún punto de venta para web services.",
    fix: `ARCA → ${ARCA_PAGES.salesPoints} → Nuevo → "${ARCA_PAGES.salesPointsSystem}" para responsable inscripto, "${ARCA_PAGES.salesPointsSystemMonotributo}" para monotributo.`,
  },
  "salesPoint.blocked": {
    diagnosis: "El punto de venta {salesPoint} está bloqueado.",
    fix: "Revisalo en ARCA.",
  },
};

/** Resolves one row and fills its `{placeholders}`. */
export function diagnose(
  key: CliDiagnosisKey,
  values: CliDiagnosisValues = {}
): CliDiagnosis {
  const row = CLI_DIAGNOSES[key];
  return {
    diagnosis: fill(row.diagnosis, values),
    ...(row.fix === undefined ? {} : { fix: fill(row.fix, values) }),
  };
}

/** Maps `ArcaAuthenticationError.reason` to its row. */
export function diagnoseAuthenticationReason(
  reason: ArcaAuthenticationReason
): CliDiagnosis {
  return diagnose(`wsfe.${reason}`);
}

const WSAA_FAULT_ROWS: Readonly<Record<string, CliDiagnosisKey>> = {
  "cms.cert.expired": "wsaa.certExpired",
  "cms.cert.untrusted": "wsaa.certUntrusted",
  "cms.cert.invalid": "wsaa.certUntrusted",
  "cms.cert.notfound": "wsaa.certUntrusted",
  "cms.bad": "wsaa.signInvalid",
  "cms.sign.invalid": "wsaa.signInvalid",
  "coe.notauthorized": "wsaa.notAuthorized",
  "coe.alreadyauthenticated": "wsaa.alreadyAuthenticated",
  "xml.generationtime.invalid": "wsaa.clockSkew",
  "xml.expirationtime.invalid": "wsaa.clockSkew",
  "xml.expirationtime.expired": "wsaa.clockSkew",
};

/**
 * Maps a WSAA SOAP fault code to its row. ARCA prefixes the code with a SOAP
 * namespace (`ns1:coe.notAuthorized`), so the prefix is dropped first.
 */
export function diagnoseWsaaFaultCode(
  faultCode: string | undefined
): CliDiagnosisKey | undefined {
  if (faultCode === undefined) {
    return undefined;
  }
  const bare = faultCode.slice(faultCode.indexOf(":") + 1).toLowerCase();
  const exact = WSAA_FAULT_ROWS[bare];
  if (exact) {
    return exact;
  }
  return bare.startsWith("xml.expirationtime.") ? "wsaa.clockSkew" : undefined;
}

/** The SOAP fault carried by an error, or by the error the SDK wrapped it in. */
export function findSoapFault(error: unknown): ArcaSoapFaultError | undefined {
  if (error instanceof ArcaSoapFaultError) {
    return error;
  }
  const cause = error instanceof Error ? error.cause : undefined;
  return cause instanceof ArcaSoapFaultError ? cause : undefined;
}

/** The transport failure carried by an error, or by its cause. */
export function findTransportError(
  error: unknown
): ArcaTransportError | undefined {
  if (error instanceof ArcaTransportError) {
    return error;
  }
  const cause = error instanceof Error ? error.cause : undefined;
  return cause instanceof ArcaTransportError ? cause : undefined;
}

/** Fallback for anything the table does not name. Never prints credentials. */
export function describeUnknownError(error: unknown): {
  diagnosis: string;
  code?: string;
} {
  const safe = toArcaSafeErrorMetadata(error);
  return {
    diagnosis: safe.message,
    ...(safe.code === undefined ? {} : { code: safe.code }),
  };
}

function fill(text: string, values: CliDiagnosisValues): string {
  return text.replace(
    /\{(certificateTaxId|date|file|files|host|message|missingFile|salesPoint|taxId)\}/g,
    (match, key) => {
      const value = values[key as keyof CliDiagnosisValues];
      return value === undefined ? match : String(value);
    }
  );
}
