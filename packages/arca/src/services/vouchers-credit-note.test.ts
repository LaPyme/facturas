import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "../store/memory";
import {
  type ArcaAttemptRecord,
  type ArcaStore,
  attemptKey,
} from "../store/types";
import { createVouchersService } from "./vouchers";
import type { IssueOptions } from "./vouchers-types";
import {
  normalizeWsfeVoucherInput,
  type WsfeAuthorizationOutcome,
  type WsfeAuthorizeVoucherInput,
  type WsfeVoucherInput,
  type WsfeVoucherLookupResult,
} from "./wsfe";
import type { CreditNoteInput } from "./wsfe-credit-note";
import { deriveWsfeInvoice } from "./wsfe-derive";

const data = deriveWsfeInvoice({
  issuer: "monotributo",
  salesPoint: 1,
  date: "20260904",
  to: { condition: "consumidor_final" },
  items: [{ amount: 100 }],
}).data;
const target = { salesPoint: 1, voucherType: 11, number: 1 };
const note: CreditNoteInput = { for: target, all: true, date: "20260905" };
const partial: CreditNoteInput = {
  for: target,
  items: [{ amount: 40 }],
  date: "20260905",
};
const options = { idempotencyKey: "credit-note-sale" };
const key = attemptKey("test", "20123456789", options.idempotencyKey);
const base = {
  service: "wsfe" as const,
  operation: "FECAESolicitar",
  results: {},
  errors: [],
  observations: [],
};
const authorized: WsfeAuthorizationOutcome = {
  ...base,
  kind: "authorized",
  result: "A",
  resultLevel: "detail",
  cae: "123",
  caeExpiry: "20260915",
  voucherNumber: 9,
};
const absent: WsfeVoucherLookupResult = {
  kind: "not_found",
  service: "wsfe",
  operation: "FECompConsultar",
  errors: [],
  observations: [],
  raw: {},
};
function found(sent = data, number = 1): WsfeVoucherLookupResult {
  return {
    kind: "found",
    service: "wsfe",
    operation: "FECompConsultar",
    observations: [],
    raw: {},
    voucher: {
      ...sent,
      documentNumber: String(sent.documentNumber),
      exchangeRate: Number(sent.exchangeRate),
      voucherNumber: number,
      result: "A",
      cae: "123",
      caeExpiry: "20260915",
      raw: {},
    },
  };
}
/** A custom store without withLock: no sequence lock, no barrier, no claim. */
function withoutLock(store: ArcaStore): ArcaStore {
  return {
    get: (key) => store.get(key),
    set: (key, value) => store.set(key, value),
    add: (key, value) => store.add(key, value),
    delete: (key) => store.delete?.(key) ?? Promise.resolve(),
  };
}
function fake({ coordinated = true } = {}) {
  const store = createMemoryStore();
  const calls: string[] = [];
  let written: WsfeVoucherInput | undefined;
  const wsfe = {
    getNextVoucherNumber: vi.fn(() => {
      calls.push("next");
      return Promise.resolve(9);
    }),
    issue: vi.fn(({ data: sent }: WsfeAuthorizeVoucherInput) => {
      normalizeWsfeVoucherInput(sent);
      written = sent;
      calls.push("authorize");
      return Promise.resolve(authorized);
    }),
    lookupVoucher: vi.fn(({ voucherType }: { voucherType: number }) => {
      calls.push("lookup");
      return Promise.resolve(
        voucherType === 11 ? found() : written ? found(written, 9) : absent
      );
    }),
  };
  return {
    wsfe,
    store,
    calls,
    service: createVouchersService(wsfe, {
      store: coordinated ? store : withoutLock(store),
      environment: "test",
      taxId: "20123456789",
    }),
  };
}

