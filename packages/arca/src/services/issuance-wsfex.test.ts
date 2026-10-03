import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
import { createMemoryStore } from "../store/memory";
import { attemptKey } from "../store/types";
import { describeVoucherType } from "./issuance-fields";
import {
  createExportIssuance,
  deriveExportInvoice,
  type ExportCreditNoteInput,
  type ExportIssueInput,
} from "./issuance-wsfex";
import { createVouchersService } from "./vouchers";
import { voucherDateWindow } from "./wsfe-derive";
import type {
  WsfexAuthorizationOutcome,
  WsfexIssueInput,
  WsfexService,
  WsfexVoucherInfo,
} from "./wsfex";

// ARCA only accepts an export voucher dated 5 days either side of today.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-02T15:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const TAX_ID = "20123456786";

const services: ExportIssueInput = {
  salesPoint: 5,
  to: {
    country: 203,
    name: "Joao Da Silva",
    address: "Rua 76 km 34.5 Alagoas",
    taxId: "PJ54482221-l",
  },
  export: { kind: "services", paymentDate: "2026-10-15" },
  currency: "USD",
  exchangeRate: "1450.5",
  paymentTerms: "Transferencia bancaria",
  items: [
    {
      description: "Desarrollo de software",
      unit: 7,
      quantity: 2,
      unitPrice: "750",
      amount: 150_000,
    },
  ],
};

const goods: ExportIssueInput = {
  ...services,
  export: { kind: "goods", incoterms: "FOB" },
  items: [
    {
      description: "Yerba mate 1 kg",
      unit: 1,
      quantity: 10,
      unitPrice: "4.5",
      discount: 500,
      amount: 4000,
    },
  ],
};

type Behavior = (
  input: WsfexIssueInput
) => WsfexAuthorizationOutcome | undefined;

/**
 * An in-memory WSFEX: numbers advance per sales point and type, approved
 * requests are kept by id, and a repeated id answers the stored voucher.
 */
function arca() {
  let lastId = 40;
  const numbers = new Map<string, number>();
  const byId = new Map<number, WsfexIssueInput>();
  const vouchers = new Map<string, WsfexVoucherInfo>();
  const behaviors: Behavior[] = [];
  const sequenceOf = (v: { salesPoint: number; voucherType: number }) =>
    `${v.salesPoint}:${v.voucherType}`;
  const coordinates = (v: {
    salesPoint: number;
    voucherType: number;
    number: number;
  }) => `${sequenceOf(v)}:${v.number}`;
  const base = {
    service: "wsfex" as const,
    operation: "FEXAuthorize",
    results: {},
    errors: [],
    observations: [],
  };
  const answer = (stored: WsfexIssueInput, reprocessed: boolean) =>
    ({
      ...base,
      kind: "authorized",
      result: "A",
      resultLevel: "header",
      cae: "75123456789012",
      caeExpiry: "20261012",
      voucherNumber: stored.number,
      reprocessed,
      echo: {
        id: stored.id,
        salesPoint: stored.salesPoint,
        voucherType: stored.voucherType,
        number: stored.number,
      },
    }) satisfies WsfexAuthorizationOutcome;
  const wsfex = {
    getLastRequestId: vi.fn(() => Promise.resolve(lastId)),
    getLastVoucherNumber: vi.fn(
      (input: { salesPoint: number; voucherType: number }) =>
        Promise.resolve(numbers.get(sequenceOf(input)) ?? 0)
    ),
    issue: vi.fn((input: WsfexIssueInput) => {
      const override = behaviors.shift()?.(input);
      if (override) {
        return Promise.resolve(override);
      }
      const stored = byId.get(input.id);
      if (stored) {
        return Promise.resolve(answer(stored, true));
      }
      const sequence = sequenceOf(input);
      if ((numbers.get(sequence) ?? 0) + 1 !== input.number) {
        return Promise.resolve({
          ...base,
          kind: "rejected",
          result: "R",
          resultLevel: "header",
          errors: [
            {
              service: "wsfex",
              operation: "FEXAuthorize",
              source: "error",
              category: "business",
              code: "1535",
              message: "Comprobante fuera de secuencia",
            },
          ],
        } satisfies WsfexAuthorizationOutcome);
      }
      approve(input);
      return Promise.resolve(answer(input, false));
    }),
    lookupVoucher: vi.fn(
      (input: { salesPoint: number; voucherType: number; number: number }) => {
        const voucher = vouchers.get(coordinates(input));
        return Promise.resolve(
          voucher
            ? {
                kind: "found" as const,
                service: "wsfex" as const,
                operation: "FEXGetCMP",
                observations: [],
                raw: {},
                voucher,
              }
            : {
                kind: "not_found" as const,
                service: "wsfex" as const,
                operation: "FEXGetCMP",
                errors: [],
                observations: [],
                raw: {},
              }
        );
      }
    ),
  };
  function approve(input: WsfexIssueInput) {
    const { representedTaxId, forceRefresh, abortSignal, ...sent } = input;
    byId.set(input.id, input);
    lastId = Math.max(lastId, input.id);
    numbers.set(sequenceOf(input), input.number);
    vouchers.set(coordinates(input), {
      ...sent,
      result: "A",
      cae: "75123456789012",
      caeExpiry: "20261012",
    });
  }
  return {
    wsfex: wsfex as unknown as WsfexService,
    calls: wsfex,
    behaviors,
    approve,
    vouchers,
    useId: (id: number) => {
      lastId = id;
    },
  };
}

