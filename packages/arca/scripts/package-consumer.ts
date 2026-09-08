import {
  ArcaAuthenticationError,
  ArcaInputError,
  type ArcaInputErrorCode,
  buildFacturaB,
  buildFacturaC,
  createArcaClient,
  type IssuePreview,
  isArcaAuthenticationError,
  type NotePreview,
  type VouchersService,
  type WsfeAuthorizationOutcome,
  type WsfeAuthorizeVoucherInput,
  type WsfeVoucherInput,
} from "facturas";
import { ARCA_CURRENCY_IDS, ISO_CURRENCIES } from "facturas/constants";
import {
  ArcaAuthenticationError as SubpathAuthenticationError,
  ArcaInputError as SubpathInputError,
} from "facturas/errors";
import {
  buildFacturaB as buildFacturaBFromWsfe,
  buildFacturaC as buildFacturaCFromWsfe,
  type WsfeAuthorizeVoucherInput as SubpathAuthorizeVoucherInput,
  type WsfeVoucherInput as SubpathVoucherInput,
} from "facturas/wsfe";

const facturaB = buildFacturaB({
  salesPoint: 1,
  concept: 1,
  documentType: 99,
  documentNumber: 0,
  receiverVatConditionId: 5,
  voucherDate: "2026-09-02",
  taxableAmount: 10_000,
  vatRate: 21,
  currency: ISO_CURRENCIES.ARS,
});
const facturaC = buildFacturaCFromWsfe({
  salesPoint: 1,
  concept: 1,
  documentType: 99,
  documentNumber: 0,
  receiverVatConditionId: 5,
  voucherDate: "2026-09-02",
  amount: 10_000,
  currency: ISO_CURRENCIES.USD,
  exchangeRate: "1095.5",
});
const exactInput: WsfeVoucherInput = facturaB;
const subpathExactInput: SubpathVoucherInput = facturaC;
const authorizationInput: WsfeAuthorizeVoucherInput = {
  data: exactInput,
  voucherNumber: 1,
};
const subpathAuthorizationInput: SubpathAuthorizeVoucherInput = {
  data: subpathExactInput,
  voucherNumber: 2,
};
const inputError = new ArcaInputError("invalid date", {
  code: "ARCA_INPUT_INVALID_DATE",
  field: "voucherDate",
});
const missingReservationCode: ArcaInputErrorCode =
  "ARCA_INPUT_RESERVATION_NOT_FOUND";
const authenticationError = new ArcaAuthenticationError(
  "authentication rejected",
  {
    reason: "invalid_token",
    service: "wsfe",
    operation: "FECAESolicitar",
    providerCode: 600,
  }
);
const outcome: WsfeAuthorizationOutcome = {
  kind: "indeterminate",
  service: "wsfe",
  operation: "FECAESolicitar",
  results: {},
  errors: [],
  observations: [],
  reason: "authentication_rejected",
  authentication: {
    code: "ARCA_AUTHENTICATION_ERROR",
    reason: "invalid_token",
    providerCode: "600",
  },
};

export const packageConsumerContract = {
  createArcaClient,
  buildFacturaBFromWsfe,
  buildFacturaC,
  authorizationInput,
  subpathAuthorizationInput,
  inputError,
  missingReservationCode,
  authenticationError,
  outcome,
  isArcaAuthenticationError,
  SubpathAuthenticationError,
  SubpathInputError,
  arcaCurrencyId: ARCA_CURRENCY_IDS.ARS,
};

