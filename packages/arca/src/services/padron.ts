import type { ReceiverCondition } from "../constants";
import { ArcaSoapFaultError } from "../errors";
import type {
  ArcaClientConfig,
  ArcaPadronServiceName,
} from "../internal/types";
import type { SoapTransport } from "../soap";
import type { WsaaAuthModule } from "../wsaa";

/** One tax registration reported by the constancia de inscripción. */
export type PadronTax = {
  id: number;
  description?: string;
  /** ARCA's state code; `AC` is active. Absent when ARCA omits it. */
  state?: string;
  regime: "general" | "monotributo";
};

/** Result of a taxpayer lookup via Padron A5. */
export type PadronTaxpayerResult = {
  taxId: string;
  personType?: string;
  name?: string;
  /**
   * The receiver condition to invoice this taxpayer under, derived from its
   * active IVA registrations: 30 is responsable inscripto, 20 monotributo, 32
   * exento and 34 no alcanzado. A taxpayer with none of them is a consumidor
   * final. Absent only when the registrations contradict each other.
   */
  condition?: ReceiverCondition;
  taxes: PadronTax[];
  raw: Record<string, unknown>;
};

/** Result of a tax ID lookup by document number via Padron A13. */
export type PadronTaxIdLookupResult = {
  taxIds: string[];
  raw: Record<string, unknown>;
};

/** Padron taxpayer registry service. */
export type PadronService = {
  /** Looks up taxpayer details by CUIT. Returns `null` if the taxpayer does not exist. */
  getTaxpayerDetails(
    taxId: number | string
  ): Promise<PadronTaxpayerResult | null>;
  /** Looks up CUITs associated with a document number. Returns `null` if not found. */
  getTaxIdByDocument(
    documentNumber: number | string
  ): Promise<PadronTaxIdLookupResult | null>;
};

export type CreatePadronServiceOptions = {
  config: ArcaClientConfig;
  auth: WsaaAuthModule;
  soap: SoapTransport;
};

/** Creates a Padron service instance wired with authentication and SOAP transport. */
export function createPadronService(
  options: CreatePadronServiceOptions
): PadronService {
  return {
    async getTaxpayerDetails(taxId) {
      const raw = await executePadronOperation(
        options,
        "padron-a5",
        "getPersona_v2",
        {
          idPersona: Number.parseInt(String(taxId), 10),
        }
      );
      if (!raw) {
        return null;
      }
      const record = raw as Record<string, unknown>;
      if (isPadronNotFound(record)) {
        return null;
      }
      const datosGenerales = record.datosGenerales as
        | Record<string, unknown>
        | undefined;
      const idPersona = record.idPersona ?? datosGenerales?.idPersona;
      const tipoPersona = record.tipoPersona ?? datosGenerales?.tipoPersona;
      const taxes = extractPadronTaxes(record);
      const condition = deriveReceiverCondition(taxes);
      return {
        taxId: String(idPersona ?? taxId),
        ...(tipoPersona === undefined
          ? {}
          : { personType: String(tipoPersona) }),
        ...(datosGenerales ? { name: extractPadronName(datosGenerales) } : {}),
        ...(condition === undefined ? {} : { condition }),
        taxes,
        raw: record,
      };
    },
    async getTaxIdByDocument(documentNumber) {
      const raw = await executePadronOperation(
        options,
        "padron-a13",
        "getIdPersonaListByDocumento",
        {
          documento: String(documentNumber),
        }
      );
      if (!raw) {
        return null;
      }
      const record = raw as Record<string, unknown>;
      const idPersona = record.idPersona;
      const taxIds = Array.isArray(idPersona)
        ? idPersona.map(String)
        : idPersona === undefined
          ? []
          : [String(idPersona)];
      return {
        taxIds,
        raw: record,
      };
    },
  };
}

const IVA_TAX_CONDITIONS: Readonly<Record<number, ReceiverCondition>> = {
  20: "monotributo",
  30: "responsable_inscripto",
  32: "exento",
  34: "no_alcanzado",
};

