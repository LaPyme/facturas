import {
  ArcaInputError,
  ArcaInvalidSoapResponseError,
  ArcaServiceError,
  ArcaSoapFaultError,
  ArcaTransportError,
} from "../errors";
import {
  classifyArcaAuthenticationError,
  classifyArcaAuthenticationIssues,
  createArcaAuthenticationEvidence,
  executeWithAuthenticationRecovery,
} from "../internal/authentication";
import { toIsoDate } from "../internal/dates";
import {
  serializeArcaAmount,
  serializeArcaExchangeRate,
} from "../internal/decimal";
import type { ArcaClientConfig, ArcaRepresentedTaxId } from "../internal/types";
import type { SoapTransport } from "../soap";
import type { WsaaAuthModule } from "../wsaa";
import type {
  ArcaAuthorizationIndeterminateReason,
  ArcaAuthorizationOutcome,
  ArcaFiscalIssue,
  ArcaFiscalResultLevel,
  ArcaVoucherLookupResult,
} from "./fiscal-evidence";

/** Factura E (19), Nota de Débito E (20) and Nota de Crédito E (21). */
export type WsfexVoucherType = 19 | 20 | 21;
/** `Tipo_expo`: goods (1), services (2) or other (4). */
export type WsfexExportType = 1 | 2 | 4;
/** `Idioma_cbte`: Spanish (1), English (2) or Portuguese (3). */
export type WsfexLanguage = 1 | 2 | 3;

/**
 * One `Item`. Money is in major units like `WsfeVoucherInput`: `amount` has
 * at most two decimals, `discount` at most six. `unitPrice` is a decimal
 * string with up to six decimals, the SDK's one monetary exception.
 */
export type WsfexItem = {
  code?: string;
  description: string;
  /** A number, or an exact decimal string; a lookup answers the string. */
  quantity?: number | string;
  unit: number;
  unitPrice?: string;
  /** A number, or an exact decimal string; a lookup answers the string. */
  discount?: number | string;
  amount: number;
};
export type WsfexPermit = { id: string; destination: number };
export type WsfexAssociatedVoucher = {
  voucherType: number;
  salesPoint: number;
  number: number;
  issuerTaxId?: string;
};

/**
 * The fiscal content of one `FEXAuthorize` `Cmp`, without its request `Id`
 * and number. Dates are `YYYYMMDD`. Field order here is not the wire order:
 * the service serializes in WSDL order.
 */
export type WsfexVoucherInput = {
  voucherType: WsfexVoucherType;
  salesPoint: number;
  voucherDate?: string;
  exportType: WsfexExportType;
  /** `Permiso_existente`: absent sends it empty, as notes and services require. */
  permitExists?: "S" | "N";
  permits?: readonly WsfexPermit[];
  /** `Dst_cmp`, an ARCA country code from `getCountries()`. */
  destination: number;
  receiverName: string;
  /** `Cuit_pais_cliente`, one of `getCountryTaxIds()`. */
  receiverCountryTaxId?: string;
  receiverAddress: string;
  /** `Id_impositivo`, the receiver's tax ID abroad. */
  receiverTaxId?: string;
  currencyId: string;
  /** `Moneda_ctz` as an exact decimal string; ARCA may fill it when `sameCurrencyForeignCancellation` is `S`. */
  exchangeRate?: string;
  /** `CanMisMonExt`. Invoices in a foreign currency only. */
  sameCurrencyForeignCancellation?: "S" | "N";
  commercialObservations?: string;
  totalAmount: number;
  observations?: string;
  associatedVouchers?: readonly WsfexAssociatedVoucher[];
  /** `Forma_pago`, required on invoices (rule 1620). */
  paymentTerms?: string;
  incoterms?: string;
  incotermsDetail?: string;
  language: WsfexLanguage;
  items: readonly WsfexItem[];
  /** `Fecha_pago`, required on service and other invoices (rule 1672). */
  paymentDate?: string;
  activities?: readonly { id: string }[];
};

export type WsfexIssueInput = WsfexVoucherInput & {
  /** `Cmp.Id`. Resending the same id returns ARCA's stored answer. */
  id: number;
  number: number;
  representedTaxId?: number | string;
  forceRefresh?: boolean;
  abortSignal?: AbortSignal;
};

/**
 * Structured evidence of one `FEXAuthorize`. `echo` is what ARCA says it
 * authorized: callers must compare it with what they sent, since a reused
 * `Id` returns another request's stored answer with `reprocessed: true`.
 */
export type WsfexAuthorizationOutcome = ArcaAuthorizationOutcome<"wsfex"> & {
  reprocessed?: boolean;
  echo?: {
    id?: number;
    salesPoint?: number;
    voucherType?: number;
    number?: number;
    date?: string;
  };
};

/** One authorized voucher as `FEXGetCMP` reports it, in ARCA's units. */
export type WsfexVoucherInfo = Omit<
  WsfexVoucherInput,
  "voucherType" | "language" | "exportType"
> & {
  id?: number;
  voucherType: number;
  number: number;
  exportType?: number;
  language?: number;
  result?: string;
  cae?: string;
  /** `Fch_venc_Cae`, `YYYYMMDD`. */
  caeExpiry?: string;
  /** `Fecha_cbte_cae`, `YYYYMMDD`. */
  authorizedAt?: string;
  observations?: string;
};
export type WsfexVoucherLookupResult = ArcaVoucherLookupResult<
  WsfexVoucherInfo,
  "wsfex"
>;

export type WsfexCatalogEntry = { id: string; description: string };
export type WsfexCountryTaxId = {
  taxId: string;
  description: string;
};
export type WsfexSalesPoint = {
  number: number;
  blocked: boolean;
  /** `YYYY-MM-DD`, absent when active. */
  deactivatedAt?: string;
};
export type WsfexExchangeRate = {
  currencyId: string;
  /** Exact decimal string. */
  rate: string;
  /** `YYYY-MM-DD`. */
  date: string;
};

type Auth = { representedTaxId?: number | string; forceRefresh?: boolean };