const wsfe = {
  getNextVoucherNumber: vi.fn(),
  issue: vi.fn(),
  lookupVoucher: vi.fn(),
};

function client(store = createMemoryStore()) {
  const fake = arca();
  return {
    ...fake,
    store,
    service: createVouchersService(
      wsfe,
      { store, environment: "test", taxId: TAX_ID },
      undefined,
      fake.wsfex
    ),
  };
}

describe("deriveExportInvoice", () => {
  it("derives a Factura E of services with ARCA's fields", () => {
    const { data, amounts } = deriveExportInvoice(services);
    expect(data).toEqual({
      voucherType: 19,
      salesPoint: 5,
      voucherDate: "20261002",
      exportType: 2,
      destination: 203,
      receiverName: "Joao Da Silva",
      receiverAddress: "Rua 76 km 34.5 Alagoas",
      receiverTaxId: "PJ54482221-l",
      currencyId: "DOL",
      exchangeRate: "1450.5",
      totalAmount: 1500,
      paymentTerms: "Transferencia bancaria",
      language: 1,
      items: [
        {
          description: "Desarrollo de software",
          unit: 7,
          quantity: 2,
          unitPrice: "750",
          amount: 1500,
        },
      ],
      paymentDate: "20261015",
    });
    expect(amounts).toEqual({
      computedTotal: 150_000,
      sentTotal: 150_000,
      vatAdjustment: 0,
    });
  });

  it("declares a pending permit for goods without one", () => {
    const { data } = deriveExportInvoice(goods);
    expect(data).toMatchObject({
      exportType: 1,
      permitExists: "N",
      incoterms: "FOB",
      totalAmount: 40,
    });
    expect(data.items[0]).toMatchObject({ discount: 5, amount: 40 });
    expect(data).not.toHaveProperty("paymentDate");
  });

  it("declares issued permits for goods with them", () => {
    const { data } = deriveExportInvoice({
      ...goods,
      export: {
        kind: "goods",
        incoterms: "CIF",
        permits: [{ id: "09052EC01006154G", destination: 203 }],
      },
    });
    expect(data).toMatchObject({
      permitExists: "S",
      permits: [{ id: "09052EC01006154G", destination: 203 }],
    });
  });

  it("maps the language and the same-currency payment", () => {
    const { data } = deriveExportInvoice({
      ...services,
      language: "en",
      paidInForeignCurrency: true,
    });
    expect(data).toMatchObject({
      language: 2,
      sameCurrencyForeignCancellation: "S",
    });
  });

  it.each([
    [{ ...services, exchangeRate: undefined }, "exchangeRate"],
    [{ ...services, currency: "ARS", exchangeRate: "2" }, "exchangeRate"],
    [
      {
        ...services,
        currency: "ARS",
        exchangeRate: undefined,
        paidInForeignCurrency: true,
      },
      "paidInForeignCurrency",
    ],
    [{ ...services, to: { ...services.to, taxId: undefined } }, "to.taxId"],
    [
      { ...services, to: { ...services.to, countryTaxId: "123" } },
      "to.countryTaxId",
    ],
    [{ ...services, paymentTerms: "" }, "paymentTerms"],
    [
      { ...services, export: { kind: "services", paymentDate: "2026-10-01" } },
      "export.paymentDate",
    ],
    [
      { ...goods, export: { kind: "goods", incoterms: "fob" } },
      "export.incoterms",
    ],
    [
      { ...goods, export: { kind: "goods", incoterms: "FOB", permits: [] } },
      "export.permits",
    ],
    [
      { ...services, items: [{ ...services.items[0], amount: 149_000 }] },
      "items[0].amount",
    ],
    [
      {
        ...services,
        items: [{ description: "Descuento", unit: 99, amount: 100 }],
      },
      "items[0].amount",
    ],
    [
      { ...services, items: [{ description: "Horas", unit: 7, amount: 100 }] },
      "items[0].quantity",
    ],
    [{ ...services, total: 1 }, "total"],
    [{ ...services, salesPoint: 99_999 }, "salesPoint"],
    [{ ...services, issuer: "monotributo" }, "issuer"],
  ])("rejects %#", (input, field) => {
    expect(() => deriveExportInvoice(input as ExportIssueInput)).toThrowError(
      expect.objectContaining({ name: "ArcaInputError", field })
    );
  });
});

