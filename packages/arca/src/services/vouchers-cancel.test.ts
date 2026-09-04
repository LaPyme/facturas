import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "../store/memory";
import { createVouchersService } from "./vouchers";
import type { IssueOptions } from "./vouchers-types";
import {
  normalizeWsfeVoucherInput,
  type WsfeAuthorizationOutcome,
  type WsfeAuthorizeVoucherInput,
  type WsfeDateInput,
  type WsfeVoucherInput,
  type WsfeVoucherLookupResult,
} from "./wsfe";
import { deriveWsfeInvoice } from "./wsfe-derive";

const data = deriveWsfeInvoice({
  issuer: "monotributo",
  salesPoint: 1,
  date: "20260904",
  to: { condition: "consumidor_final" },
  items: [{ amount: 100 }],
}).data;
const target = { salesPoint: 1, voucherType: 11, number: 1 };
const options = {
  date: "20260905" as WsfeDateInput,
  idempotencyKey: "cancel-sale",
};
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
function fake() {
  const store = createMemoryStore();
  const calls: string[] = [];
  let note: WsfeVoucherInput | undefined;
  const wsfe = {
    getNextVoucherNumber: vi.fn(() => {
      calls.push("next");
      return Promise.resolve(9);
    }),
    authorizeVoucherOutcome: vi.fn(
      ({ data: sent }: WsfeAuthorizeVoucherInput) => {
        normalizeWsfeVoucherInput(sent);
        note = sent;
        calls.push("authorize");
        return Promise.resolve(authorized);
      }
    ),
    lookupVoucher: vi.fn(({ voucherType }: { voucherType: number }) => {
      calls.push("lookup");
      return Promise.resolve(
        voucherType === 11 ? found() : note ? found(note, 9) : absent
      );
    }),
  };
  return {
    wsfe,
    store,
    calls,
    service: createVouchersService(wsfe, {
      store,
      environment: "test",
      taxId: "20123456789",
    }),
  };
}
describe("cancel orchestration", () => {
  it.each([
    false,
    true,
  ])("looks up original before numbering; keyed=%s", async (keyed) => {
    const { service, calls } = fake();
    const result = await service.cancel(target, {
      date: options.date,
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
  it("replays with only one lookup of the reserved note", async () => {
    const { service, wsfe, calls } = fake();
    await service.cancel(target, options);
    calls.length = 0;
    expect(await service.cancel(target, options)).toMatchObject({
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
    await expect(service.cancel(target, options)).rejects.toThrow(
      "original voucher not found"
    );
    expect(wsfe.getNextVoucherNumber).not.toHaveBeenCalled();
    expect(wsfe.authorizeVoucherOutcome).not.toHaveBeenCalled();
  });
  it("validates locally and requires a store before original lookup", async () => {
    const { service, wsfe } = fake();
    for (const value of [
      { ...target, number: 0 },
      { ...target, salesPoint: Number.NaN },
      { ...target, voucherType: 13 },
    ]) {
      await expect(service.cancel(value, options)).rejects.toMatchObject({
        code: "ARCA_INPUT_INVALID_VALUE",
      });
    }
    await expect(
      createVouchersService(wsfe).cancel(target, options)
    ).rejects.toMatchObject({ code: "ARCA_CONFIGURATION_ERROR" });
    await expect(
      service.cancel(target, { idempotencyKey: 1 } as unknown as IssueOptions)
    ).rejects.toMatchObject({ code: "ARCA_INPUT_INVALID_VALUE" });
    expect(wsfe.lookupVoucher).not.toHaveBeenCalled();
  });
  it("mismatched target, date, or operation fails without provider calls", async () => {
    const { service, wsfe } = fake();
    await service.cancel(target, options);
    vi.clearAllMocks();
    await expect(
      service.cancel({ ...target, number: 2 }, options)
    ).rejects.toMatchObject({ code: "ARCA_INPUT_IDEMPOTENCY_MISMATCH" });
    await expect(
      service.cancel(target, { ...options, date: "20260906" })
    ).rejects.toMatchObject({ code: "ARCA_INPUT_IDEMPOTENCY_MISMATCH" });
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
    expect(wsfe.authorizeVoucherOutcome).not.toHaveBeenCalled();
  });
  it.each([
    "incomplete",
    "conflict",
    "failed",
    "not_found",
  ])("replay %s preserves the I/O bound", async (mode) => {
    const { service, wsfe } = fake();
    await service.cancel(target, options);
    const sent = wsfe.authorizeVoucherOutcome.mock.calls[0][0].data;
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
    const result = await service.cancel(target, options);
    expect(result.kind).toBe(
      mode === "not_found"
        ? "authorized"
        : mode === "conflict"
          ? "conflict"
          : "indeterminate"
    );
    expect(wsfe.getNextVoucherNumber).toHaveBeenCalledTimes(1);
    expect(wsfe.authorizeVoucherOutcome).toHaveBeenCalledTimes(
      mode === "not_found" ? 2 : 1
    );
  });
  it("recovers indeterminate writes by matching associations", async () => {
    const { service, wsfe } = fake();
    wsfe.authorizeVoucherOutcome.mockImplementation(({ data: sent }) => {
      wsfe.lookupVoucher.mockResolvedValue(found(sent, 9));
      return Promise.resolve({
        ...base,
        kind: "indeterminate",
        reason: "transport_error",
      });
    });
    expect(await service.cancel(target, options)).toMatchObject({
      kind: "authorized",
      recoveredByMatch: true,
    });
    expect(wsfe.lookupVoucher).toHaveBeenCalledTimes(2);
  });
});

it("cancel recovers concurrent keyed writes through 10016", async () => {
  const { service, wsfe } = fake();
  let writes = 0;
  let note: WsfeVoucherInput | undefined;
  let release: () => void = () => undefined;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  wsfe.lookupVoucher.mockImplementation(({ voucherType }) =>
    Promise.resolve(
      voucherType === 11
        ? found()
        : writes < 2 || !note
          ? absent
          : found(note, 9)
    )
  );
  wsfe.authorizeVoucherOutcome.mockImplementation(async ({ data: sent }) => {
    note = sent;
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
    service.cancel(target, options),
    service.cancel(target, options),
  ]);
  expect(results.map((result) => result.kind)).toEqual([
    "authorized",
    "authorized",
  ]);
  expect(wsfe.authorizeVoucherOutcome).toHaveBeenCalledTimes(2);
});