export type WsfexService = {
  /**
   * One `FEXAuthorize` with the caller's `Id` and number. Never throws a
   * provider answer: `authorized`, `rejected` or `indeterminate`. Transport
   * retries are safe because ARCA answers a repeated `Id` from its records.
   */
  issue(input: WsfexIssueInput): Promise<WsfexAuthorizationOutcome>;
  /** `FEXGetLast_ID`: the highest request `Id` ARCA received for the CUIT. */
  getLastRequestId(
    input?: Auth & { abortSignal?: AbortSignal }
  ): Promise<number>;
  /** `FEXGetLast_CMP`: the last authorized number; `0` when none. */
  getLastVoucherNumber(
    input: Auth & {
      salesPoint: number;
      voucherType: number;
      abortSignal?: AbortSignal;
    }
  ): Promise<number>;
  /** `FEXGetCMP`; error 1020 becomes `not_found`. */
  lookupVoucher(
    input: Auth & {
      salesPoint: number;
      voucherType: number;
      number: number;
      abortSignal?: AbortSignal;
    }
  ): Promise<WsfexVoucherLookupResult>;
  getSalesPoints(input?: Auth): Promise<WsfexSalesPoint[]>;
  getCountries(input?: Auth): Promise<WsfexCatalogEntry[]>;
  getCountryTaxIds(input?: Auth): Promise<WsfexCountryTaxId[]>;
  getCurrencies(input?: Auth): Promise<WsfexCatalogEntry[]>;
  getIncoterms(input?: Auth): Promise<WsfexCatalogEntry[]>;
  getUnits(input?: Auth): Promise<WsfexCatalogEntry[]>;
  getLanguages(input?: Auth): Promise<WsfexCatalogEntry[]>;
  getVoucherTypes(input?: Auth): Promise<WsfexCatalogEntry[]>;
  getExportTypes(input?: Auth): Promise<WsfexCatalogEntry[]>;
  getActivities(input?: Auth): Promise<WsfexCatalogEntry[]>;
  /**
   * `FEXGetPARAM_Ctz`. ARCA's rate for `date` (`YYYY-MM-DD`), or its latest
   * when omitted. Homologation answers a test rate, not the real one.
   */
  getExchangeRate(
    input: Auth & { currencyId: string; date?: string }
  ): Promise<WsfexExchangeRate>;
  /** `FEXCheck_Permiso`: whether a shipping permit exists for a destination. */
  checkPermit(
    input: Auth & { id: string; destination: number }
  ): Promise<boolean>;
};

export type CreateWsfexServiceOptions = {
  config: ArcaClientConfig;
  auth: WsaaAuthModule;
  soap: SoapTransport;
};

type WsfexCallInput = {
  representedTaxId?: ArcaRepresentedTaxId;
  forceRefresh?: boolean;
  abortSignal?: AbortSignal;
};

type WsfexEcho = NonNullable<WsfexAuthorizationOutcome["echo"]>;