describe("issue() with an export input", () => {
  it("reads the number and the request id and authorizes through WSFEX", async () => {
    const { service, calls } = client();
    const outcome = await service.issue(services);
    expect(calls.issue).toHaveBeenCalledWith(
      expect.objectContaining({ id: 41, number: 1, voucherType: 19 })
    );
    expect(wsfe.issue).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      kind: "authorized",
      recoveredByMatch: false,
      voucher: {
        salesPoint: 5,
        voucherType: 19,
        number: 1,
        voucherClass: "E",
        requestId: 41,
        date: "2026-10-02",
        cae: "75123456789012",
        caeExpiry: "2026-10-12",
        header: {
          exportType: 2,
          destination: 203,
          currencyId: "DOL",
          exchangeRate: "1450.5",
          paymentDate: "2026-10-15",
        },
      },
    });
    if (outcome.kind !== "authorized") {
      throw new Error("expected an authorization");
    }
    expect(outcome.voucher.qrPayload).toMatchObject({
      cuit: 20_123_456_786,
      tipoCmp: 19,
      nroCmp: 1,
      importe: 1500,
      moneda: "DOL",
      ctz: 1450.5,
    });
    expect(outcome.voucher.qrPayload).not.toHaveProperty("tipoDocRec");
  });

  it("previews with no I/O", () => {
    const { service, calls } = client();
    const preview = service.preview(services);
    expect(preview).toMatchObject({
      voucherClass: "E",
      voucherType: 19,
      service: "wsfex",
      request: { exportType: 2, totalAmount: 1500 },
    });
    expect(calls.getLastRequestId).not.toHaveBeenCalled();
  });

  it("refuses a WSFE service or a reserved number", async () => {
    const { service } = client();
    await expect(
      service.issue(services, { service: "wsfe" })
    ).rejects.toMatchObject({ field: "options.service" });
    await expect(service.issue(services, { number: 3 })).rejects.toMatchObject({
      field: "options.number",
    });
  });

  it("returns ARCA's validation error as a rejection", async () => {
    const { service, behaviors } = client();
    behaviors.push(() => ({
      service: "wsfex",
      operation: "FEXAuthorize",
      kind: "rejected",
      result: "R",
      resultLevel: "header",
      results: {},
      observations: [],
      errors: [
        {
          service: "wsfex",
          operation: "FEXAuthorize",
          source: "error",
          category: "business",
          code: "1510",
          message: "Punto de venta no habilitado",
        },
      ],
    }));
    const outcome = await service.issue(services);
    expect(outcome).toMatchObject({
      kind: "rejected",
      attempted: { salesPoint: 5, voucherType: 19, number: 1 },
      issues: [expect.objectContaining({ code: "1510" })],
    });
  });

  it("retries once with a fresh ticket after an authentication rejection", async () => {
    const { service, behaviors, calls } = client();
    behaviors.push(() => ({
      service: "wsfex",
      operation: "FEXAuthorize",
      kind: "indeterminate",
      reason: "authentication_rejected",
      results: {},
      errors: [],
      observations: [],
    }));
    const outcome = await service.issue(services);
    expect(outcome.kind).toBe("authorized");
    expect(calls.issue).toHaveBeenCalledTimes(2);
    expect(calls.issue.mock.calls[1][0]).toMatchObject({
      id: 41,
      forceRefresh: true,
    });
  });

  it("recovers an unanswered send by the request id ARCA stored", async () => {
    const { service, behaviors, approve } = client();
    behaviors.push((input) => {
      approve(input);
      return {
        service: "wsfex",
        operation: "FEXAuthorize",
        kind: "indeterminate",
        reason: "transport_error",
        results: {},
        errors: [],
        observations: [],
      };
    });
    const outcome = await service.issue(services);
    expect(outcome).toMatchObject({
      kind: "authorized",
      recoveredByMatch: true,
      voucher: { requestId: 41, number: 1 },
      lookup: { requestId: 41, number: 1 },
    });
  });

  it("answers indeterminate when ARCA has no voucher at the number", async () => {
    const { service, behaviors } = client();
    behaviors.push(() => ({
      service: "wsfex",
      operation: "FEXAuthorize",
      kind: "indeterminate",
      reason: "transport_error",
      results: {},
      errors: [],
      observations: [],
    }));
    const outcome = await service.issue(services);
    expect(outcome).toMatchObject({
      kind: "indeterminate",
      lookup: { kind: "not_found" },
    });
  });

  it("reports a conflict when another request holds the number", async () => {
    const { service, behaviors, approve } = client();
    behaviors.push((input) => {
      approve({ ...input, id: 99, receiverName: "Otro" });
      return {
        service: "wsfex",
        operation: "FEXAuthorize",
        kind: "indeterminate",
        reason: "transport_error",
        results: {},
        errors: [],
        observations: [],
      };
    });
    const outcome = await service.issue(services);
    expect(outcome).toMatchObject({
      kind: "conflict",
      found: { requestId: 99, receiverName: "Otro" },
    });
  });

  it("takes a new request id when ARCA answers another request's voucher", async () => {
    const store = createMemoryStore();
    const { service, behaviors, calls, useId } = client(store);
    behaviors.push((input) => {
      // Someone outside this store sent id 41 first, for another number.
      useId(41);
      return {
        service: "wsfex",
        operation: "FEXAuthorize",
        kind: "authorized",
        result: "A",
        resultLevel: "header",
        results: {},
        errors: [],
        observations: [],
        cae: "75000000000000",
        voucherNumber: 7,
        reprocessed: true,
        echo: { id: input.id, salesPoint: 2, voucherType: 19, number: 7 },
      };
    });
    const outcome = await service.issue(services, { idempotencyKey: "sale-1" });
    expect(outcome).toMatchObject({
      kind: "authorized",
      voucher: { requestId: 42, number: 1 },
    });
    expect(calls.issue.mock.calls.map(([input]) => input.id)).toEqual([41, 42]);
    const record = JSON.parse(
      (await store.get(attemptKey("test", TAX_ID, "sale-1"))) as string
    );
    expect(record).toMatchObject({
      service: "wsfex",
      requestId: 42,
      number: 1,
    });
  });
});

