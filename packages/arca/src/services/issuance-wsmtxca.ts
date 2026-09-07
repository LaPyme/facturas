import { ArcaInputError } from "../errors";
import {
  isWithinArcaTolerance,
  normalizeArcaAmountToMinorUnits,
} from "../internal/decimal";
import { minor } from "./issuance-fields";
import {
  normalizeWsfeDateInput,
  type WsfeVoucherInfo,
  type WsfeVoucherInput,
} from "./wsfe";
import type { WsmtxcaService, WsmtxcaVoucherInfo } from "./wsmtxca";

/** Detailed item evidence. Amounts are cents; unitPrice is a decimal major-unit string. */
export type VoucherItemDetail = {
  description: string;
  quantity: number;
  unit: number;
  unitPrice: string;
  discount?: number;
  vatCondition: number;
  vatAmount?: number;
  amount: number;
  code?: string;
  matrixCode?: string;
  matrixUnits?: number;
};
export type WsmtxcaIssueRequest = ReturnType<typeof wsmtxcaRequest>;
export type FiscalHeader = WsfeVoucherInput & {
  details?: readonly VoucherItemDetail[];
};
const iso = (value: string | undefined) => {
  if (value === undefined) {
    return undefined;
  }
  const date = normalizeWsfeDateInput(
    value as import("./wsfe").WsfeDateInput,
    "date"
  ) as string;
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
};