// Compiled against the built package (not source path aliases).
export async function facadeConsumerContract(
  client: ReturnType<typeof createArcaClient>
) {
  const input = {
    issuer: "responsable_inscripto" as const,
    salesPoint: 1,
    to: { condition: "consumidor_final" as const },
    items: [{ gross: 12_100, vat: 21 as const }],
  };
  // @ts-expect-error A non-RI issuer cannot provide VAT items.
  await client.issue({ ...input, issuer: "monotributo" });
  // @ts-expect-error An RI issuer cannot provide amount items.
  await client.issue({ ...input, items: [{ amount: 10_000 }] });
  await client.issue({
    ...input,
    // @ts-expect-error Mixed gross and net on one item is not an accepted union member.
    items: [{ gross: 100, net: 100, vat: 21 }],
  });

  const result = await client.issue(input);
  // @ts-expect-error Exact input is opt-in and authorized-only.
  result.sent;
  switch (result.kind) {
    case "authorized":
      await client.issueCreditNote({ for: result.voucher, all: true });
      result.voucher.cae satisfies string;
      result.voucher.amounts.vatAdjustment satisfies number;
      if (result.recoveredByMatch) {
        result.attempt.reason satisfies string;
        result.lookup.number satisfies number;
        // @ts-expect-error Raw evidence is absent by default.
        result.lookup.raw;
      } else {
        result.authorization.cae satisfies string;
        // @ts-expect-error Raw evidence is absent by default.
        result.authorization.raw;
      }
      break;
    case "rejected":
      result.issues satisfies { message: string }[];
      result.attempted.number satisfies number;
      break;
    case "indeterminate":
      result.attempt.reason satisfies string;
      if (result.lookup.kind === "failed") {
        result.lookup.error.message satisfies string;
      }
      break;
    case "conflict":
      result.found.number satisfies number;
      result.reason satisfies string;
      break;
    default:
      result satisfies never;
  }
  const included = await client.issue(input, {
    include: { exactInput: true, raw: true },
  });
  if (included.kind === "authorized") {
    included.sent satisfies WsfeVoucherInput;
    if (included.recoveredByMatch) {
      included.lookup.raw satisfies Record<string, unknown> | undefined;
      included.attempt.raw satisfies Record<string, unknown> | undefined;
    } else {
      included.authorization.raw satisfies Record<string, unknown> | undefined;
    }
  }
  return result;
}

export function previewConsumerContract(
  client: ReturnType<typeof createArcaClient>
) {
  const previewInput = {
    issuer: "responsable_inscripto" as const,
    salesPoint: 1,
    to: { condition: "consumidor_final" as const },
    items: [{ gross: 12_100, vat: 21 as const }],
  };
  // preview() is synchronous: the value is the request, never a promise.
  const preview: IssuePreview = client.preview(previewInput, {
    representedTaxId: "20304050607",
  });
  const request: WsfeVoucherInput = preview.request;
  preview.amounts.sentTotal satisfies number;
  preview.voucherClass satisfies "A" | "B" | "C";
  preview.voucherType satisfies number;
  // @ts-expect-error preview() returns a value, so it has no promise members.
  preview.then;
  // @ts-expect-error preview() writes nothing, so it takes no idempotency key.
  client.preview(previewInput, { idempotencyKey: "preview" });
  // @ts-expect-error A non-RI issuer cannot provide VAT items to preview().
  client.preview({ ...previewInput, issuer: "monotributo" });
  // @ts-expect-error The declared VouchersService widening requires preview.
  const mockWithoutPreview: VouchersService = {
    issue: client.issue,
    issueCreditNote: client.issueCreditNote,
  };
  mockWithoutPreview.issue satisfies VouchersService["issue"];
  return request;
}