// The constancia answers a missing CUIT inside errorConstancia, not as a fault.
const NOT_FOUND_PHRASES = [
  "la clave solicitada no existe",
  "no existe persona con ese id",
  "no existe persona con esa clave",
  "persona no encontrada",
  "no se encontro informacion para la clave",
];

function isPadronNotFound(record: Record<string, unknown>): boolean {
  const errorConstancia = record.errorConstancia as
    | { error?: unknown }
    | undefined;
  const errors = errorConstancia?.error;
  const messages = Array.isArray(errors) ? errors : [errors];
  return messages.some(
    (message) =>
      typeof message === "string" &&
      NOT_FOUND_PHRASES.some((phrase) => plainText(message).includes(phrase))
  );
}

function plainText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function extractPadronTaxes(record: Record<string, unknown>): PadronTax[] {
  const taxes: PadronTax[] = [];
  for (const [regime, field] of [
    ["general", "datosRegimenGeneral"],
    ["monotributo", "datosMonotributo"],
  ] as const) {
    const bucket = record[field] as { impuesto?: unknown } | undefined;
    const rows = bucket?.impuesto;
    for (const row of Array.isArray(rows) ? rows : rows ? [rows] : []) {
      const tax = row as Record<string, unknown>;
      const id = Number(tax.idImpuesto);
      if (!Number.isSafeInteger(id)) {
        continue;
      }
      taxes.push({
        id,
        ...(typeof tax.descripcionImpuesto === "string"
          ? { description: tax.descripcionImpuesto }
          : {}),
        ...(typeof tax.estadoImpuesto === "string"
          ? { state: tax.estadoImpuesto.trim().toUpperCase() }
          : {}),
        regime,
      });
    }
  }
  return taxes;
}

/** One active IVA registration decides; none is a consumidor final; two is nobody's call. */
function deriveReceiverCondition(
  taxes: readonly PadronTax[]
): ReceiverCondition | undefined {
  const conditions = new Set<ReceiverCondition>();
  for (const tax of taxes) {
    const condition = IVA_TAX_CONDITIONS[tax.id];
    if (condition && (tax.state === undefined || tax.state === "AC")) {
      conditions.add(condition);
    }
  }
  if (conditions.size === 0) {
    return "consumidor_final";
  }
  return conditions.size === 1 ? [...conditions][0] : undefined;
}

function extractPadronName(
  datosGenerales: Record<string, unknown>
): string | undefined {
  if (typeof datosGenerales.razonSocial === "string") {
    return datosGenerales.razonSocial;
  }
  const nombre = datosGenerales.nombre;
  const apellido = datosGenerales.apellido;
  if (typeof apellido === "string" && typeof nombre === "string") {
    return `${apellido} ${nombre}`.trim();
  }
  if (typeof apellido === "string") {
    return apellido;
  }
  if (typeof nombre === "string") {
    return nombre;
  }
  return undefined;
}

async function executePadronOperation(
  options: CreatePadronServiceOptions,
  service: ArcaPadronServiceName,
  operation: string,
  body: Record<string, unknown>
) {
  const auth = await options.auth.login(
    service === "padron-a5"
      ? "ws_sr_constancia_inscripcion"
      : "ws_sr_padron_a13"
  );

  try {
    const response = await options.soap.execute<
      Record<string, unknown>,
      Record<string, unknown>
    >({
      service,
      operation,
      bodyElementNamespaceMode: "prefix",
      body: {
        token: auth.token,
        sign: auth.sign,
        cuitRepresentada: Number.parseInt(options.config.taxId, 10),
        ...body,
      },
    });

    const operationResponse = response.result as Record<string, unknown>;

    if (operation === "getPersona_v2") {
      return operationResponse.personaReturn ?? null;
    }

    if (operation === "getIdPersonaListByDocumento") {
      return operationResponse.idPersonaListReturn ?? null;
    }

    return operationResponse.return ?? null;
  } catch (error) {
    if (
      error instanceof ArcaSoapFaultError &&
      // Public Padron A5/A13 WSDLs expose only a generic validation fault, so
      // there is no documented not-found-specific fault code to match here.
      // Keep the current message fallback, but treat it as fragile.
      error.message.toLowerCase().includes("no existe")
    ) {
      return null;
    }

    throw error;
  }
}