export function wsmtxcaRequest(data: FiscalHeader, number?: number) {
  if (!data.details?.length) {
    invalid("details", "WSMTXCA requires detailed items");
  }
  const items = data.details.map((item, index) => {
    if (
      !item ||
      typeof item !== "object" ||
      Object.keys(item).some(
        (k) =>
          ![
            "description",
            "quantity",
            "unit",
            "unitPrice",
            "discount",
            "vatCondition",
            "vatAmount",
            "amount",
            "code",
            "matrixCode",
            "matrixUnits",
          ].includes(k)
      )
    ) {
      invalid(`details[${index}]`, "Invalid detailed item fields");
    }
    if (
      typeof item.description !== "string" ||
      !(item.description.trim() && Number.isFinite(item.quantity)) ||
      item.quantity <= 0 ||
      !Number.isInteger(item.unit) ||
      item.unit < 0 ||
      typeof item.unitPrice !== "string" ||
      !/^\d+(\.\d{1,6})?$/.test(item.unitPrice) ||
      !Number.isInteger(item.vatCondition)
    ) {
      invalid(`details[${index}]`, "Invalid detailed item");
    }
    return {
      unidadesMtx: item.matrixUnits,
      codigoMtx: item.matrixCode,
      codigo: item.code,
      descripcion: item.description,
      cantidad: item.quantity,
      codigoUnidadMedida: item.unit,
      precioUnitario: item.unitPrice,
      importeBonificacion: minor(item.discount ?? 0, "details.discount"),
      codigoCondicionIVA: item.vatCondition,
      ...(item.vatAmount === undefined
        ? {}
        : { importeIVA: minor(item.vatAmount, "details.vatAmount") }),
      importeItem: minor(item.amount, "details.amount"),
    };
  });
  const itemTotal = data.details.reduce(
    (sum, item) => sum + BigInt(item.amount),
    0n
  );
  const expected =
    normalizeArcaAmountToMinorUnits(data.totalAmount, "total") -
    normalizeArcaAmountToMinorUnits(data.taxAmount, "taxes");
  if (!isWithinArcaTolerance(itemTotal, expected, 1)) {
    invalid(
      "details",
      "Item totals must equal the voucher total excluding tributes"
    );
  }
  return {
    comprobanteCAERequest: {
      codigoTipoComprobante: data.voucherType,
      numeroPuntoVenta: data.salesPoint,
      ...(number === undefined ? {} : { numeroComprobante: number }),
      fechaEmision: iso(data.voucherDate),
      codigoTipoDocumento: data.documentType,
      numeroDocumento: data.documentNumber,
      condicionIVAReceptor: data.receiverVatConditionId,
      importeGravado: data.netAmount,
      importeNoGravado: data.nonTaxableAmount,
      importeExento: data.exemptAmount,
      importeSubtotal:
        Number(
          normalizeArcaAmountToMinorUnits(data.netAmount, "net") +
            normalizeArcaAmountToMinorUnits(data.nonTaxableAmount, "untaxed") +
            normalizeArcaAmountToMinorUnits(data.exemptAmount, "exempt")
        ) / 100,
      importeOtrosTributos: data.taxAmount,
      importeTotal: data.totalAmount,
      codigoMoneda: data.currencyId,
      cotizacionMoneda: data.exchangeRate,
      codigoConcepto: data.concept,
      fechaServicioDesde: iso(data.serviceStartDate),
      fechaServicioHasta: iso(data.serviceEndDate),
      fechaVencimientoPago: iso(data.paymentDueDate),
      ...(data.sameCurrencyForeignCancellation === undefined
        ? {}
        : {
            cancelaEnMismaMonedaExtranjera:
              data.sameCurrencyForeignCancellation,
          }),
      arrayComprobantesAsociados: data.associatedVouchers?.length
        ? {
            comprobanteAsociado: data.associatedVouchers.map((v) => ({
              codigoTipoComprobante: v.type,
              numeroPuntoVenta: v.salesPoint,
              numeroComprobante: v.number,
              cuit: v.taxId,
              fechaEmision: iso(v.voucherDate),
            })),
          }
        : undefined,
      periodoComprobantesAsociados: data.associatedPeriod
        ? {
            fechaDesde: iso(data.associatedPeriod.startDate),
            fechaHasta: iso(data.associatedPeriod.endDate),
          }
        : undefined,
      arrayCompradores: data.buyers?.length
        ? {
            comprador: data.buyers.map((b) => ({
              codigoTipoDocumento: b.documentType,
              numeroDocumento: b.documentNumber,
              porcentaje: b.percentage,
            })),
          }
        : undefined,
      arrayOtrosTributos: data.taxes?.length
        ? {
            otroTributo: data.taxes.map((t) => ({
              codigo: t.id,
              descripcion: t.description,
              baseImponible: t.baseAmount,
              importe: t.amount,
            })),
          }
        : undefined,
      arrayItems: { item: items },
      arraySubtotalesIVA: data.vatRates?.length
        ? {
            subtotalIVA: data.vatRates.map((v) => ({
              codigo: v.id,
              importe: v.amount,
            })),
          }
        : undefined,
      arrayDatosAdicionales: wsmtxcaAdditionalData(data.optionalFields),
      arrayActividades: data.activities?.length
        ? { actividad: data.activities.map((a) => ({ codigo: a.id })) }
        : undefined,
    },
  };
}
function invalid(field: string, message: string): never {
  throw new ArcaInputError(message, {
    code: "ARCA_INPUT_INVALID_VALUE",
    field,
  });
}
function rows(
  value: unknown,
  key: string
): Record<string, unknown>[] | undefined {
  const data =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)[key]
      : undefined;
  if (data === undefined) {
    return undefined;
  }
  const list = Array.isArray(data) ? data : [data];
  if (list.some((item) => !item || typeof item !== "object")) {
    return undefined;
  }
  return list as Record<string, unknown>[];
}
export function wsmtxcaHeader(
  found: WsmtxcaVoucherInfo
): WsfeVoucherInfo & { details?: VoucherItemDetail[] } {
  const raw = found.raw;
  const items = rows(raw.arrayItems, "item");
  const details = items?.map((i) => ({
    description: String(i.descripcion ?? ""),
    quantity: Number(i.cantidad),
    unit: Number(i.codigoUnidadMedida),
    unitPrice: String(i.precioUnitario),
    discount: Number(
      normalizeArcaAmountToMinorUnits(
        Number(i.importeBonificacion ?? 0),
        "discount"
      )
    ),
    vatCondition: Number(i.codigoCondicionIVA),
    vatAmount:
      i.importeIVA === undefined
        ? undefined
        : Number(normalizeArcaAmountToMinorUnits(Number(i.importeIVA), "vat")),
    amount: Number(
      normalizeArcaAmountToMinorUnits(Number(i.importeItem), "amount")
    ),
    code: i.codigo === undefined ? undefined : String(i.codigo),
    matrixCode: i.codigoMtx === undefined ? undefined : String(i.codigoMtx),
    matrixUnits:
      i.unidadesMtx === undefined ? undefined : Number(i.unidadesMtx),
  }));
  return {
    ...found,
    voucherNumber: found.voucherNumber ?? 0,
    voucherDate: found.invoiceDate,
    netAmount: found.taxableAmount,
    // consultarComprobante is an authorized-voucher lookup. No result flag is returned.
    result: found.cae ? "A" : undefined,
    serviceStartDate:
      raw.fechaServicioDesde === undefined
        ? undefined
        : String(raw.fechaServicioDesde),
    serviceEndDate:
      raw.fechaServicioHasta === undefined
        ? undefined
        : String(raw.fechaServicioHasta),
    paymentDueDate:
      raw.fechaVencimientoPago === undefined
        ? undefined
        : String(raw.fechaVencimientoPago),
    details,
    vatRates: rows(raw.arraySubtotalesIVA, "subtotalIVA")?.map((v) => ({
      id: Number(v.codigo),
      amount: Number(v.importe),
      baseAmount:
        Number(
          (details ?? [])
            .filter((i) => i.vatCondition === Number(v.codigo))
            .reduce((sum, i) => sum + BigInt(i.amount), 0n) -
            normalizeArcaAmountToMinorUnits(Number(v.importe), "vat")
        ) / 100,
    })),
    taxes: rows(raw.arrayOtrosTributos, "otroTributo")?.map((t) => ({
      id: Number(t.codigo),
      description:
        t.descripcion === undefined ? undefined : String(t.descripcion),
      baseAmount: Number(t.baseImponible),
      amount: Number(t.importe),
      rate: 0,
    })),
    sameCurrencyForeignCancellation: raw.cancelaEnMismaMonedaExtranjera as
      | "S"
      | "N"
      | undefined,
    optionalFields: rows(raw.arrayDatosAdicionales, "datoAdicional")?.map(
      (v) => ({ id: String(v.t), value: String(v.c1) })
    ),
    activities: rows(raw.arrayActividades, "actividad")?.map((v) => ({
      id: Number(v.codigo),
    })),
    buyers: rows(raw.arrayCompradores, "comprador")?.map((v) => ({
      documentType: Number(v.codigoTipoDocumento),
      documentNumber: Number(v.numeroDocumento),
      percentage: Number(v.porcentaje),
    })),
    associatedVouchers: rows(
      raw.arrayComprobantesAsociados,
      "comprobanteAsociado"
    )?.map((v) => ({
      type: Number(v.codigoTipoComprobante),
      salesPoint: Number(v.numeroPuntoVenta),
      number: Number(v.numeroComprobante),
      taxId: v.cuit === undefined ? undefined : String(v.cuit),
      voucherDate: v.fechaEmision as import("./wsfe").WsfeDateInput | undefined,
    })),
  };
}