describe("keyed export issuance", () => {
  it("replays the same request id and number, and ARCA answers its record", async () => {
    const { service, calls } = client();
    const first = await service.issue(services, { idempotencyKey: "sale-1" });
    const again = await service.issue(services, { idempotencyKey: "sale-1" });
    expect(first.kind).toBe("authorized");
    expect(again).toMatchObject({
      kind: "authorized",
      voucher: { requestId: 41, number: 1 },
    });
    expect(calls.getLastRequestId).toHaveBeenCalledTimes(1);
    expect(
      calls.issue.mock.calls.map(([input]) => [input.id, input.number])
    ).toEqual([
      [41, 1],
      [41, 1],
    ]);
  });

  it("refuses a key reused with different input", async () => {
    const { service } = client();
    await service.issue(services, { idempotencyKey: "sale-1" });
    await expect(
      service.issue(goods, { idempotencyKey: "sale-1" })
    ).rejects.toMatchObject({ code: "ARCA_INPUT_IDEMPOTENCY_MISMATCH" });
  });

  it("keeps WSFE from replaying an export reservation", async () => {
    const { service } = client();
    await service.issue(services, { idempotencyKey: "sale-1" });
    await expect(
      service.issue(
        {
          issuer: "monotributo",
          salesPoint: 1,
          to: { condition: "consumidor_final" },
          items: [{ amount: 100 }],
        },
        { idempotencyKey: "sale-1" }
      )
    ).rejects.toMatchObject({ code: "ARCA_INPUT_IDEMPOTENCY_MISMATCH" });
  });

  it("recovers an export reservation from ARCA's record, without sending", async () => {
    const { service, calls } = client();
    await service.issue(services, { idempotencyKey: "sale-1" });
    const outcome = await service.recover("sale-1", {
      include: { request: true },
    });
    expect(outcome).toMatchObject({
      kind: "authorized",
      recoveredByMatch: true,
      voucher: {
        voucherClass: "E",
        requestId: 41,
        number: 1,
        cae: "75123456789012",
      },
      lookup: { requestId: 41 },
      request: { id: 41, number: 1 },
    });
    expect(calls.issue).toHaveBeenCalledTimes(1);
  });

  it("answers indeterminate when an export reservation never reached ARCA", async () => {
    const { service, behaviors, calls } = client();
    behaviors.push(() => ({
      service: "wsfex",
      operation: "FEXAuthorize",
      kind: "indeterminate",
      reason: "transport_error",
      results: {},
      errors: [],
      observations: [],
    }));
    await service.issue(services, { idempotencyKey: "sale-1" });
    await expect(service.recover("sale-1")).resolves.toMatchObject({
      kind: "indeterminate",
      attempted: { salesPoint: 5, voucherType: 19, number: 1 },
      lookup: { kind: "not_found" },
    });
    expect(calls.issue).toHaveBeenCalledTimes(1);
  });

  it("requires a store for a key", async () => {
    const fake = arca();
    const service = createVouchersService(
      wsfe,
      { environment: "test", taxId: TAX_ID },
      undefined,
      fake.wsfex
    );
    await expect(
      service.issue(services, { idempotencyKey: "sale-1" })
    ).rejects.toMatchObject({ name: "ArcaConfigurationError" });
  });
});