/** Creates a WSFEX service instance wired with authentication and SOAP transport. */
export function createWsfexService(
  options: CreateWsfexServiceOptions
): WsfexService {
  async function executeWsfexRawOperation(
    operation: string,
    input: WsfexCallInput,
    body: Record<string, unknown> = {},
    authFields: Record<string, unknown> = {}
  ) {
    const auth = await options.auth.login("wsfex", {
      representedTaxId: input.representedTaxId,
      forceRefresh: input.forceRefresh,
      abortSignal: input.abortSignal,
    });
    const response = await options.soap.execute<
      Record<string, unknown>,
      Record<string, unknown>
    >({
      service: "wsfex",
      operation,
      signal: input.abortSignal,
      body: {
        Auth: {
          ...createWsfexAuth(
            input.representedTaxId ?? options.config.taxId,
            auth.token,
            auth.sign
          ),
          ...authFields,
        },
        ...body,
      },
    });

    return unwrapWsfexOperationEnvelope(operation, response.result);
  }

  function executeWsfexOperation(
    operation: string,
    input: WsfexCallInput,
    body: Record<string, unknown> = {},
    authFields: Record<string, unknown> = {}
  ) {
    return executeWithAuthenticationRecovery({
      service: "wsfex",
      operation,
      forceRefresh: input.forceRefresh,
      async execute(forceRefresh) {
        const result = await executeWsfexRawOperation(
          operation,
          {
            representedTaxId: input.representedTaxId,
            forceRefresh,
            abortSignal: input.abortSignal,
          },
          body,
          authFields
        );
        throwForWsfexOperationError(operation, result);
        return result;
      },
    });
  }

  async function getWsfexResultRows(
    operation: string,
    rowKey: string,
    input: Auth
  ) {
    const result = await executeWsfexOperation(operation, {
      representedTaxId: input.representedTaxId,
      forceRefresh: input.forceRefresh,
    });
    return getWsfexRows(result.FEXResultGet, rowKey);
  }

  async function getWsfexCatalog(
    operation: string,
    rowKey: string,
    fields: { id: string; description: string },
    input: Auth
  ): Promise<WsfexCatalogEntry[]> {
    const rows = await getWsfexResultRows(operation, rowKey, input);
    return rows.flatMap((row) => {
      const id = readWsfexText(row[fields.id]);
      return id === undefined
        ? []
        : [{ id, description: readWsfexText(row[fields.description]) ?? "" }];
    });
  }

  function issue(input: WsfexIssueInput): Promise<WsfexAuthorizationOutcome> {
    const request = createWsfexRequest(input);
    return executeWsfexAuthorization(input, request);
  }

  async function executeWsfexAuthorization(
    input: WsfexIssueInput,
    request: Record<string, unknown>
  ): Promise<WsfexAuthorizationOutcome> {
    try {
      // No `retries` override: ARCA answers a repeated Cmp.Id from its
      // records (Reproceso=S), so a resent request cannot authorize twice.
      const result = await executeWsfexRawOperation(
        "FEXAuthorize",
        {
          representedTaxId: input.representedTaxId,
          forceRefresh: input.forceRefresh,
          abortSignal: input.abortSignal,
        },
        { Cmp: request }
      );
      return classifyWsfexAuthorization(result);
    } catch (error) {
      return createWsfexIndeterminateOutcome(error);
    }
  }

  function lookupVoucher(
    input: Parameters<WsfexService["lookupVoucher"]>[0]
  ): Promise<WsfexVoucherLookupResult> {
    return executeWithAuthenticationRecovery({
      service: "wsfex",
      operation: "FEXGetCMP",
      forceRefresh: input.forceRefresh,
      execute: (forceRefresh) => lookupVoucherOnce({ ...input, forceRefresh }),
    });
  }

  async function lookupVoucherOnce(
    input: Parameters<WsfexService["lookupVoucher"]>[0]
  ): Promise<WsfexVoucherLookupResult> {
    const operation = "FEXGetCMP";
    const result = await executeWsfexRawOperation(operation, input, {
      // ClsFEXGetCMP spells it `Cbte_tipo`; the manual's `Cbte_Tipo` would
      // be dropped by the server and consult type 0.
      Cmp: {
        Cbte_tipo: input.voucherType,
        Punto_vta: input.salesPoint,
        Cbte_nro: input.number,
      },
    });
    const errors = extractWsfexErrors(result, operation);

    if (errors.length > 0 && errors.every((issue) => issue.code === "1020")) {
      return {
        kind: "not_found",
        service: "wsfex",
        operation,
        errors,
        observations: [],
        raw: result,
      };
    }

    if (errors.length > 0) {
      throw createWsfexServiceError(operation, errors);
    }

    const raw = toWsfexRecord(result.FEXResultGet);
    if (!raw) {
      throw new ArcaServiceError("WSFEX did not return the consulted voucher", {
        service: "wsfex",
        operation,
      });
    }

    return {
      kind: "found",
      service: "wsfex",
      operation,
      voucher: mapWsfexVoucherInfo(raw),
      observations: extractWsfexReasons(
        raw.Motivos_Obs,
        operation,
        "observation"
      ),
      raw: result,
    };
  }

  return {
    issue,
    async getLastRequestId(input = {}) {
      const operation = "FEXGetLast_ID";
      const result = await executeWsfexOperation(operation, input);
      return parseWsfexInteger(toWsfexRecord(result.FEXResultGet)?.Id, {
        operation,
        field: "Id",
        min: 0,
        max: WSFEX_MAX_REQUEST_ID,
      });
    },
    async getLastVoucherNumber({ salesPoint, voucherType, ...input }) {
      const operation = "FEXGetLast_CMP";
      // The only operation whose point and type travel inside Auth.
      const result = await executeWsfexOperation(
        operation,
        input,
        {},
        { Pto_venta: salesPoint, Cbte_Tipo: voucherType }
      );
      return parseWsfexInteger(
        toWsfexRecord(result.FEXResult_LastCMP)?.Cbte_nro,
        { operation, field: "Cbte_nro", min: 0, max: 99_999_999 }
      );
    },
    lookupVoucher,
    async getSalesPoints(input = {}) {
      const rows = await getWsfexResultRows(
        "FEXGetPARAM_PtoVenta",
        "ClsFEXResponse_PtoVenta",
        input
      );
      return rows.map(mapWsfexSalesPoint);
    },
    getCountries(input = {}) {
      return getWsfexCatalog(
        "FEXGetPARAM_DST_pais",
        "ClsFEXResponse_DST_pais",
        { id: "DST_Codigo", description: "DST_Ds" },
        input
      );
    },
    async getCountryTaxIds(input = {}) {
      const rows = await getWsfexResultRows(
        "FEXGetPARAM_DST_CUIT",
        "ClsFEXResponse_DST_cuit",
        input
      );
      return rows.flatMap((row) => {
        const taxId = readWsfexText(row.DST_CUIT);
        return taxId === undefined
          ? []
          : [{ taxId, description: readWsfexText(row.DST_Ds) ?? "" }];
      });
    },
    getCurrencies(input = {}) {
      return getWsfexCatalog(
        "FEXGetPARAM_MON",
        "ClsFEXResponse_Mon",
        { id: "Mon_Id", description: "Mon_Ds" },
        input
      );
    },
    getIncoterms(input = {}) {
      return getWsfexCatalog(
        "FEXGetPARAM_Incoterms",
        "ClsFEXResponse_Inc",
        { id: "Inc_Id", description: "Inc_Ds" },
        input
      );
    },
    getUnits(input = {}) {
      return getWsfexCatalog(
        "FEXGetPARAM_UMed",
        "ClsFEXResponse_UMed",
        { id: "Umed_Id", description: "Umed_Ds" },
        input
      );
    },
    getLanguages(input = {}) {
      return getWsfexCatalog(
        "FEXGetPARAM_Idiomas",
        "ClsFEXResponse_Idi",
        { id: "Idi_Id", description: "Idi_Ds" },
        input
      );
    },
    getVoucherTypes(input = {}) {
      return getWsfexCatalog(
        "FEXGetPARAM_Cbte_Tipo",
        "ClsFEXResponse_Cbte_Tipo",
        { id: "Cbte_Id", description: "Cbte_Ds" },
        input
      );
    },
    getExportTypes(input = {}) {
      return getWsfexCatalog(
        "FEXGetPARAM_Tipo_Expo",
        "ClsFEXResponse_Tex",
        { id: "Tex_Id", description: "Tex_Ds" },
        input
      );
    },
    async getActivities(input = {}) {
      const rows = await getWsfexResultRows(
        "FEXGetPARAM_Actividades",
        "ClsFEXResponse_ActividadTipo",
        input
      );
      return rows.flatMap((row) => {
        const id = toWsfexActivityId(row.Id);
        return id === undefined
          ? []
          : [{ id, description: readWsfexText(row.Desc) ?? "" }];
      });
    },
    async getExchangeRate({ currencyId, date, ...input }) {
      const operation = "FEXGetPARAM_Ctz";
      // Error 1003 documents FchCotiz as YYYY-MM-DD, unlike every other
      // WSFEX date.
      const quotationDate =
        date === undefined
          ? undefined
          : toIsoDate(normalizeWsfexDate(date, "date"));
      const result = await executeWsfexOperation(operation, input, {
        Mon_id: currencyId,
        ...optionalWsfexField("FchCotiz", quotationDate),
      });
      const raw = toWsfexRecord(result.FEXResultGet);
      const rate = canonicalizeWsfexDecimal(raw?.Mon_ctz);
      const rateDate = toIsoDate(readWsfexText(raw?.Mon_fecha));
      if (rate === undefined || rateDate === undefined) {
        throw new ArcaInvalidSoapResponseError("Invalid WSFEX exchange rate", {
          service: "wsfex",
          operation,
        });
      }
      return { currencyId, rate, date: rateDate };
    },
    async checkPermit({ id, destination, ...input }) {
      const operation = "FEXCheck_Permiso";
      const result = await executeWsfexOperation(operation, input, {
        ID_Permiso: id,
        Dst_merc: destination,
      });
      const status = readWsfexText(
        toWsfexRecord(result.FEXResultGet)?.Status
      )?.toUpperCase();
      if (status === "OK" || status === "NO") {
        return status === "OK";
      }
      throw new ArcaInvalidSoapResponseError("Invalid WSFEX permit status", {
        service: "wsfex",
        operation,
      });
    },
  };
}

const WSFEX_MAX_REQUEST_ID = 999_999_999_999_999;
const WSFEX_VOUCHER_TYPES = [19, 20, 21] as const;
const WSFEX_EXPORT_TYPES = [1, 2, 4] as const;
const WSFEX_LANGUAGES = [1, 2, 3] as const;
// Pro_qty, Pro_precio_uni and Pro_bonificacion are N12,6.
const WSFEX_ITEM_DECIMAL_PATTERN = /^(\d{1,12})(?:\.(\d{1,6}))?$/;
const WSFEX_TAX_ID_PATTERN = /^\d{11}$/;

/**
 * Builds `Cmp` in `ClsFEXRequest` sequence order, checking only the shape of
 * each field. Business rules (which fields a voucher type needs) belong to the
 * caller and to ARCA.
 */