/** Compare wire evidence, never inject expected values into the lookup. */
export function matchWsmtxcaDetails(
  data: FiscalHeader,
  number: number,
  raw: Record<string, unknown>
): "match" | "incomplete" | "conflict" {
  const request: Record<string, unknown> = wsmtxcaRequest(
    data,
    number
  ).comprobanteCAERequest;
  let missing = false;
  for (const key of Object.keys(request)) {
    const expected = request[key];
    const actual = raw[key];
    if (expected === undefined) {
      if (!emptyWire(actual)) {
        return "conflict";
      }
      continue;
    }
    const result = compareWire(
      normalizeWire(expected, key),
      normalizeWire(actual, key)
    );
    if (result === "conflict") {
      return "conflict";
    }
    missing ||= result === "incomplete";
  }
  return missing ? "incomplete" : "match";
}
function emptyWire(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "object" && Object.values(value).every(emptyWire))
  );
}
function compareWire(
  expected: unknown,
  actual: unknown
): "match" | "incomplete" | "conflict" {
  if (actual === undefined || actual === null) {
    return "incomplete";
  }
  if (expected !== null && typeof expected === "object") {
    if (
      typeof actual !== "object" ||
      Array.isArray(expected) !== Array.isArray(actual)
    ) {
      return "conflict";
    }
    const left = expected as Record<string, unknown>;
    const right = actual as Record<string, unknown>;
    if (
      Object.keys(right).some((key) => !(key in left || emptyWire(right[key])))
    ) {
      return "conflict";
    }
    let missing = false;
    for (const key of Object.keys(left)) {
      const result = compareWire(left[key], right[key]);
      if (result === "conflict") {
        return result;
      }
      missing ||= result === "incomplete";
    }
    return missing ? "incomplete" : "match";
  }
  return expected === actual ? "match" : "conflict";
}
const LIST_KEYS = new Set([
  "item",
  "comprobanteAsociado",
  "otroTributo",
  "subtotalIVA",
  "datoAdicional",
  "actividad",
  "comprador",
]);
const TEXT_KEYS = new Set([
  "codigo",
  "descripcion",
  "codigoMtx",
  "c1",
  "c2",
  "c3",
  "c4",
  "c5",
  "c6",
  "codigoMoneda",
  "cancelaEnMismaMonedaExtranjera",
]);
function normalizeWire(value: unknown, key = ""): unknown {
  if (value === undefined || value === null) {
    return value;
  }
  if (LIST_KEYS.has(key)) {
    return (Array.isArray(value) ? value : [value]).map((v) =>
      normalizeWire(v)
    );
  }
  if (Array.isArray(value)) {
    return value.map((v) => normalizeWire(v));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, normalizeWire(v, k)])
    );
  }
  if (TEXT_KEYS.has(key) && value !== undefined && value !== null) {
    return String(value);
  }
  if (
    !TEXT_KEYS.has(key) &&
    typeof value === "string" &&
    /^\d+(\.\d+)?$/.test(value)
  ) {
    return Number(value);
  }
  return value;
}
export function createWsmtxcaIssuanceService(wsmtxca: WsmtxcaService) {
  return {
    getNextVoucherNumber: async (
      input: Parameters<import("./wsfe").WsfeService["getNextVoucherNumber"]>[0]
    ) => (await wsmtxca.getLastAuthorizedVoucher(input)).voucherNumber + 1,
    issue: (input: {
      representedTaxId?: number | string;
      forceRefresh?: boolean;
      data: FiscalHeader;
      voucherNumber: number;
      signal?: AbortSignal;
    }) =>
      wsmtxca.issue({
        representedTaxId: input.representedTaxId,
        forceRefresh: input.forceRefresh,
        signal: input.signal,
        data: wsmtxcaRequest(input.data, input.voucherNumber),
      }),
    lookupVoucher: async (
      input: Parameters<import("./wsfe").WsfeService["lookupVoucher"]>[0]
    ) => {
      const result = await wsmtxca.lookupVoucher({
        ...input,
        voucherNumber: input.number,
      });
      return result.kind === "found"
        ? { ...result, voucher: wsmtxcaHeader(result.voucher) }
        : result;
    },
  };
}

function wsmtxcaAdditionalData(fields: WsfeVoucherInput["optionalFields"]) {
  if (!fields?.length) {
    return undefined;
  }
  const options = new Map(fields.map((f) => [f.id, f.value]));
  return {
    datoAdicional: [
      ...(options.has("2101")
        ? [{ t: 21, c1: options.get("2101"), c2: options.get("2102") }]
        : []),
      ...fields
        .filter((f) => f.id !== "2101" && f.id !== "2102")
        .map((f) => ({ t: Number(f.id), c1: f.value })),
    ],
  };
}