describe("export notes", () => {
  async function invoiced() {
    const fake = client();
    const outcome = await fake.service.issue(services);
    if (outcome.kind !== "authorized") {
      throw new Error("expected an authorization");
    }
    return { ...fake, invoice: outcome.voucher };
  }

  it("credits chosen lines and inherits the rest from the original", async () => {
    const { service, calls, invoice } = await invoiced();
    const note: ExportCreditNoteInput = {
      for: { salesPoint: 5, voucherType: 19, number: invoice.number },
      items: [
        {
          description: "Ajuste",
          unit: 7,
          quantity: 1,
          unitPrice: "100",
          amount: 10_000,
        },
      ],
    };
    const outcome = await service.issueCreditNote(note);
    expect(outcome).toMatchObject({
      kind: "authorized",
      voucher: { voucherType: 21, number: 1, requestId: 42 },
    });
    expect(calls.issue.mock.calls[1][0]).toMatchObject({
      voucherType: 21,
      exportType: 2,
      destination: 203,
      currencyId: "DOL",
      exchangeRate: "1450.5",
      totalAmount: 100,
      associatedVouchers: [{ voucherType: 19, salesPoint: 5, number: 1 }],
    });
    expect(calls.issue.mock.calls[1][0]).not.toHaveProperty("paymentDate");
    expect(calls.issue.mock.calls[1][0]).not.toHaveProperty("permitExists");
    expect(calls.issue.mock.calls[1][0]).not.toHaveProperty(
      "sameCurrencyForeignCancellation"
    );
  });

  it("credits every line with all", async () => {
    const { service, calls, invoice } = await invoiced();
    await service.issueCreditNote({
      for: { salesPoint: 5, voucherType: 19, number: invoice.number },
      all: true,
    });
    expect(calls.issue.mock.calls[1][0]).toMatchObject({
      voucherType: 21,
      totalAmount: 1500,
      items: [
        expect.objectContaining({ description: "Desarrollo de software" }),
      ],
    });
  });

  it("refuses a new rate on a services note", async () => {
    const { service, invoice } = await invoiced();
    await expect(
      service.issueCreditNote({
        for: { salesPoint: 5, voucherType: 19, number: invoice.number },
        all: true,
        exchangeRate: "1500",
      })
    ).rejects.toMatchObject({ field: "exchangeRate" });
  });

  it("previews a note from the original without reserving anything", async () => {
    const { service, calls, invoice } = await invoiced();
    const preview = await service.previewDebitNote({
      for: { salesPoint: 5, voucherType: 19, number: invoice.number },
      items: [
        {
          description: "Intereses",
          unit: 7,
          quantity: 1,
          unitPrice: "10",
          amount: 1000,
        },
      ],
    });
    expect(preview).toMatchObject({
      voucherType: 20,
      originals: [{ number: 1, requestId: 41 }],
    });
    expect(calls.issue).toHaveBeenCalledTimes(1);
  });

  it("fails clearly when ARCA has no such original", async () => {
    const { service } = client();
    await expect(
      service.issueCreditNote({
        for: { salesPoint: 5, voucherType: 19, number: 8 },
        all: true,
      })
    ).rejects.toMatchObject({ name: "ArcaInputError", field: "for" });
  });
});

describe("export consultations", () => {
  it("routes types 19 to 21 to WSFEX", async () => {
    const { service, calls } = client();
    await service.issue(services);
    await expect(
      service.lastAuthorized({ salesPoint: 5, voucherType: 19 })
    ).resolves.toBe(1);
    await expect(
      service.lookup({ salesPoint: 5, voucherType: 19, number: 1 })
    ).resolves.toMatchObject({
      number: 1,
      requestId: 41,
      totalAmount: 150_000,
      date: "2026-10-02",
    });
    await expect(
      service.lookup({ salesPoint: 5, voucherType: 19, number: 2 })
    ).resolves.toBeNull();
    expect(calls.lookupVoucher).toHaveBeenCalledTimes(2);
    expect(wsfe.lookupVoucher).not.toHaveBeenCalled();
  });
});

describe("export input checks and locks", () => {
  it("validates an export lookup before calling WSFEX", async () => {
    const { service, calls } = client();
    await expect(
      service.lookup({ salesPoint: 0, voucherType: 19, number: 1 })
    ).rejects.toMatchObject({
      name: "ArcaInputError",
      field: "voucher.salesPoint",
    });
    await expect(
      service.lastAuthorized({ salesPoint: 5, voucherType: 19 }, {
        number: 3,
      } as never)
    ).rejects.toMatchObject({ name: "ArcaInputError" });
    expect(calls.lookupVoucher).not.toHaveBeenCalled();
    expect(calls.getLastVoucherNumber).not.toHaveBeenCalled();
  });

  it("stops waiting for the in-process lock when the caller aborts", async () => {
    const fake = arca();
    const service = createVouchersService(
      wsfe,
      { environment: "test", taxId: TAX_ID },
      undefined,
      fake.wsfex
    );
    let finish: () => void = () => undefined;
    fake.calls.getLastRequestId.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(40);
        })
    );
    const holder = service.issue(services);
    await Promise.resolve();
    const controller = new AbortController();
    const waiter = service.issue(services, {
      abortSignal: controller.signal,
    });
    controller.abort();
    await expect(waiter).rejects.toMatchObject({
      name: "ArcaLockTimeoutError",
      reason: "aborted",
    });
    finish();
    await expect(holder).resolves.toMatchObject({ kind: "authorized" });
    expect(fake.calls.issue).toHaveBeenCalledTimes(1);
  });

  it("fails clearly when a fresh request id collides twice", async () => {
    const { service, behaviors } = client();
    const collision = (input: WsfexIssueInput) =>
      ({
        service: "wsfex",
        operation: "FEXAuthorize",
        kind: "authorized",
        result: "A",
        resultLevel: "header",
        results: {},
        errors: [],
        observations: [],
        cae: "75000000000000",
        voucherNumber: 7,
        reprocessed: true,
        echo: { id: input.id, salesPoint: 2, voucherType: 19, number: 7 },
      }) satisfies WsfexAuthorizationOutcome;
    behaviors.push(collision, collision);
    await expect(service.issue(services)).rejects.toMatchObject({
      name: "ArcaConfigurationError",
    });
  });

  it("reads a WSFE reservation once on recover()", async () => {
    const store = createMemoryStore();
    const { service } = client(store);
    const get = vi.spyOn(store, "get");
    await expect(service.recover("missing")).rejects.toMatchObject({
      code: "ARCA_INPUT_RESERVATION_NOT_FOUND",
    });
    expect(
      get.mock.calls.filter(
        ([key]) => key === attemptKey("test", TAX_ID, "missing")
      )
    ).toHaveLength(1);
  });
});