export async function creditNoteConsumerContract(
  client: ReturnType<typeof createArcaClient>
) {
  // @ts-expect-error cancel() was removed in 0.10; use issueCreditNote().
  client.cancel;
  // @ts-expect-error The declared VouchersService widening requires issueCreditNote.
  const oldMock: VouchersService = {
    issue: client.issue,
    preview: client.preview,
  };
  oldMock.issue satisfies VouchersService["issue"];

  const target = { salesPoint: 1, voucherType: 6, number: 1 };
  const linkedPreviewInput = {
    for: target,
    items: [{ amount: 100 }],
  } as const;
  const linkedPreview: NotePreview =
    await client.previewCreditNote(linkedPreviewInput);
  linkedPreview.original?.cae satisfies string | undefined;
  linkedPreview.original?.totalAmount satisfies number | undefined;
  const periodPreview = await client.previewCreditNote({
    issuer: "responsable_inscripto",
    salesPoint: 1,
    to: { condition: "responsable_inscripto", cuit: "20123456789" },
    items: [{ net: 10_000, vat: 21 }],
    associatedPeriod: { from: "20260901", to: "20260930" },
  });
  periodPreview.original satisfies object | undefined;
  // @ts-expect-error A credit note needs exactly one mode: items, amounts or all: true.
  await client.issueCreditNote({ for: target });
  await client.issueCreditNote({
    for: target,
    items: [{ amount: 100 }],
    // @ts-expect-error items and all: true are mutually exclusive.
    all: true,
  });
  // @ts-expect-error all accepts only the literal true.
  await client.issueCreditNote({ for: target, all: false });
  await client.issueCreditNote({
    for: target,
    all: true,
    // @ts-expect-error The receiver comes from the original, never the caller.
    to: { condition: "exento", cuit: "20123456789" },
  });
  await client.issueCreditNote({
    for: target,
    all: true,
    // @ts-expect-error The currency comes from the original, never the caller.
    currency: "USD",
  });
  await client.issueCreditNote({
    for: target,
    all: true,
    // @ts-expect-error Linked notes and period notes are mutually exclusive.
    associatedPeriod: { from: "20260901", to: "20260930" },
  });
  await client.issueCreditNote({
    for: target,
    // @ts-expect-error One note cannot mix amount items with VAT items.
    items: [{ amount: 100 }, { gross: 121, vat: 21 }],
  });
  // The class follows the original, so an item shape that contradicts it is a
  // runtime ArcaInputError naming the class, not a type error.

  const full = await client.issueCreditNote({
    for: target,
    all: true,
    date: "20260905",
  });
  switch (full.kind) {
    case "authorized":
      full.voucher.cae satisfies string;
      full.voucher.voucherType satisfies number;
      if (full.recoveredByMatch) {
        full.lookup.number satisfies number;
      } else {
        full.authorization.cae satisfies string;
      }
      // @ts-expect-error Exact input remains opt-in.
      full.sent;
      break;
    case "rejected":
      full.issues satisfies { message: string }[];
      break;
    case "conflict":
      full.found.number satisfies number;
      break;
    case "indeterminate":
      full.lookup.kind satisfies string;
      break;
    default:
      full satisfies never;
  }

  const partial = await client.issueCreditNote(
    {
      for: target,
      salesPoint: 1,
      items: [{ gross: 6050, vat: 21 }],
      total: 6050,
    },
    { idempotencyKey: "nc:1", include: { exactInput: true, raw: true } }
  );
  switch (partial.kind) {
    case "authorized":
      partial.sent satisfies WsfeVoucherInput;
      partial.voucher.amounts.sentTotal satisfies number;
      break;
    case "rejected":
      partial.attempted.number satisfies number;
      break;
    case "conflict":
      partial.reason satisfies string;
      break;
    case "indeterminate":
      partial.attempt.reason satisfies string;
      break;
    default:
      partial satisfies never;
  }
}

export async function completeIssuanceConsumerContract(
  client: ReturnType<typeof createArcaClient>
) {
  const input = {
    issuer: "responsable_inscripto" as const,
    salesPoint: 1,
    to: { condition: 1, cuit: "20123456789" },
    amounts: {
      net: 10_000,
      vat: 2100,
      vatRates: [{ id: 5, base: 10_000, amount: 2100 }],
    },
    details: [
      {
        description: "Product",
        quantity: 1,
        unit: 7,
        unitPrice: "100",
        vatCondition: 5,
        vatAmount: 2100,
        amount: 12_100,
      },
    ],
  };
  const preview = client.preview(input, { service: "wsmtxca" });
  preview.request.comprobanteCAERequest.arrayItems.item[0]
    ?.precioUnitario satisfies string | undefined;
  // @ts-expect-error Detailed previews expose the actual WSMTXCA request.
  preview.request.voucherType;
  const issued = await client.issue(input, {
    service: "wsmtxca",
    number: 42,
    include: { exactInput: true },
  });
  if (issued.kind === "authorized") {
    issued.sent.comprobanteCAERequest.importeTotal satisfies number;
    if (!issued.recoveredByMatch) {
      issued.authorization.service satisfies "wsmtxca";
    }
  }
  const { details: _details, ...header } = input;
  client.preview(header).request satisfies WsfeVoucherInput;
  const period = {
    ...header,
    associatedPeriod: { from: "20260901" as const, to: "20260906" as const },
  };
  await client.previewDebitNote(period);
  await client.issueDebitNote(period, { idempotencyKey: "debit" });
  const recovery = await client.recover("debit", {
    include: { exactInput: true },
  });
  if (
    recovery.kind === "authorized" &&
    "comprobanteCAERequest" in recovery.sent
  ) {
    recovery.sent.comprobanteCAERequest.importeTotal satisfies number;
  }
}