/**
 * Throws every structural error `issue()` would throw for this voucher, with
 * no I/O. Run it before a reservation stores the voucher, so a retry never
 * replays one that cannot be sent.
 */
export function assertWsfexVoucherInput(voucher: WsfexVoucherInput): void {
  createWsfexRequest({ ...voucher, id: 0, number: 1 });
}

function createWsfexRequest(input: WsfexIssueInput): Record<string, unknown> {
  return {
    Id: assertWsfexInteger(input.id, "id", 0, WSFEX_MAX_REQUEST_ID),
    ...optionalWsfexField(
      "Fecha_cbte",
      normalizeOptionalWsfexDate(input.voucherDate, "voucherDate")
    ),
    Cbte_Tipo: assertWsfexCode(
      input.voucherType,
      "voucherType",
      WSFEX_VOUCHER_TYPES
    ),
    Punto_vta: assertWsfexInteger(input.salesPoint, "salesPoint", 1, 99_999),
    Cbte_nro: assertWsfexInteger(input.number, "number", 1, 99_999_999),
    Tipo_expo: assertWsfexCode(
      input.exportType,
      "exportType",
      WSFEX_EXPORT_TYPES
    ),
    // ARCA expects the element present and empty for notes and services.
    Permiso_existente:
      assertOptionalWsfexFlag(input.permitExists, "permitExists") ?? "",
    ...optionalWsfexField(
      "Permisos",
      createWsfexList(input.permits, "Permiso", createWsfexPermit)
    ),
    Dst_cmp: assertWsfexInteger(input.destination, "destination", 1, 999),
    Cliente: requireWsfexText(input.receiverName, "receiverName"),
    ...optionalWsfexField(
      "Cuit_pais_cliente",
      assertOptionalWsfexTaxId(
        input.receiverCountryTaxId,
        "receiverCountryTaxId"
      )
    ),
    Domicilio_cliente: requireWsfexText(
      input.receiverAddress,
      "receiverAddress"
    ),
    ...optionalWsfexField(
      "Id_impositivo",
      optionalWsfexText(input.receiverTaxId, "receiverTaxId")
    ),
    Moneda_Id: requireWsfexText(input.currencyId, "currencyId"),
    ...optionalWsfexField(
      "Moneda_ctz",
      input.exchangeRate === undefined
        ? undefined
        : serializeArcaExchangeRate(input.exchangeRate, "exchangeRate")
    ),
    ...optionalWsfexField(
      "CanMisMonExt",
      assertOptionalWsfexFlag(
        input.sameCurrencyForeignCancellation,
        "sameCurrencyForeignCancellation"
      )
    ),
    ...optionalWsfexField(
      "Obs_comerciales",
      optionalWsfexText(input.commercialObservations, "commercialObservations")
    ),
    Imp_total: serializeArcaAmount(input.totalAmount, "totalAmount"),
    ...optionalWsfexField(
      "Obs",
      optionalWsfexText(input.observations, "observations")
    ),
    ...optionalWsfexField(
      "Cmps_asoc",
      createWsfexList(
        input.associatedVouchers,
        "Cmp_asoc",
        createWsfexAssociatedVoucher
      )
    ),
    ...optionalWsfexField(
      "Forma_pago",
      optionalWsfexText(input.paymentTerms, "paymentTerms")
    ),
    ...optionalWsfexField(
      "Incoterms",
      optionalWsfexText(input.incoterms, "incoterms")
    ),
    ...optionalWsfexField(
      "Incoterms_Ds",
      optionalWsfexText(input.incotermsDetail, "incotermsDetail")
    ),
    Idioma_cbte: assertWsfexCode(input.language, "language", WSFEX_LANGUAGES),
    Items: createWsfexItems(input.items),
    ...optionalWsfexField(
      "Fecha_pago",
      normalizeOptionalWsfexDate(input.paymentDate, "paymentDate")
    ),
    ...optionalWsfexField(
      "Actividades",
      createWsfexList(input.activities, "Actividad", createWsfexActivity)
    ),
  };
}

// ARCA rejects an empty wrapper (1720, 1820, 2100), so an empty list is absent.
function createWsfexList<T>(
  rows: readonly T[] | undefined,
  key: string,
  map: (row: T, index: number) => Record<string, unknown>
): Record<string, unknown> | undefined {
  if (rows === undefined || rows.length === 0) {
    return undefined;
  }
  return { [key]: rows.map(map) };
}

function createWsfexPermit(permit: WsfexPermit, index: number) {
  return {
    Id_permiso: requireWsfexText(permit.id, `permits[${index}].id`),
    Dst_merc: assertWsfexInteger(
      permit.destination,
      `permits[${index}].destination`,
      1,
      999
    ),
  };
}

function createWsfexAssociatedVoucher(
  voucher: WsfexAssociatedVoucher,
  index: number
) {
  const field = `associatedVouchers[${index}]`;
  return {
    Cbte_tipo: assertWsfexInteger(
      voucher.voucherType,
      `${field}.voucherType`,
      1,
      999
    ),
    Cbte_punto_vta: assertWsfexInteger(
      voucher.salesPoint,
      `${field}.salesPoint`,
      1,
      99_999
    ),
    Cbte_nro: assertWsfexInteger(
      voucher.number,
      `${field}.number`,
      1,
      999_999_999
    ),
    ...optionalWsfexField(
      "Cbte_cuit",
      assertOptionalWsfexTaxId(voucher.issuerTaxId, `${field}.issuerTaxId`)
    ),
  };
}

function createWsfexItems(items: readonly WsfexItem[]) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ArcaInputError("items must contain at least one item.", {
      code: "ARCA_INPUT_MISSING_FIELD",
      field: "items",
      expected: "from 1 to 9999 items",
    });
  }
  return { Item: items.map(createWsfexItem) };
}

function createWsfexItem(item: WsfexItem, index: number) {
  const field = `items[${index}]`;
  return {
    ...optionalWsfexField(
      "Pro_codigo",
      optionalWsfexText(item.code, `${field}.code`)
    ),
    Pro_ds: requireWsfexText(item.description, `${field}.description`),
    ...optionalWsfexField(
      "Pro_qty",
      serializeWsfexItemDecimal(item.quantity, `${field}.quantity`)
    ),
    Pro_umed: assertWsfexInteger(item.unit, `${field}.unit`, 0, 99),
    ...optionalWsfexField(
      "Pro_precio_uni",
      serializeWsfexItemDecimal(item.unitPrice, `${field}.unitPrice`)
    ),
    ...optionalWsfexField(
      "Pro_bonificacion",
      serializeWsfexItemDecimal(item.discount, `${field}.discount`)
    ),
    Pro_total_item: serializeWsfexSignedAmount(item.amount, `${field}.amount`),
  };
}