describe("request id ownership", () => {
  const other: ExportIssueInput = {
    ...services,
    to: { ...services.to, name: "Otro Cliente S.A.", taxId: "99887766" },
  };
  const unanswered = () =>
    ({
      service: "wsfex",
      operation: "FEXAuthorize",
      kind: "indeterminate",
      reason: "transport_error",
      results: {},
      errors: [],
      observations: [],
    }) satisfies WsfexAuthorizationOutcome;

  it("never hands an unanswered key's request id to the next key", async () => {
    const { service, behaviors, calls } = client();
    behaviors.push(unanswered);
    const first = await service.issue(services, { idempotencyKey: "sale-a" });
    expect(first).toMatchObject({ kind: "indeterminate" });
    const second = await service.issue(other, { idempotencyKey: "sale-b" });
    expect(second).toMatchObject({
      kind: "authorized",
      voucher: { requestId: 42, number: 1 },
    });
    expect(calls.issue.mock.calls.map(([input]) => input.id)).toEqual([41, 42]);
    // The first key's number went to the second: it can never write.
    await expect(
      service.issue(services, { idempotencyKey: "sale-a" })
    ).resolves.toMatchObject({ kind: "conflict", found: { requestId: 42 } });
    await expect(service.recover("sale-a")).resolves.toMatchObject({
      kind: "conflict",
      found: { requestId: 42, receiverName: "Otro Cliente S.A." },
    });
  });

  it("refuses a voucher another system stored under this key's request id", async () => {
    const { service, behaviors, approve } = client();
    behaviors.push((input) => {
      // Another system on this CUIT sent id 41 for the same number first.
      approve({ ...input, receiverName: "Otro Cliente S.A." });
      return unanswered();
    });
    await expect(
      service.issue(services, { idempotencyKey: "sale-a" })
    ).resolves.toMatchObject({
      kind: "conflict",
      found: { requestId: 41, receiverName: "Otro Cliente S.A." },
    });
  });

  it("refuses a credit note with both items and all", async () => {
    const { service } = client();
    const invoice = await service.issue(services);
    if (invoice.kind !== "authorized") {
      throw new Error("expected an authorization");
    }
    await expect(
      service.issueCreditNote({
        for: { salesPoint: 5, voucherType: 19, number: invoice.voucher.number },
        all: true,
        items: [
          {
            description: "Ajuste",
            unit: 7,
            quantity: 1,
            unitPrice: "10",
            amount: 1000,
          },
        ],
      } as never)
    ).rejects.toMatchObject({ name: "ArcaInputError", field: "all" });
  });
});

