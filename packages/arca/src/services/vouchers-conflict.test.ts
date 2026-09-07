import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "../store/memory";
import { attemptKey, settledKey } from "../store/types";
import { createVouchersService } from "./vouchers";
import {
  normalizeWsfeVoucherInput,
  type WsfeAuthorizationOutcome,
  type WsfeAuthorizeVoucherInput,
  type WsfeVoucherLookupResult,
} from "./wsfe";
import { deriveWsfeInvoice, type IssueInput } from "./wsfe-derive";

const input: IssueInput = {
  issuer: "monotributo",
  salesPoint: 1,
  to: { condition: "consumidor_final" },
  items: [{ amount: 100 }],
  date: "20260904",
};
const base = {
  service: "wsfe" as const,
  operation: "FECAESolicitar",
  results: {},
  errors: [],
  observations: [],
  raw: { private: true },
};
const authorized: WsfeAuthorizationOutcome = {
  ...base,
  kind: "authorized",
  result: "A",
  resultLevel: "detail",
  cae: "123",
  caeExpiry: "20260914",
  voucherNumber: 77,
};
const rejected10016: WsfeAuthorizationOutcome = {
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
const uncertain: WsfeAuthorizationOutcome = {
  ...base,
  kind: "indeterminate",
  reason: "transport_error",
};
const absent: WsfeVoucherLookupResult = {
  kind: "not_found",
  service: "wsfe",
  operation: "FECompConsultar",
  errors: [],
  observations: [],
  raw: {},
};
/** The voucher ARCA holds at number 77: identical fiscal data, another sale. */
function found(): WsfeVoucherLookupResult {
  const data = deriveWsfeInvoice(input).data;
  return {
    kind: "found",
    service: "wsfe",
    operation: "FECompConsultar",
    observations: [],
    raw: { private: true },
    voucher: {
      ...data,
      exchangeRate: Number(data.exchangeRate),
      documentNumber: String(data.documentNumber),
      voucherNumber: 77,
      result: "A",
      cae: "123",
      caeExpiry: "20260914",
      raw: {},
    },
  };
}
function fake() {
  const store = createMemoryStore();
  const wsfe = {
    getNextVoucherNumber: vi.fn().mockResolvedValue(77),
    issue: vi.fn(({ data }: WsfeAuthorizeVoucherInput) => {
      normalizeWsfeVoucherInput(data);
      return Promise.resolve(authorized);
    }),
    lookupVoucher: vi.fn().mockResolvedValue(found()),
  };
  const service = createVouchersService(wsfe, {
    store,
    environment: "test",
    taxId: "20123456789",
  });
  return { store, wsfe, service };
}

describe("durable conflict", () => {
  it("never authorizes two keys with identical fiscal data on one number", async () => {
    const { wsfe, service } = fake();
    expect(
      (await service.issue(input, { idempotencyKey: "sale-1" })).kind
    ).toBe("authorized");
    // The second sale reads the same stale number and loses the race at ARCA.
    wsfe.issue.mockResolvedValue(rejected10016);
    const outcome = await service.issue(input, { idempotencyKey: "sale-2" });
    expect(outcome).toMatchObject({
      kind: "conflict",
      attempted: { salesPoint: 1, voucherType: 11, number: 77 },
      found: { number: 77 },
    });
    expect(wsfe.lookupVoucher).toHaveBeenCalledTimes(1);
    expect(wsfe.issue).toHaveBeenCalledTimes(2);
  });
  it("records the conflict and repeats it without a provider call", async () => {
    const { store, wsfe, service } = fake();
    wsfe.issue.mockResolvedValue(rejected10016);
    expect((await service.issue(input, { idempotencyKey: "sale" })).kind).toBe(
      "conflict"
    );
    const record = JSON.parse(
      (await store.get(settledKey("test", "20123456789", "sale"))) ?? "null"
    );
    expect(record).toMatchObject({
      v: 1,
      kind: "conflict",
      number: 77,
      found: { number: 77 },
    });
    expect(record.found).not.toHaveProperty("raw");
    expect(typeof record.settledAt).toBe("string");
    vi.clearAllMocks();
    const retry = await service.issue(input, { idempotencyKey: "sale" });
    expect(retry).toMatchObject({ kind: "conflict", found: { number: 77 } });
    const recovered = await service.recover("sale");
    expect(recovered).toMatchObject({
      kind: "conflict",
      found: { number: 77 },
    });
    expect(wsfe.getNextVoucherNumber).not.toHaveBeenCalled();
    expect(wsfe.issue).not.toHaveBeenCalled();
    expect(wsfe.lookupVoucher).not.toHaveBeenCalled();
  });
  it("rejects a fresh 10016 when the number holds no voucher", async () => {
    const { store, wsfe, service } = fake();
    wsfe.issue.mockResolvedValue(rejected10016);
    wsfe.lookupVoucher.mockResolvedValue(absent);
    expect((await service.issue(input, { idempotencyKey: "sale" })).kind).toBe(
      "rejected"
    );
    expect(
      await store.get(settledKey("test", "20123456789", "sale"))
    ).toBeNull();
    expect(wsfe.issue).toHaveBeenCalledTimes(1);
    expect(wsfe.lookupVoucher).toHaveBeenCalledTimes(1);
  });
  it("recovers a lost response on a pre-existing reservation by identity", async () => {
    const { store, wsfe, service } = fake();
    wsfe.issue.mockResolvedValue(uncertain);
    wsfe.lookupVoucher.mockRejectedValueOnce(new Error("offline"));
    expect((await service.issue(input, { idempotencyKey: "sale" })).kind).toBe(
      "indeterminate"
    );
    expect(
      await store.get(attemptKey("test", "20123456789", "sale"))
    ).not.toBeNull();
    const retry = await service.issue(input, { idempotencyKey: "sale" });
    expect(retry).toMatchObject({
      kind: "authorized",
      recoveredByMatch: true,
      voucher: { number: 77 },
    });
  });
  it("keeps the identity match for a 10016 on a pre-existing reservation", async () => {
    const { wsfe, service } = fake();
    wsfe.issue.mockResolvedValue(uncertain);
    wsfe.lookupVoucher.mockRejectedValueOnce(new Error("offline"));
    await service.issue(input, { idempotencyKey: "sale" });
    // The replay finds nothing, writes again, and ARCA answers 10016: the
    // voucher at the reserved number can still be this key's own earlier write.
    wsfe.issue.mockResolvedValue(rejected10016);
    wsfe.lookupVoucher.mockResolvedValueOnce(absent).mockResolvedValue(found());
    expect(
      await service.issue(input, { idempotencyKey: "sale" })
    ).toMatchObject({
      kind: "authorized",
      recoveredByMatch: true,
      voucher: { number: 77 },
    });
  });
  it("resolves concurrent calls with one key to one reservation and one outcome", async () => {
    const { store, wsfe, service } = fake();
    const outcomes = await Promise.all([
      service.issue(input, { idempotencyKey: "sale" }),
      service.issue(input, { idempotencyKey: "sale" }),
    ]);
    expect(outcomes.map((outcome) => outcome.kind)).toEqual([
      "authorized",
      "authorized",
    ]);
    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({ voucher: { number: 77 } });
    }
    expect(
      JSON.parse(
        (await store.get(attemptKey("test", "20123456789", "sale"))) ?? "null"
      ).number
    ).toBe(77);
    expect(
      wsfe.issue.mock.calls.every(([call]) => call.voucherNumber === 77)
    ).toBe(true);
  });
});