function createWsfexActivity(activity: { id: string }, index: number) {
  const field = `activities[${index}].id`;
  if (typeof activity.id !== "string" || !/^\d{1,6}$/.test(activity.id)) {
    throw new ArcaInputError(`${field} must be an activity code.`, {
      code: "ARCA_INPUT_INVALID_VALUE",
      field,
      expected: "a code of up to 6 digits from getActivities()",
    });
  }
  return { Id: Number.parseInt(activity.id, 10) };
}

// Unit 97 allows any sign and unit 99 requires a negative total (rule 1810).
function serializeWsfexSignedAmount(value: number, field: string): string {
  return typeof value === "number" && value < 0
    ? `-${serializeArcaAmount(-value, field)}`
    : serializeArcaAmount(value, field);
}

/**
 * N12,6 fields go out in the shortest exact form, without trailing zeros. A
 * number is read through its shortest round-trip string, so `0.1` stays `0.1`.
 */
function serializeWsfexItemDecimal(
  value: number | string | undefined,
  field: string
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const text =
    typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  const match =
    typeof text === "string"
      ? WSFEX_ITEM_DECIMAL_PATTERN.exec(text.trim())
      : null;
  if (!match) {
    throw new ArcaInputError(
      `${field} must be a non-negative decimal with at most 12 integer and 6 fractional digits.`,
      {
        code: "ARCA_INPUT_INVALID_AMOUNT",
        field,
        expected:
          "a non-negative decimal with up to 12 integer and 6 fractional digits",
      }
    );
  }
  return formatWsfexDecimal(match[1] ?? "0", match[2]);
}

function formatWsfexDecimal(integerPart: string, fractionPart = ""): string {
  const integer = integerPart.replace(/^0+(?=\d)/, "");
  const fraction = fractionPart.replace(/0+$/, "");
  return fraction ? `${integer}.${fraction}` : integer;
}

/** Reads an ARCA decimal into the same canonical form the requests use. */
function canonicalizeWsfexDecimal(value: unknown): string | undefined {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(readWsfexText(value) ?? "");
  return match ? formatWsfexDecimal(match[1] ?? "0", match[2]) : undefined;
}

function optionalWsfexField(
  key: string,
  value: unknown
): Record<string, unknown> {
  return value === undefined ? {} : { [key]: value };
}

function assertWsfexInteger(
  value: unknown,
  field: string,
  min: number,
  max: number
): number {
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  ) {
    return value;
  }
  return throwWsfexInvalidInput(
    value,
    field,
    `an integer from ${min} to ${max}`
  );
}

function assertWsfexCode<T extends number>(
  value: unknown,
  field: string,
  allowed: readonly T[]
): T {
  if (allowed.includes(value as T)) {
    return value as T;
  }
  return throwWsfexInvalidInput(value, field, `one of ${allowed.join(", ")}`);
}

function assertOptionalWsfexFlag(
  value: unknown,
  field: string
): "S" | "N" | undefined {
  if (value === undefined || value === "S" || value === "N") {
    return value;
  }
  return throwWsfexInvalidInput(value, field, "S or N");
}

function assertOptionalWsfexTaxId(
  value: unknown,
  field: string
): string | undefined {
  if (
    value === undefined ||
    (typeof value === "string" && WSFEX_TAX_ID_PATTERN.test(value))
  ) {
    return value;
  }
  return throwWsfexInvalidInput(value, field, "an 11-digit CUIT string");
}

function requireWsfexText(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }
  return throwWsfexInvalidInput(value, field, "a non-empty string");
}

function optionalWsfexText(value: unknown, field: string): string | undefined {
  if (value === undefined || typeof value === "string") {
    return value;
  }
  return throwWsfexInvalidInput(value, field, "a string");
}

function throwWsfexInvalidInput(
  value: unknown,
  field: string,
  expected: string
): never {
  throw new ArcaInputError(
    value === undefined
      ? `${field} is required.`
      : `${field} must be ${expected}.`,
    {
      code:
        value === undefined
          ? "ARCA_INPUT_MISSING_FIELD"
          : "ARCA_INPUT_INVALID_VALUE",
      field,
      expected,
    }
  );
}

function normalizeOptionalWsfexDate(
  value: string | undefined,
  field: string
): string | undefined {
  return value === undefined ? undefined : normalizeWsfexDate(value, field);
}

/** Accepts `YYYYMMDD` or `YYYY-MM-DD` and returns ARCA's `YYYYMMDD`. */
function normalizeWsfexDate(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  const [, year = "", month = "", day = ""] =
    /^(\d{4})(\d{2})(\d{2})$/.exec(text) ??
    /^(\d{4})-(\d{2})-(\d{2})$/.exec(text) ??
    [];
  const candidate = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day))
  );
  if (
    year !== "" &&
    candidate.getUTCFullYear() === Number(year) &&
    candidate.getUTCMonth() === Number(month) - 1 &&
    candidate.getUTCDate() === Number(day)
  ) {
    return `${year}${month}${day}`;
  }
  throw new ArcaInputError(
    `Invalid WSFEX ${field}: expected an existing YYYYMMDD or YYYY-MM-DD date`,
    {
      code: "ARCA_INPUT_INVALID_DATE",
      field,
      expected: "an existing YYYYMMDD or YYYY-MM-DD calendar date",
    }
  );
}

function createWsfexAuth(
  representedTaxId: number | string,
  token: string,
  sign: string
) {
  return {
    Token: token,
    Sign: sign,
    Cuit: Number.parseInt(String(representedTaxId), 10),
  };
}

function unwrapWsfexOperationEnvelope(
  operation: string,
  response: Record<string, unknown>
) {
  const operationResponse = response[`${operation}Response`] as
    | Record<string, unknown>
    | undefined;
  const result = (operationResponse?.[`${operation}Result`] ??
    response[`${operation}Result`] ??
    response) as Record<string, unknown>;

  return result;
}

function throwForWsfexOperationError(
  operation: string,
  result: Record<string, unknown>
) {
  const errors = extractWsfexErrors(result, operation);
  if (errors.length > 0) {
    throw createWsfexServiceError(operation, errors);
  }
}

function createWsfexServiceError(operation: string, issues: ArcaFiscalIssue[]) {
  const authenticationError = classifyArcaAuthenticationIssues(issues, {
    service: "wsfex",
    operation,
  });
  if (authenticationError) {
    return authenticationError;
  }

  const firstIssue = issues[0];
  return new ArcaServiceError(
    firstIssue
      ? formatWsfexIssue(firstIssue)
      : "WSFEX returned a service error",
    {
      service: "wsfex",
      operation,
      ...(firstIssue?.code === undefined
        ? {}
        : { serviceCode: firstIssue.code }),
      issues,
    }
  );
}

