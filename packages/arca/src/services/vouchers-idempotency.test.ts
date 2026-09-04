import { afterEach, describe, expect, it, vi } from "vitest";
import { ArcaConfigurationError } from "../errors";
import { createMemoryStore } from "../store/memory";
import { type ArcaAttemptRecord, attemptKey } from "../store/types";
import { createVouchersService } from "./vouchers";
import type { IssueOptions } from "./vouchers-types";
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
const rejected: WsfeAuthorizationOutcome = {
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
const absent: WsfeVoucherLookupResult = {
  kind: "not_found",
  service: "wsfe",
  operation: "FECompConsultar",
  errors: [],
  observations: [],
  raw: {},
};
const key = attemptKey("test", "20123456789", "sale");
function found(data = deriveWsfeInvoice(input).data): WsfeVoucherLookupResult {
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
    authorizeVoucherOutcome: vi.fn(
      async ({ data }: WsfeAuthorizeVoucherInput) => {
        normalizeWsfeVoucherInput(data);
        expect(await store.get(key)).not.toBeNull();
        return authorized;
      }
    ),
    lookupVoucher: vi.fn().mockResolvedValue(found()),
  };
  const service = createVouchersService(wsfe, {
    store,
    environment: "test",
    taxId: "20123456789",
  });
  return { store, wsfe, service };
}
function noPrivate(value: unknown) {
  if (value && typeof value === "object") {
    expect(Object.keys(value)).not.toContain("raw");
    expect(Object.keys(value)).not.toContain("sent");
    for (const child of Object.values(value)) {
      noPrivate(child);
    }
  }
}
afterEach(() => vi.useRealTimers());
describe("keyed issue", () => {
  it("requires a store and rejects invalid keys before I/O", async () => {
    const { wsfe, service } = fake();
    await expect(
      createVouchersService(wsfe).issue(input, { idempotencyKey: "sale" })
    ).rejects.toBeInstanceOf(ArcaConfigurationError);
    for (const idempotencyKey of ["", "x".repeat(256), 123]) {
      await expect(
        service.issue(input, { idempotencyKey } as IssueOptions)
      ).rejects.toMatchObject({ code: "ARCA_INPUT_INVALID_VALUE" });
    }
    expect(wsfe.getNextVoucherNumber).not.toHaveBeenCalled();
    expect(wsfe.lookupVoucher).not.toHaveBeenCalled();
    expect(wsfe.authorizeVoucherOutcome).not.toHaveBeenCalled();
  });
  it("reserves before writing and replays with one matching lookup", async () => {
    const { store, wsfe, service } = fake();
    noPrivate(await service.issue(input, { idempotencyKey: "sale" }));
    const json = await store.get(key);
    const record = JSON.parse(json ?? "null");
    expect(record).toMatchObject({
      v: 1,
      operation: "issue",
      number: 77,
      sent: deriveWsfeInvoice(input).data,
    });
    const result = await service.issue(input, { idempotencyKey: "sale" });
    expect(result).toMatchObject({
      kind: "authorized",
      recoveredByMatch: true,
      voucher: { number: 77 },
    });
    noPrivate(result);
    expect(wsfe.getNextVoucherNumber).toHaveBeenCalledTimes(1);
    expect(wsfe.authorizeVoucherOutcome).toHaveBeenCalledTimes(1);
    expect(wsfe.lookupVoucher).toHaveBeenCalledTimes(1);
    expect(await store.get(key)).toBe(json);
  });
  it.each([
    "mismatch",
    "incomplete",
    "failed",
  ])("replay %s never writes", async (mode) => {
    const { wsfe, service } = fake();
    await service.issue(input, { idempotencyKey: "sale" });
    const lookup = found();
    if (lookup.kind !== "found") {
      throw new Error("fixture");
    }
    if (mode === "mismatch") {
      lookup.voucher.totalAmount = 2;
    }
    if (mode === "incomplete") {
      lookup.voucher.cae = undefined;
    }
    if (mode === "failed") {
      wsfe.lookupVoucher.mockRejectedValue(new Error("offline"));
    } else {
      wsfe.lookupVoucher.mockResolvedValue(lookup);
    }
    const result = await service.issue(input, { idempotencyKey: "sale" });
    expect(result.kind).toBe(
      mode === "mismatch" ? "conflict" : "indeterminate"
    );
    noPrivate(result);
    expect(wsfe.authorizeVoucherOutcome).toHaveBeenCalledTimes(1);
  });
  it("retries the stored number and date after not_found across midnight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T22:00:00Z"));
    const { wsfe, service } = fake();
    const value = { ...input, date: undefined };
    await service.issue(value, { idempotencyKey: "sale" });
    const first = wsfe.authorizeVoucherOutcome.mock.calls[0][0];
    vi.setSystemTime(new Date("2026-09-05T22:00:00Z"));
    wsfe.lookupVoucher.mockResolvedValue(absent);
    expect((await service.issue(value, { idempotencyKey: "sale" })).kind).toBe(
      "authorized"
    );
    expect(wsfe.authorizeVoucherOutcome.mock.calls[1][0]).toEqual(first);
    expect(wsfe.getNextVoucherNumber).toHaveBeenCalledTimes(1);
  });
  it("mismatched input or represented taxpayer causes zero provider calls", async () => {
    const { wsfe, service } = fake();
    await service.issue(input, { idempotencyKey: "sale" });
    vi.clearAllMocks();
    await expect(
      service.issue(
        { ...input, items: [{ amount: 200 }] },
        { idempotencyKey: "sale" }
      )
    ).rejects.toMatchObject({ code: "ARCA_INPUT_IDEMPOTENCY_MISMATCH" });
    await expect(
      service.issue(input, {
        idempotencyKey: "sale",
        representedTaxId: "20987654321",
      })
    ).rejects.toMatchObject({ code: "ARCA_INPUT_IDEMPOTENCY_MISMATCH" });
    expect(wsfe.lookupVoucher).not.toHaveBeenCalled();
    expect(wsfe.getNextVoucherNumber).not.toHaveBeenCalled();
    expect(wsfe.authorizeVoucherOutcome).not.toHaveBeenCalled();
  });
  it("losing add reads the winner and never reads another number", async () => {
    const { store, wsfe, service } = fake();
    await service.issue(input, { idempotencyKey: "sale" });
    const json = await store.get(key);
    vi.spyOn(store, "get").mockResolvedValueOnce(null);
    expect((await service.issue(input, { idempotencyKey: "sale" })).kind).toBe(
      "authorized"
    );
    expect(wsfe.getNextVoucherNumber).toHaveBeenCalledTimes(2);
    expect(wsfe.authorizeVoucherOutcome).toHaveBeenCalledTimes(1);
    expect(await store.get(key)).toBe(json);
  });
  it.each([true, false])("checks 10016 once; matching=%s", async (match) => {
    const { wsfe, service } = fake();
    wsfe.authorizeVoucherOutcome.mockResolvedValue(rejected);
    wsfe.lookupVoucher.mockResolvedValue(match ? found() : absent);
    expect((await service.issue(input, { idempotencyKey: "sale" })).kind).toBe(
      match ? "authorized" : "rejected"
    );
    expect(wsfe.lookupVoucher).toHaveBeenCalledTimes(1);
    expect(wsfe.authorizeVoucherOutcome).toHaveBeenCalledTimes(1);
  });
  it("recovers a concurrent authorization rejected with 10016", async () => {
    const { store, wsfe, service } = fake();
    let writes = 0;
    let release: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    wsfe.authorizeVoucherOutcome.mockImplementation(async () => {
      writes++;
      if (writes === 1) {
        await waiting;
        return authorized;
      }
      release();
      return rejected;
    });
    wsfe.lookupVoucher.mockResolvedValueOnce(absent).mockResolvedValue(found());
    const outcomes = await Promise.all([
      service.issue(input, { idempotencyKey: "sale" }),
      service.issue(input, { idempotencyKey: "sale" }),
    ]);
    expect(outcomes.map((value) => value.kind)).toEqual([
      "authorized",
      "authorized",
    ]);
    expect(wsfe.authorizeVoucherOutcome).toHaveBeenCalledTimes(2);
    expect(wsfe.lookupVoucher).toHaveBeenCalledTimes(2);
    expect(JSON.parse((await store.get(key)) ?? "null").number).toBe(77);
  });
  it("scopes records by environment and exposes requested evidence only", async () => {
    const { store, wsfe, service } = fake();
    await service.issue(input, { idempotencyKey: "sale" });
    const production = createVouchersService(wsfe, {
      store,
      environment: "production",
      taxId: "20123456789",
    });
    const value = await production.issue(input, {
      idempotencyKey: "sale",
      include: { raw: true, exactInput: true },
    });
    expect(value).toHaveProperty("sent");
    expect(value).toHaveProperty("authorization.raw");
    expect(
      await store.get(attemptKey("production", "20123456789", "sale"))
    ).not.toBeNull();
  });
  it("does not authorize corrupted records or after store failures", async () => {
    const { store, wsfe, service } = fake();
    await store.set(key, "broken");
    await expect(
      service.issue(input, { idempotencyKey: "sale" })
    ).rejects.toThrow(ArcaConfigurationError);
    await store.delete?.(key);
    vi.spyOn(store, "add").mockRejectedValue(new Error("driver"));
    await expect(
      service.issue(input, { idempotencyKey: "sale" })
    ).rejects.toThrow(ArcaConfigurationError);
    expect(wsfe.authorizeVoucherOutcome).not.toHaveBeenCalled();
  });
  it("replay uses stored input even if the reserved date differs", async () => {
    const { store, wsfe, service } = fake();
    await service.issue(input, { idempotencyKey: "sale" });
    const record = JSON.parse(
      (await store.get(key)) ?? "null"
    ) as ArcaAttemptRecord;
    record.sent.voucherDate = "20260903";
    await store.set(key, JSON.stringify(record));
    wsfe.lookupVoucher.mockResolvedValue(absent);
    await service.issue(input, { idempotencyKey: "sale" });
    expect(wsfe.authorizeVoucherOutcome.mock.calls[1][0].data.voucherDate).toBe(
      "20260903"
    );
  });
});