describe("recovery evidence", () => {
  const unanswered = () =>
    ({
      service: "wsfex",
      operation: "FEXAuthorize",
      kind: "indeterminate",
      reason: "transport_error",
      results: {},
      errors: [],
      observations: [],
    }) satisfies WsfexAuthorizationOutcome;

  it("refuses a reused request id for another receiver tax ID", async () => {
    const { service, behaviors, approve } = client();
    behaviors.push((input) => {
      approve({ ...input, receiverTaxId: "OTRO-123" });
      return unanswered();
    });
    await expect(
      service.issue(services, { idempotencyKey: "sale-a" })
    ).resolves.toMatchObject({
      kind: "conflict",
      found: { requestId: 41, receiverTaxId: "OTRO-123" },
    });
  });

  it("stays indeterminate when ARCA's record carries no CAE", async () => {
    const { service, behaviors, approve, vouchers } = client();
    behaviors.push((input) => {
      approve(input);
      const stored = vouchers.get("5:19:1");
      if (stored) {
        vouchers.set("5:19:1", {
          ...stored,
          cae: undefined,
          caeExpiry: undefined,
        });
      }
      return unanswered();
    });
    await expect(service.issue(services)).resolves.toMatchObject({
      kind: "indeterminate",
      lookup: { kind: "incomplete" },
    });
  });

  it("keeps later callers behind the holder when the last waiter aborts", async () => {
    const fake = arca();
    const service = createVouchersService(
      wsfe,
      { environment: "test", taxId: TAX_ID },
      undefined,
      fake.wsfex
    );
    let finish: () => void = () => undefined;
    fake.calls.getLastRequestId.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(40);
        })
    );
    const holder = service.issue(services);
    await Promise.resolve();
    const controller = new AbortController();
    const waiter = service.issue(services, { abortSignal: controller.signal });
    controller.abort();
    await expect(waiter).rejects.toMatchObject({ reason: "aborted" });
    const later = service.issue(services);
    for (let tick = 0; tick < 10; tick++) {
      await Promise.resolve();
    }
    // The holder read its number; the later call must not read one yet.
    expect(fake.calls.getLastVoucherNumber).toHaveBeenCalledTimes(1);
    finish();
    await expect(holder).resolves.toMatchObject({ voucher: { number: 1 } });
    await expect(later).resolves.toMatchObject({ voucher: { number: 2 } });
  });

  it("recovers with the request id a retry moved under the lock", async () => {
    const store = createMemoryStore();
    const fake = arca();
    const service = createVouchersService(
      wsfe,
      { store, environment: "test", taxId: TAX_ID },
      undefined,
      fake.wsfex
    );
    fake.behaviors.push((input) => {
      fake.useId(41);
      return {
        service: "wsfex",
        operation: "FEXAuthorize",
        kind: "authorized",
        result: "A",
        resultLevel: "header",
        results: {},
        errors: [],
        observations: [],
        cae: "75000000000000",
        voucherNumber: 7,
        reprocessed: true,
        echo: { id: input.id, salesPoint: 2, voucherType: 19, number: 7 },
      };
    });
    const before = JSON.stringify({
      ...JSON.parse(
        (await (async () => {
          await service.issue(services, { idempotencyKey: "sale-a" });
          return store.get(attemptKey("test", TAX_ID, "sale-a"));
        })()) as string
      ),
      requestId: 41,
    });
    const issuance = createExportIssuance(fake.wsfex, {
      store,
      environment: "test",
      taxId: TAX_ID,
    });
    await expect(issuance.recover("sale-a", before, {})).resolves.toMatchObject(
      {
        kind: "authorized",
        voucher: { requestId: 42 },
      }
    );
  });
});

describe("complete fiscal identity on recovery", () => {
  const unanswered = () =>
    ({
      service: "wsfex",
      operation: "FEXAuthorize",
      kind: "indeterminate",
      reason: "transport_error",
      results: {},
      errors: [],
      observations: [],
    }) satisfies WsfexAuthorizationOutcome;
  const storedAs =
    (change: (input: WsfexIssueInput) => WsfexIssueInput) =>
    (fake: ReturnType<typeof client>) =>
    (input: WsfexIssueInput) => {
      fake.approve(change(input));
      return unanswered();
    };

  it.each([
    [
      "exchange rate",
      storedAs((input) => ({ ...input, exchangeRate: "1500" })),
    ],
    [
      "line quantity and price",
      storedAs((input) => ({
        ...input,
        items: [{ ...input.items[0], quantity: 1, unitPrice: "1500" }],
      })),
    ],
    [
      "observations",
      storedAs((input) => ({ ...input, observations: "Otra operación" })),
    ],
    ["language", storedAs((input) => ({ ...input, language: 2 }))],
  ])("refuses a stored voucher with another %s", async (_field, behavior) => {
    const fake = client();
    fake.behaviors.push(behavior(fake));
    await expect(fake.service.issue(services)).resolves.toMatchObject({
      kind: "conflict",
      found: { requestId: 41 },
    });
  });

  it("refuses a stored note linked to another original", async () => {
    const fake = client();
    const invoice = await fake.service.issue(services);
    const other = await fake.service.issue(services);
    if (invoice.kind !== "authorized" || other.kind !== "authorized") {
      throw new Error("expected two authorizations");
    }
    fake.behaviors.push(
      storedAs((input) => ({
        ...input,
        associatedVouchers: [{ voucherType: 19, salesPoint: 5, number: 2 }],
      }))(fake)
    );
    await expect(
      fake.service.issueCreditNote({
        for: { salesPoint: 5, voucherType: 19, number: 1 },
        all: true,
      })
    ).resolves.toMatchObject({ kind: "conflict" });
  });

  it("accepts the same decimals however ARCA spells them", async () => {
    const fake = client();
    fake.behaviors.push(
      storedAs((input) => ({
        ...input,
        exchangeRate: "1450.500000",
        items: [{ ...input.items[0], unitPrice: "750.00", quantity: 2.0 }],
      }))(fake)
    );
    await expect(fake.service.issue(services)).resolves.toMatchObject({
      kind: "authorized",
      recoveredByMatch: true,
    });
  });

  it("answers an export summary when voucherType is only a number", async () => {
    const { service } = client();
    await service.issue(services);
    const voucherType: number = 19;
    const summary = await service.lookup({
      salesPoint: 5,
      voucherType,
      number: 1,
    });
    expect(summary).toMatchObject({
      voucherClass: "E",
      exchangeRate: "1450.5",
    });
    if (summary && "voucherClass" in summary) {
      expectTypeOf(summary.exchangeRate).toEqualTypeOf<string | undefined>();
    }
  });
});