function formatWsfexIssue(issue: ArcaFiscalIssue) {
  return issue.code ? `(${issue.code}) ${issue.message}` : issue.message;
}

/** `FEXErr` holds one error; `ErrCode` 0 means none. Some answers spell it `Errmsg`. */
function extractWsfexErrors(
  result: Record<string, unknown>,
  operation: string,
  resultLevel?: ArcaFiscalResultLevel
): ArcaFiscalIssue[] {
  const error = toWsfexRecord(result.FEXErr);
  const code = readWsfexText(error?.ErrCode);
  if (code === undefined || /^0+$/.test(code)) {
    return [];
  }
  return [
    {
      service: "wsfex",
      operation,
      source: "error",
      category: getWsfexErrorCategory(operation, code),
      code,
      message:
        readWsfexText(error?.ErrMsg) ??
        readWsfexText(error?.Errmsg) ??
        "Unknown WSFEX error",
      ...(resultLevel === undefined ? {} : { resultLevel }),
    },
  ];
}

function getWsfexErrorCategory(
  operation: string,
  code: string
): ArcaFiscalIssue["category"] {
  if (operation !== "FEXAuthorize") {
    return "unknown";
  }
  return WSFEX_AUTHORIZATION_INFRASTRUCTURE_CODES.has(code)
    ? "infrastructure"
    : "business";
}

// 500/501/502/505 are ARCA's internal failures; 1000/1001 reject the ticket.
// Neither proves what ARCA did with the request.
const WSFEX_AUTHORIZATION_INFRASTRUCTURE_CODES = new Set([
  "500",
  "501",
  "502",
  "505",
  "1000",
  "1001",
]);

/**
 * `Motivos_Obs` is an undocumented C40 string. A list of numeric codes
 * becomes one issue per code; anything else stays one issue with ARCA's text.
 */
function extractWsfexReasons(
  value: unknown,
  operation: string,
  category: ArcaFiscalIssue["category"]
): ArcaFiscalIssue[] {
  const text = readWsfexText(value);
  if (text === undefined) {
    return [];
  }
  const base = {
    service: "wsfex" as const,
    operation,
    source: "observation" as const,
    category,
    resultLevel: "header" as const,
  };
  if (!/^\d+(?:\s*[,;|\s]\s*\d+)*$/.test(text)) {
    return [{ ...base, message: text }];
  }
  return text
    .split(/\D+/)
    .filter(Boolean)
    .map((token) => {
      const code = String(Number.parseInt(token, 10));
      return { ...base, code, message: code };
    });
}

type WsfexAuthorizationBase = {
  service: "wsfex";
  operation: string;
  results: { header?: string };
  errors: ArcaFiscalIssue[];
  observations: ArcaFiscalIssue[];
  raw: Record<string, unknown>;
  reprocessed?: boolean;
  echo?: WsfexEcho;
};

type WsfexAuthorizationContext = {
  base: WsfexAuthorizationBase;
  resultCode?: string;
  cae?: string;
  caeExpiry?: string;
  voucherNumber?: number;
};

/**
 * WSFEX answers one voucher per request, so every result is header level.
 * Parsing never throws: a malformed field becomes absent evidence, never an
 * `invalid_response` that would discard the CAE and the echo.
 */
function classifyWsfexAuthorization(
  result: Record<string, unknown>
): WsfexAuthorizationOutcome {
  const operation = "FEXAuthorize";
  const authorization = toWsfexRecord(result.FEXResultAuth);
  const resultCode = normalizeWsfexResult(authorization?.Resultado);
  const echo = readWsfexEcho(authorization);
  const reprocessed = readWsfexReprocessed(authorization?.Reproceso);
  const base: WsfexAuthorizationBase = {
    service: "wsfex",
    operation,
    results: resultCode === undefined ? {} : { header: resultCode },
    errors: extractWsfexErrors(result, operation, "header"),
    observations: extractWsfexReasons(
      authorization?.Motivos_Obs,
      operation,
      resultCode === "R" ? "business" : "observation"
    ),
    raw: result,
  };
  assignWsfexValue(base, "reprocessed", reprocessed);
  assignWsfexValue(base, "echo", echo);
  const context: WsfexAuthorizationContext = {
    base,
    resultCode,
    cae: readWsfexText(authorization?.Cae),
    caeExpiry: readWsfexText(authorization?.Fch_venc_Cae),
    voucherNumber: echo?.number,
  };

  return base.errors.length > 0
    ? classifyWsfexErrorAnswer(context)
    : classifyWsfexResultAnswer(context);
}

function classifyWsfexErrorAnswer(
  context: WsfexAuthorizationContext
): WsfexAuthorizationOutcome {
  if (context.cae || context.resultCode === "A") {
    return createWsfexStructuredIndeterminate(
      context,
      "contradictory_response"
    );
  }

  const authenticationError = classifyArcaAuthenticationIssues(
    context.base.errors,
    { service: "wsfex", operation: context.base.operation }
  );
  if (authenticationError) {
    return {
      ...createWsfexStructuredIndeterminate(context, "authentication_rejected"),
      authentication: createArcaAuthenticationEvidence(authenticationError),
    };
  }

  if (
    context.base.errors.some((issue) => issue.category === "infrastructure")
  ) {
    return createWsfexStructuredIndeterminate(context, "incomplete_response");
  }

  // ARCA validates the request before storing it, so a validation error
  // consumed neither the number nor the Id.
  return {
    ...context.base,
    kind: "rejected",
    result: "R",
    resultLevel: "header",
  };
}

function classifyWsfexResultAnswer(
  context: WsfexAuthorizationContext
): WsfexAuthorizationOutcome {
  const { cae, caeExpiry, voucherNumber } = context;
  if (context.resultCode === "A") {
    return cae && caeExpiry && voucherNumber !== undefined
      ? {
          ...context.base,
          kind: "authorized",
          result: "A",
          resultLevel: "header",
          cae,
          caeExpiry,
          voucherNumber,
        }
      : createWsfexStructuredIndeterminate(context, "incomplete_response");
  }

  if (context.resultCode === "R") {
    return cae
      ? createWsfexStructuredIndeterminate(context, "contradictory_response")
      : {
          ...context.base,
          kind: "rejected",
          result: "R",
          resultLevel: "header",
        };
  }

  return createWsfexStructuredIndeterminate(context, "incomplete_response");
}