describe("credit note orchestration", () => {
  it.each([
    false,
    true,
  ])("looks up original before numbering; keyed=%s", async (keyed) => {
    const { service, calls } = fake();
    const result = await service.issueCreditNote(note, {
      ...(keyed ? { idempotencyKey: options.idempotencyKey } : {}),
      include: { exactInput: true },
    });
    expect(calls).toEqual(["lookup", "next", "authorize"]);
    expect(result).toMatchObject({
      kind: "authorized",
      voucher: { voucherType: 13, voucherClass: "C", number: 9 },
      sent: { associatedVouchers: [{ type: 11, number: 1 }] },
    });
  });
  it("credits chosen items with the same single-write sequence", async () => {
    const { service, calls, wsfe } = fake();
    const result = await service.issueCreditNote(partial, {
      ...options,
      include: { exactInput: true },
    });
    expect(calls).toEqual(["lookup", "next", "authorize"]);
    expect(result).toMatchObject({
      kind: "authorized",
      voucher: {
        voucherType: 13,
        voucherClass: "C",
        number: 9,
        amounts: { computedTotal: 40, sentTotal: 40, vatAdjustment: 0 },
      },
      sent: {
        totalAmount: 0.4,
        netAmount: 0.4,
        associatedVouchers: [{ type: 11, salesPoint: 1, number: 1 }],
      },
    });
    expect(wsfe.issue.mock.calls[0][0].data.totalAmount).toBe(0.4);
  });
  it("returns the normalized original from linked note previews", async () => {
    const { service, calls } = fake();
    const credit = await service.previewCreditNote(partial);
    expect(calls).toEqual(["lookup"]);
    expect(credit.original).toMatchObject({
      number: 1,
      salesPoint: 1,
      voucherType: 11,
      date: "20260904",
      totalAmount: 1,
      cae: "123",
      caeExpiry: "20260915",
    });
    expect(credit.original).not.toHaveProperty("raw");

    calls.length = 0;
    const debit = await service.previewDebitNote(partial);
    expect(calls).toEqual(["lookup"]);
    expect(debit.original).toEqual(credit.original);
  });
  it.each([
    ["a fractional", 100.5],
    ["a non-finite", Number.NaN],
  ] as const)("rejects %s reviewed total without authorizing", async (_case, total) => {
    const reviewed = {
      for: target,
      date: "20260905",
      amounts: { net: 40, vat: 0 },
      total,
    } as CreditNoteInput;
    for (const preview of [true, false]) {
      const { service, wsfe } = fake();
      await expect(
        preview
          ? service.previewCreditNote(reviewed)
          : service.issueCreditNote(reviewed)
      ).rejects.toMatchObject({
        name: "ArcaInputError",
        code: "ARCA_INPUT_INVALID_AMOUNT",
        field: "total",
      });
      expect(wsfe.getNextVoucherNumber).not.toHaveBeenCalled();
      expect(wsfe.issue).not.toHaveBeenCalled();
    }
  });
  it.each([
    ["all", note],
    ["items", partial],
  ] as const)("records operation creditNote for the %s mode", async (_mode, input) => {
    const { service, store } = fake();
    await service.issueCreditNote(input, options);
    const record = JSON.parse((await store.get(key)) ?? "null");
    expect(record).toMatchObject({
      v: 1,
      operation: "creditNote",
      number: 9,
      salesPoint: 1,
      voucherType: 13,
    });
  });
  it("replays with only one lookup of the reserved note", async () => {
    const { service, wsfe, calls } = fake();
    await service.issueCreditNote(note, options);
    calls.length = 0;
    expect(await service.issueCreditNote(note, options)).toMatchObject({
      kind: "authorized",
      recoveredByMatch: true,
      voucher: { number: 9 },
    });
    expect(calls).toEqual(["lookup"]);
    expect(wsfe.lookupVoucher.mock.lastCall?.[0]).toMatchObject({
      voucherType: 13,
      number: 9,
    });
  });
  it("not_found original throws before numbering and writes", async () => {
    const { service, wsfe } = fake();
    wsfe.lookupVoucher.mockResolvedValue(absent);
    await expect(service.issueCreditNote(note, options)).rejects.toThrow(
      "original voucher not found"
    );
    expect(wsfe.getNextVoucherNumber).not.toHaveBeenCalled();
    expect(wsfe.issue).not.toHaveBeenCalled();
  });
  it("validates locally and requires a store before original lookup", async () => {
    const { service, wsfe } = fake();
    for (const value of [
      { ...note, for: { ...target, number: 0 } },
      { ...note, for: { ...target, salesPoint: Number.NaN } },
      { ...note, for: { ...target, voucherType: 13 } },
      { ...note, salesPoint: 0 },
      { ...note, date: "20260230" },
    ]) {
      await expect(
        service.issueCreditNote(value as CreditNoteInput, options)
      ).rejects.toMatchObject({ code: expect.stringContaining("ARCA_INPUT_") });
    }
    await expect(
      createVouchersService(wsfe).issueCreditNote(note, options)
    ).rejects.toMatchObject({ code: "ARCA_CONFIGURATION_ERROR" });
    await expect(
      service.issueCreditNote(note, {
        idempotencyKey: 1,
      } as unknown as IssueOptions)
    ).rejects.toMatchObject({ code: "ARCA_INPUT_INVALID_VALUE" });
    expect(wsfe.lookupVoucher).not.toHaveBeenCalled();
  });
  it.each([
    ["neither mode", { for: target }],
    ["both modes", { for: target, all: true, items: [{ amount: 40 }] }],
    ["all: false", { for: target, all: false }],
    ["all with a total", { for: target, all: true, total: 40 }],
    [
      "a credit note target",
      { for: { ...target, voucherType: 13 }, all: true },
    ],
    [
      "an A credit note target",
      { for: { ...target, voucherType: 3 }, all: true },
    ],
    [
      "a B credit note target",
      { for: { ...target, voucherType: 8 }, all: true },
    ],
    ["an associated period", { for: target, all: true, associatedPeriod: {} }],
    ["a receiver", { for: target, all: true, to: { condition: "exento" } }],
    ["a currency", { for: target, all: true, currency: "USD" }],
    ["an issuer", { for: target, all: true, issuer: "monotributo" }],
    ["an unknown target field", { for: { ...target, cuit: "20123456789" } }],
    ["items that are not an array", { for: target, items: 5 }],
    ["an empty target", { for: null, all: true }],
  ])("rejects %s before any I/O", async (_case, input) => {
    const { service, wsfe, store } = fake();
    await expect(
      service.issueCreditNote(input as CreditNoteInput, options)
    ).rejects.toMatchObject({
      name: "ArcaInputError",
      message: expect.stringContaining("issueCreditNote"),
    });
    expect(wsfe.lookupVoucher).not.toHaveBeenCalled();
    expect(wsfe.getNextVoucherNumber).not.toHaveBeenCalled();
    expect(wsfe.issue).not.toHaveBeenCalled();
    expect(await store.get(key)).toBeNull();
  });
  it("never mutates the note after the caller's array changes", async () => {
    const { service, wsfe } = fake();
    const items = [{ amount: 40 }];
    const running = service.issueCreditNote({ for: target, items });
    items[0].amount = 100;
    await running;
    expect(wsfe.issue.mock.calls[0][0].data.totalAmount).toBe(0.4);
  });
  it("mismatched target, date, mode or operation fails without provider calls", async () => {
    const { service, wsfe } = fake();
    await service.issueCreditNote(note, options);
    vi.clearAllMocks();
    for (const value of [
      { ...note, for: { ...target, number: 2 } },
      { ...note, date: "20260906" },
      partial,
    ] as CreditNoteInput[]) {
      await expect(
        service.issueCreditNote(value, options)
      ).rejects.toMatchObject({ code: "ARCA_INPUT_IDEMPOTENCY_MISMATCH" });
    }
    await expect(
      service.issue(
        {
          issuer: "monotributo",
          salesPoint: 1,
          to: { condition: "consumidor_final" },
          items: [{ amount: 100 }],
        },
        { idempotencyKey: options.idempotencyKey }
      )
    ).rejects.toMatchObject({ code: "ARCA_INPUT_IDEMPOTENCY_MISMATCH" });
    expect(wsfe.lookupVoucher).not.toHaveBeenCalled();
    expect(wsfe.issue).not.toHaveBeenCalled();
  });
  it("replays items against a key reserved with items", async () => {
    const { service, wsfe } = fake();
    await service.issueCreditNote(partial, options);
    vi.clearAllMocks();
    await expect(
      service.issueCreditNote({ ...partial, items: [{ amount: 41 }] }, options)
    ).rejects.toMatchObject({ code: "ARCA_INPUT_IDEMPOTENCY_MISMATCH" });
    expect(wsfe.issue).not.toHaveBeenCalled();
  });
  it("rejects a 0.9 cancel reservation as an invalid structure", async () => {
    const { service, store, wsfe } = fake();
    await service.issueCreditNote(note, options);
    const record = JSON.parse(
      (await store.get(key)) ?? "null"
    ) as ArcaAttemptRecord;
    await store.set(
      key,
      JSON.stringify({ ...record, operation: "cancel" as const })
    );
    vi.clearAllMocks();
    await expect(service.issueCreditNote(note, options)).rejects.toMatchObject({
      code: "ARCA_CONFIGURATION_ERROR",
    });
    expect(wsfe.issue).not.toHaveBeenCalled();
  });
  it.each([
    "incomplete",
    "conflict",
    "failed",
    "not_found",
  ])("replay %s preserves the I/O bound", async (mode) => {
    const { service, wsfe } = fake();
    await service.issueCreditNote(note, options);
    const sent = wsfe.issue.mock.calls[0][0].data;
    const lookup = found(sent, 9);
    if (lookup.kind !== "found") {
      throw new Error("fixture");
    }
    if (mode === "incomplete") {
      lookup.voucher.associatedVouchers = undefined;
    }
    if (mode === "conflict") {
      lookup.voucher.associatedVouchers = [
        { type: 11, salesPoint: 1, number: 2 },
      ];
    }
    if (mode === "failed") {
      wsfe.lookupVoucher.mockRejectedValue(new Error("offline"));
    } else {
      wsfe.lookupVoucher.mockResolvedValue(
        mode === "not_found" ? absent : lookup
      );
    }
    const result = await service.issueCreditNote(note, options);
    expect(result.kind).toBe(
      mode === "not_found"
        ? "authorized"
        : mode === "conflict"
          ? "conflict"
          : "indeterminate"
    );
    expect(wsfe.getNextVoucherNumber).toHaveBeenCalledTimes(1);
    expect(wsfe.issue).toHaveBeenCalledTimes(mode === "not_found" ? 2 : 1);
  });
  it("recovers indeterminate writes by matching associations", async () => {
    const { service, wsfe } = fake();
    wsfe.issue.mockImplementation(({ data: sent }) => {
      wsfe.lookupVoucher.mockResolvedValue(found(sent, 9));
      return Promise.resolve({
        ...base,
        kind: "indeterminate",
        reason: "transport_error",
      });
    });
    expect(await service.issueCreditNote(note, options)).toMatchObject({
      kind: "authorized",
      recoveredByMatch: true,
    });
    expect(wsfe.lookupVoucher).toHaveBeenCalledTimes(2);
  });
});

it("issueCreditNote recovers concurrent keyed writes through 10016 without withLock", async () => {
  const { service, wsfe } = fake({ coordinated: false });
  let writes = 0;
  let written: WsfeVoucherInput | undefined;
  let release: () => void = () => undefined;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  wsfe.lookupVoucher.mockImplementation(({ voucherType }) =>
    Promise.resolve(
      voucherType === 11
        ? found()
        : writes < 2 || !written
          ? absent
          : found(written, 9)
    )
  );
  wsfe.issue.mockImplementation(async ({ data: sent }) => {
    written = sent;
    writes++;
    if (writes === 1) {
      await waiting;
      return authorized;
    }
    release();
    return {
      ...base,
      kind: "rejected",
      result: "R",
      resultLevel: "detail",
      errors: [
        {
          service: "wsfe",
          operation: "FECAESolicitar",
          source: "error",
          category: "business",
          code: "10016",
          message: "number used",
        },
      ],
    };
  });
  const results = await Promise.all([
    service.issueCreditNote(note, options),
    service.issueCreditNote(note, options),
  ]);
  expect(results.map((result) => result.kind)).toEqual([
    "authorized",
    "authorized",
  ]);
  expect(wsfe.issue).toHaveBeenCalledTimes(2);
});
