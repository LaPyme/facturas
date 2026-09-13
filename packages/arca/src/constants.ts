/** Common ARCA reference data for readable userland code and examples. */
export const ARCA_VOUCHER_TYPES = {
  FACTURA_A: 1,
  NOTA_DEBITO_A: 2,
  NOTA_CREDITO_A: 3,
  FACTURA_B: 6,
  NOTA_DEBITO_B: 7,
  NOTA_CREDITO_B: 8,
  FACTURA_C: 11,
  NOTA_DEBITO_C: 12,
  NOTA_CREDITO_C: 13,
} as const;

/** Common document types accepted by ARCA services. */
export const ARCA_DOCUMENT_TYPES = {
  CUIT: 80,
  DNI: 96,
  CONSUMIDOR_FINAL: 99,
} as const;

/**
 * Common receiver IVA condition identifiers used by WSFE.
 * Allowed values depend on the voucher class and ARCA's live catalog.
 */
export const ARCA_RECEIVER_VAT_CONDITIONS = {
  RESPONSABLE_INSCRIPTO: 1,
  EXENTO: 4,
  CONSUMIDOR_FINAL: 5,
  MONOTRIBUTISTA: 6,
  IVA_NO_ALCANZADO: 15,
} as const;

/** Supported invoice concept types for WSFE requests. */
export const ARCA_CONCEPT_TYPES = {
  PRODUCTOS: 1,
  SERVICIOS: 2,
  PRODUCTOS_Y_SERVICIOS: 3,
} as const;

/** Common IVA rate identifiers used by WSFE. */
export const ARCA_VAT_RATES = {
  IVA_0: 3,
  IVA_10_5: 4,
  IVA_21: 5,
  IVA_27: 6,
  IVA_5: 8,
  IVA_2_5: 9,
} as const;

/** ISO currency codes accepted by the high-level WSFE builders. */
export const ISO_CURRENCIES = {
  ARS: "ARS",
  USD: "USD",
} as const;

/** ARCA currency identifiers keyed by their corresponding ISO currency. */
export const ARCA_CURRENCY_IDS = {
  ARS: "PES",
  USD: "DOL",
} as const;

/**
 * Common ARCA currency identifiers.
 * @deprecated Use ISO_CURRENCIES, or ARCA_CURRENCY_IDS at the provider boundary.
 */
export const ARCA_CURRENCIES = {
  PES: "PES",
  DOL: "DOL",
} as const;

/** Legal assertions supported by the invoice high-level API; never inferred from Padrón. */
export type IssuerCondition =
  | "responsable_inscripto"
  | "monotributo"
  | "exento"
  | "no_alcanzado";
export type ReceiverCondition = IssuerCondition | "consumidor_final";
export type VoucherClass = "A" | "B" | "C";

export const ARCA_RECEIVER_CONDITION_IDS = {
  responsable_inscripto: ARCA_RECEIVER_VAT_CONDITIONS.RESPONSABLE_INSCRIPTO,
  monotributo: ARCA_RECEIVER_VAT_CONDITIONS.MONOTRIBUTISTA,
  exento: ARCA_RECEIVER_VAT_CONDITIONS.EXENTO,
  consumidor_final: ARCA_RECEIVER_VAT_CONDITIONS.CONSUMIDOR_FINAL,
  no_alcanzado: ARCA_RECEIVER_VAT_CONDITIONS.IVA_NO_ALCANZADO,
} as const satisfies Record<ReceiverCondition, number>;

export const ARCA_ISSUER_CONDITION_IDS = {
  responsable_inscripto: 1,
  monotributo: 6,
  exento: 4,
  no_alcanzado: 15,
} as const satisfies Record<IssuerCondition, number>;

// RG 5866/2026, art. 1(f), effective 2026-07-01 (art. 4).
// https://www.argentina.gob.ar/normativa/nacional/norma-427092/texto
export const ARCA_FINAL_CONSUMER_IDENTIFICATION_THRESHOLD_MINOR_UNITS =
  1_000_000_000n;

// WSFE v4.7, physical PDF p. 203, validations 10243/10246; issuer asserted first.
// ARCA checks actual issuer eligibility independently at authorization.
export const ARCA_INVOICE_CLASS_BY_ISSUER = {
  responsable_inscripto: {
    responsable_inscripto: "A",
    monotributo: "A",
    exento: "B",
    consumidor_final: "B",
    no_alcanzado: "B",
  },
  monotributo: {
    responsable_inscripto: "C",
    monotributo: "C",
    exento: "C",
    consumidor_final: "C",
    no_alcanzado: "C",
  },
  exento: {
    responsable_inscripto: "C",
    monotributo: "C",
    exento: "C",
    consumidor_final: "C",
    no_alcanzado: "C",
  },
  no_alcanzado: {
    responsable_inscripto: "C",
    monotributo: "C",
    exento: "C",
    consumidor_final: "C",
    no_alcanzado: "C",
  },
} as const satisfies Record<
  IssuerCondition,
  Record<ReceiverCondition, VoucherClass>
>;