function createWsfexStructuredIndeterminate(
  context: WsfexAuthorizationContext,
  reason: ArcaAuthorizationIndeterminateReason
): Extract<WsfexAuthorizationOutcome, { kind: "indeterminate" }> {
  const outcome: Extract<WsfexAuthorizationOutcome, { kind: "indeterminate" }> =
    {
      ...context.base,
      kind: "indeterminate",
      reason,
    };
  assignWsfexValue(outcome, "result", context.resultCode);
  if (context.resultCode !== undefined) {
    outcome.resultLevel = "header";
  }
  assignWsfexValue(outcome, "cae", context.cae);
  assignWsfexValue(outcome, "caeExpiry", context.caeExpiry);
  return outcome;
}

function createWsfexIndeterminateOutcome(
  error: unknown
): WsfexAuthorizationOutcome {
  const operation = "FEXAuthorize";
  const authenticationError = classifyArcaAuthenticationError(error, {
    service: "wsfex",
    operation,
  });
  return {
    kind: "indeterminate",
    service: "wsfex",
    operation,
    results: {},
    reason: authenticationError
      ? "authentication_rejected"
      : getWsfexIndeterminateReason(error),
    ...(authenticationError
      ? {
          authentication: createArcaAuthenticationEvidence(authenticationError),
        }
      : {}),
    errors: [],
    observations: [],
  };
}

function getWsfexIndeterminateReason(
  error: unknown
): ArcaAuthorizationIndeterminateReason {
  if (error instanceof ArcaTransportError) {
    return "transport_error";
  }
  if (error instanceof ArcaSoapFaultError) {
    return "soap_fault";
  }
  if (error instanceof ArcaInvalidSoapResponseError) {
    return "invalid_response";
  }
  return "unexpected_error";
}

/**
 * What ARCA says it authorized. A failed request can come back zero-filled,
 * so a zero point, type or number is absent rather than echoed.
 */
function readWsfexEcho(
  authorization: Record<string, unknown> | undefined
): WsfexEcho | undefined {
  if (!authorization) {
    return undefined;
  }
  const echo: WsfexEcho = {};
  assignWsfexValue(
    echo,
    "id",
    readWsfexInteger(authorization.Id, 0, WSFEX_MAX_REQUEST_ID)
  );
  assignWsfexValue(
    echo,
    "salesPoint",
    readWsfexInteger(authorization.Punto_vta, 1, 99_999)
  );
  assignWsfexValue(
    echo,
    "voucherType",
    readWsfexInteger(authorization.Cbte_tipo ?? authorization.Cbte_Tipo, 1, 999)
  );
  assignWsfexValue(
    echo,
    "number",
    readWsfexInteger(authorization.Cbte_nro, 1, 99_999_999)
  );
  assignWsfexValue(echo, "date", readWsfexText(authorization.Fch_cbte));
  return Object.keys(echo).length > 0 ? echo : undefined;
}

function readWsfexReprocessed(value: unknown): boolean | undefined {
  const flag = normalizeWsfexResult(value);
  return flag === "S" || flag === "N" ? flag === "S" : undefined;
}

/** `FEXGetCMP` in the facade's shape: amounts as numbers, rates exact. */
function mapWsfexVoucherInfo(raw: Record<string, unknown>): WsfexVoucherInfo {
  const operation = "FEXGetCMP";
  const voucher: WsfexVoucherInfo = {
    voucherType: parseWsfexInteger(raw.Cbte_tipo ?? raw.Cbte_Tipo, {
      operation,
      field: "Cbte_tipo",
      min: 1,
      max: 999,
    }),
    salesPoint: parseWsfexInteger(raw.Punto_vta, {
      operation,
      field: "Punto_vta",
      min: 1,
      max: 99_999,
    }),
    number: parseWsfexInteger(raw.Cbte_nro, {
      operation,
      field: "Cbte_nro",
      min: 1,
      max: 99_999_999,
    }),
    destination: parseWsfexNumber(raw.Dst_cmp, operation, "Dst_cmp"),
    receiverName: readWsfexText(raw.Cliente) ?? "",
    receiverAddress: readWsfexText(raw.Domicilio_cliente) ?? "",
    currencyId: readWsfexText(raw.Moneda_Id) ?? "",
    totalAmount: parseWsfexNumber(raw.Imp_total, operation, "Imp_total"),
    items: getWsfexRows(raw.Items, "Item").map(mapWsfexLookupItem),
  };

  assignWsfexValue(
    voucher,
    "id",
    readWsfexInteger(raw.Id, 0, WSFEX_MAX_REQUEST_ID)
  );
  assignWsfexValue(voucher, "voucherDate", readWsfexText(raw.Fecha_cbte));
  assignWsfexValue(voucher, "exportType", readWsfexNumber(raw.Tipo_expo));
  assignWsfexValue(
    voucher,
    "permitExists",
    readWsfexFlag(raw.Permiso_existente)
  );
  assignWsfexValue(
    voucher,
    "permits",
    mapWsfexLookupList(raw.Permisos, "Permiso", mapWsfexLookupPermit)
  );
  assignWsfexValue(
    voucher,
    "receiverCountryTaxId",
    readWsfexTaxId(raw.Cuit_pais_cliente)
  );
  assignWsfexValue(voucher, "receiverTaxId", readWsfexText(raw.Id_impositivo));
  assignWsfexValue(
    voucher,
    "exchangeRate",
    canonicalizeWsfexDecimal(raw.Moneda_ctz)
  );
  assignWsfexValue(
    voucher,
    "sameCurrencyForeignCancellation",
    readWsfexFlag(raw.CanMisMonExt)
  );
  assignWsfexValue(
    voucher,
    "commercialObservations",
    readWsfexText(raw.Obs_comerciales)
  );
  // `observations` is the voucher's `Obs`, as sent. `Motivos_Obs` goes to the
  // lookup result's structured `observations`.
  assignWsfexValue(voucher, "observations", readWsfexText(raw.Obs));
  assignWsfexValue(
    voucher,
    "associatedVouchers",
    mapWsfexLookupList(
      raw.Cmps_asoc,
      "Cmp_asoc",
      mapWsfexLookupAssociatedVoucher
    )
  );
  assignWsfexValue(voucher, "paymentTerms", readWsfexText(raw.Forma_pago));
  assignWsfexValue(voucher, "incoterms", readWsfexText(raw.Incoterms));
  assignWsfexValue(voucher, "incotermsDetail", readWsfexText(raw.Incoterms_Ds));
  assignWsfexValue(voucher, "language", readWsfexNumber(raw.Idioma_cbte));
  assignWsfexValue(voucher, "paymentDate", readWsfexText(raw.Fecha_pago));
  assignWsfexValue(
    voucher,
    "activities",
    mapWsfexLookupList(raw.Actividades, "Actividad", (row) => {
      const id = toWsfexActivityId(row.Id);
      return id === undefined ? undefined : { id };
    })
  );
  assignWsfexValue(voucher, "result", normalizeWsfexResult(raw.Resultado));
  assignWsfexValue(voucher, "cae", readWsfexText(raw.Cae));
  assignWsfexValue(voucher, "caeExpiry", readWsfexText(raw.Fch_venc_Cae));
  assignWsfexValue(voucher, "authorizedAt", readWsfexText(raw.Fecha_cbte_cae));
  return voucher;
}