describe("keyed replays use what was stored", () => {
  it("replays a services invoice after its payment date", async () => {
    const { service, calls } = client();
    const input: ExportIssueInput = {
      ...services,
      export: { kind: "services", paymentDate: "2026-10-03" },
    };
    const first = await service.issue(input, { idempotencyKey: "sale-1" });
    expect(first).toMatchObject({ kind: "authorized", voucher: { number: 1 } });
    // Days later, today's date is past the payment date, so deriving the
    // invoice again would fail. The replay never derives it.
    vi.setSystemTime(new Date("2026-10-06T15:00:00Z"));
    await expect(
      service.issue(input, { idempotencyKey: "sale-1" })
    ).resolves.toMatchObject({
      kind: "authorized",
      voucher: { number: 1, requestId: 41, date: "2026-10-02" },
    });
    expect(calls.issue).toHaveBeenCalledTimes(2);
  });

  it("issues a note from the input as it was when called", async () => {
    const fake = client();
    await fake.service.issue(services);
    await fake.service.issue(services);
    const note = {
      for: { salesPoint: 5, voucherType: 19 as const, number: 1 },
      items: [
        {
          description: "Ajuste",
          unit: 7,
          quantity: 1,
          unitPrice: "10",
          amount: 1000,
        },
      ],
    };
    const real = fake.calls.lookupVoucher.getMockImplementation();
    fake.calls.lookupVoucher.mockImplementationOnce((coordinates) => {
      // The caller changes its object while the original is being read.
      note.for.number = 2;
      note.items[0] = { ...note.items[0], unitPrice: "100", amount: 10_000 };
      return real?.(coordinates) as ReturnType<NonNullable<typeof real>>;
    });
    const outcome = await fake.service.issueCreditNote(note, {
      idempotencyKey: "note-1",
    });
    expect(outcome).toMatchObject({ kind: "authorized" });
    expect(fake.calls.issue.mock.calls.at(-1)?.[0]).toMatchObject({
      totalAmount: 10,
      associatedVouchers: [{ voucherType: 19, salesPoint: 5, number: 1 }],
    });
    // The reservation belongs to the input as called, not as mutated.
    await expect(
      fake.service.issueCreditNote(
        {
          for: { salesPoint: 5, voucherType: 19, number: 1 },
          items: [
            {
              description: "Ajuste",
              unit: 7,
              quantity: 1,
              unitPrice: "10",
              amount: 1000,
            },
          ],
        },
        { idempotencyKey: "note-1" }
      )
    ).resolves.toMatchObject({ kind: "authorized" });
  });
});

describe("options shared with issuance", () => {
  it("does not refresh the ticket twice when the caller already forced it", async () => {
    const { service, behaviors, calls } = client();
    behaviors.push(() => ({
      service: "wsfex",
      operation: "FEXAuthorize",
      kind: "indeterminate",
      reason: "authentication_rejected",
      results: {},
      errors: [],
      observations: [],
    }));
    await expect(
      service.issue(services, { forceRefresh: true })
    ).resolves.toMatchObject({
      kind: "indeterminate",
      lookup: { kind: "not_found" },
    });
    expect(calls.issue).toHaveBeenCalledTimes(1);
  });

  it.each(["previewCreditNote", "previewDebitNote"] as const)(
    "%s refuses a service option, like issuance",
    async (method) => {
      const { service, calls } = client();
      const preview = service[method] as (
        input: unknown,
        options: unknown
      ) => Promise<unknown>;
      await expect(
        preview(
          {
            for: { salesPoint: 5, voucherType: 19, number: 1 },
            items: [
              {
                description: "Ajuste",
                unit: 7,
                quantity: 1,
                unitPrice: "10",
                amount: 1000,
              },
            ],
          },
          { service: "wsmtxca" }
        )
      ).rejects.toMatchObject({
        name: "ArcaInputError",
        field: "options.service",
      });
      expect(calls.lookupVoucher).not.toHaveBeenCalled();
    }
  );
});

describe("voucher helpers for export types", () => {
  it.each([
    [19, "invoice"],
    [20, "debit_note"],
    [21, "credit_note"],
  ] as const)("describes type %i", (voucherType, kind) => {
    expect(describeVoucherType(voucherType)).toEqual({
      family: "export",
      voucherClass: "E",
      kind,
    });
  });

  it("computes the export date window, within the month for services", () => {
    const now = new Date("2026-10-29T15:00:00Z");
    expect(voucherDateWindow({ voucherType: 19, now })).toEqual({
      from: "2026-10-24",
      to: "2026-11-03",
    });
    expect(
      voucherDateWindow({ voucherType: 21, concept: "services", now })
    ).toEqual({ from: "2026-10-24", to: "2026-10-31" });
    expect(() =>
      voucherDateWindow({ voucherType: 19, service: "wsfe", now })
    ).toThrowError(expect.objectContaining({ field: "service" }));
  });
});