function mapWsfexLookupItem(row: Record<string, unknown>): WsfexItem {
  const operation = "FEXGetCMP";
  const code = readWsfexText(row.Pro_codigo);
  // N12,6 needs up to 18 digits, more than a number keeps: stay exact.
  const quantity = canonicalizeWsfexDecimal(row.Pro_qty);
  const unitPrice = canonicalizeWsfexDecimal(row.Pro_precio_uni);
  const discount = canonicalizeWsfexDecimal(row.Pro_bonificacion);
  return {
    ...(code === undefined ? {} : { code }),
    description: readWsfexText(row.Pro_ds) ?? "",
    ...(quantity === undefined ? {} : { quantity }),
    unit: parseWsfexNumber(row.Pro_umed, operation, "Pro_umed"),
    ...(unitPrice === undefined ? {} : { unitPrice }),
    ...(discount === undefined ? {} : { discount }),
    amount: parseWsfexNumber(row.Pro_total_item, operation, "Pro_total_item"),
  };
}

function mapWsfexLookupPermit(
  row: Record<string, unknown>
): WsfexPermit | undefined {
  const id = readWsfexText(row.Id_permiso);
  const destination = readWsfexNumber(row.Dst_merc);
  return id === undefined || destination === undefined
    ? undefined
    : { id, destination };
}

function mapWsfexLookupAssociatedVoucher(
  row: Record<string, unknown>
): WsfexAssociatedVoucher | undefined {
  const voucherType = readWsfexNumber(row.Cbte_tipo ?? row.Cbte_Tipo);
  const salesPoint = readWsfexNumber(row.Cbte_punto_vta);
  const number = readWsfexNumber(row.Cbte_nro);
  if (
    voucherType === undefined ||
    salesPoint === undefined ||
    number === undefined
  ) {
    return undefined;
  }
  const issuerTaxId = readWsfexTaxId(row.Cbte_cuit);
  return {
    voucherType,
    salesPoint,
    number,
    ...(issuerTaxId === undefined ? {} : { issuerTaxId }),
  };
}

// A missing or malformed detail stays absent; never fabricate partial evidence.
function mapWsfexLookupList<T>(
  container: unknown,
  key: string,
  map: (row: Record<string, unknown>) => T | undefined
): T[] | undefined {
  const rows = getWsfexRows(container, key);
  if (rows.length === 0) {
    return undefined;
  }
  const result: T[] = [];
  for (const row of rows) {
    const mapped = map(row);
    if (mapped === undefined) {
      return undefined;
    }
    result.push(mapped);
  }
  return result;
}

/** ARCA answers `Pve_Bloqueado` as `S`/`N` and an active point's `Pve_FchBaja` empty or nil. */
function mapWsfexSalesPoint(row: Record<string, unknown>): WsfexSalesPoint {
  const deactivatedAt = toIsoDate(readWsfexText(row.Pve_FchBaja));
  return {
    number: parseWsfexInteger(row.Pve_Nro, {
      operation: "FEXGetPARAM_PtoVenta",
      field: "Pve_Nro",
      min: 1,
      max: 99_999,
    }),
    blocked: normalizeWsfexResult(row.Pve_Bloqueado) === "S",
    ...(deactivatedAt === undefined ? {} : { deactivatedAt }),
  };
}

// ARCA answers the NAES code as a number, which drops its leading zero.
function toWsfexActivityId(value: unknown): string | undefined {
  const text = readWsfexText(value);
  return text !== undefined && /^\d+$/.test(text) && Number(text) !== 0
    ? text.padStart(6, "0")
    : undefined;
}

// `Cuit_pais_cliente` and `Cbte_cuit` are required longs, so ARCA fills 0.
function readWsfexTaxId(value: unknown): string | undefined {
  const text = readWsfexText(value);
  return text !== undefined && /^\d+$/.test(text) && Number(text) !== 0
    ? text
    : undefined;
}

function readWsfexFlag(value: unknown): "S" | "N" | undefined {
  const flag = normalizeWsfexResult(value);
  return flag === "S" || flag === "N" ? flag : undefined;
}

/** Rows of an ARCA array. One row arrives as an object; nil rows are skipped. */
function getWsfexRows(
  container: unknown,
  key: string
): Record<string, unknown>[] {
  const value = toWsfexRecord(container)?.[key];
  if (value === undefined) {
    return [];
  }
  return (Array.isArray(value) ? value : [value]).flatMap((row) => {
    const record = toWsfexRecord(row);
    return record ? [record] : [];
  });
}

/** A record with only attributes, such as `xsi:nil`, is absent. */
function toWsfexRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record).some((key) => !key.startsWith("@_"))
    ? record
    : undefined;
}

function readWsfexText(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const text = String(value).trim();
  return text || undefined;
}

function readWsfexNumber(value: unknown): number | undefined {
  const text = readWsfexText(value);
  return text !== undefined && /^-?\d+(?:\.\d+)?$/.test(text)
    ? Number(text)
    : undefined;
}

function readWsfexInteger(
  value: unknown,
  min: number,
  max: number
): number | undefined {
  const text = readWsfexText(value);
  if (text === undefined || !/^\d+$/.test(text)) {
    return undefined;
  }
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : undefined;
}

function parseWsfexInteger(
  value: unknown,
  options: { operation: string; field: string; min: number; max: number }
): number {
  const parsed = readWsfexInteger(value, options.min, options.max);
  if (parsed === undefined) {
    throw new ArcaInvalidSoapResponseError(`Invalid WSFEX ${options.field}`, {
      service: "wsfex",
      operation: options.operation,
    });
  }
  return parsed;
}

function parseWsfexNumber(
  value: unknown,
  operation: string,
  field: string
): number {
  const parsed = readWsfexNumber(value);
  if (parsed === undefined) {
    throw new ArcaInvalidSoapResponseError(`Invalid WSFEX ${field}`, {
      service: "wsfex",
      operation,
    });
  }
  return parsed;
}

function normalizeWsfexResult(value: unknown): string | undefined {
  return readWsfexText(value)?.toUpperCase();
}

function assignWsfexValue<TTarget, TKey extends keyof TTarget>(
  target: TTarget,
  key: TKey,
  value: TTarget[TKey] | undefined
) {
  if (value !== undefined) {
    target[key] = value;
  }
}
