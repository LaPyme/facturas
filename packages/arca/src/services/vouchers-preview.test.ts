import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createArcaClient } from "../client";
import {
  ARCA_ISSUER_CONDITION_IDS,
  ARCA_RECEIVER_CONDITION_IDS,
  type IssuerCondition,
  type ReceiverCondition,
} from "../constants";
import type { ArcaStore } from "../store/types";
import { createVouchersService } from "./vouchers";
import {
  normalizeWsfeVoucherInput,
  type WsfeAuthorizationOutcome,
  type WsfeIssueInput,
} from "./wsfe";
import type { IssueInput } from "./wsfe-derive";

// The fixtures are dated around 2026-09-04, and ARCA only accepts a voucher
// dated near the day it is sent.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-05T15:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const input: IssueInput = {
  issuer: "responsable_inscripto",
  salesPoint: 1,
  to: { condition: "consumidor_final" },
  items: [{ gross: 12_100, vat: 21 }],
  date: "20260904",
};
const authorized: WsfeAuthorizationOutcome = {
  kind: "authorized",
  service: "wsfe",
  operation: "FECAESolicitar",
  results: {},
  errors: [],
  observations: [],
  result: "A",
  resultLevel: "detail",
  cae: "74123456789012",
  caeExpiry: "20260914",
  voucherNumber: 77,
};
function fake() {
  const wsfe = {
    getNextVoucherNumber: vi.fn().mockResolvedValue(77),
    issue: vi.fn(({ data }: WsfeIssueInput) => {
      normalizeWsfeVoucherInput(data);
      return Promise.resolve(authorized);
    }),
    lookupVoucher: vi.fn(),
  };
  // A store is configured so preview() can be proved not to reach it either.
  const store = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    add: vi.fn().mockResolvedValue(true),
  } satisfies ArcaStore;
  return {
    wsfe,
    store,
    service: createVouchersService(wsfe, {
      store,
      environment: "test",
      taxId: "20123456789",
    }),
  };
}
function expectNoProviderCalls({
  wsfe,
  store,
}: Pick<ReturnType<typeof fake>, "store" | "wsfe">) {
  for (const call of [...Object.values(wsfe), ...Object.values(store)]) {
    expect(call).not.toHaveBeenCalled();
  }
}
function thrown(run: () => unknown): Record<string, unknown> {
  try {
    run();
  } catch (error) {
    const { name, code, field, expected } = error as Error & {
      code?: string;
      field?: string;
      expected?: string;
    };
    return { name, code, field, expected, message: (error as Error).message };
  }
  throw new Error("Expected preview to throw");
}
async function rejected(
  run: () => Promise<unknown>
): Promise<Record<string, unknown>> {
  return await run().then(
    () => {
      throw new Error("Expected issue to reject");
    },
    (error: unknown) =>
      thrown(() => {
        throw error;
      })
  );
}

describe("vouchers.preview", () => {
  it("wires the high-level API on the client", () => {
    expect(
      createArcaClient({
        taxId: "20123456789",
        certificatePem:
          "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----",
        privateKeyPem:
          "-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----",
        environment: "test",
      }).preview
    ).toBeTypeOf("function");
  });
  it("returns the request synchronously without touching the provider", () => {
    const fakes = fake();
    const { service } = fakes;
    const preview = service.preview(input, {
      representedTaxId: "20304050607",
    });
    expect(preview).not.toBeInstanceOf(Promise);
    expect(preview).toMatchObject({
      voucherClass: "B",
      voucherType: 6,
      date: "2026-09-04",
      header: {
        concept: 1,
        documentType: 99,
        documentNumber: "0",
        receiverVatConditionId: 5,
        currencyId: "PES",
        exchangeRate: "1",
      },
      amounts: { computedTotal: 12_100, sentTotal: 12_100, vatAdjustment: 0 },
      request: { salesPoint: 1, voucherType: 6, voucherDate: "20260904" },
    });
    expect(preview.header).not.toHaveProperty("serviceStartDate");
    expect(preview.header).not.toHaveProperty("paymentDueDate");
    expect(preview.request).not.toHaveProperty("voucherNumber");
    expectNoProviderCalls(fakes);
  });
  it("matches what issue() sends for every issuer and receiver pair", async () => {
    for (const issuer of Object.keys(
      ARCA_ISSUER_CONDITION_IDS
    ) as IssuerCondition[]) {
      for (const condition of Object.keys(
        ARCA_RECEIVER_CONDITION_IDS
      ) as ReceiverCondition[]) {
        const pair = {
          ...input,
          issuer,
          to: { condition, cuit: "20123456789" },
          items:
            issuer === "responsable_inscripto"
              ? [{ net: 10_000, vat: 21 }]
              : [{ amount: 10_000 }],
        } as IssueInput;
        const { service, wsfe } = fake();
        const preview = service.preview(pair);
        const result = await service.issue(pair);
        expect(wsfe.issue).toHaveBeenCalledExactlyOnceWith({
          representedTaxId: undefined,
          forceRefresh: undefined,
          data: preview.request,
          voucherNumber: 77,
        });
        if (result.kind !== "authorized") {
          throw new Error("Expected authorization");
        }
        expect(result.voucher.voucherClass).toBe(preview.voucherClass);
        expect(result.voucher.voucherType).toBe(preview.voucherType);
        expect(result.voucher.date).toBe(preview.date);
        expect(result.voucher.header).toEqual(preview.header);
        expect(result.voucher.amounts).toEqual(preview.amounts);
      }
    }
  });
  it("normalizes service dates and an exact foreign exchange rate", () => {
    const fakes = fake();
    expect(
      fakes.service.preview({
        ...input,
        to: { condition: "monotributo", cuit: "20123456789" },
        currency: "USD",
        exchangeRate: "1200.500000",
        service: {
          from: "20260901",
          to: "2026-09-30",
          dueDate: "20261001",
        },
      }).header
    ).toEqual({
      concept: 2,
      documentType: 80,
      documentNumber: "20123456789",
      receiverVatConditionId: 6,
      currencyId: "DOL",
      exchangeRate: "1200.5",
      serviceStartDate: "2026-09-01",
      serviceEndDate: "2026-09-30",
      paymentDueDate: "2026-10-01",
    });
    expectNoProviderCalls(fakes);
  });
  it.each([
    {
      ...input,
      service: { from: "20260901", to: "20260930", dueDate: "20261001" },
    },
    { ...input, currency: "USD", exchangeRate: "1200.5" },
    { ...input, to: { condition: "consumidor_final", dni: 12_345_678 } },
    { ...input, total: 12_101 },
    { ...input, issuer: "exento", items: [{ amount: 10_000 }] },
  ])("matches what issue() sends for %j", async (value) => {
    const { service, wsfe } = fake();
    const preview = service.preview(value as IssueInput);
    await service.issue(value as IssueInput);
    expect(wsfe.issue.mock.calls[0][0].data).toEqual(preview.request);
  });
  it("defaults the voucher date exactly as issue() does", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T23:30:00Z"));
    try {
      const { service, wsfe } = fake();
      const undated = { ...input, date: undefined };
      const preview = service.preview(undated);
      await service.issue(undated);
      expect(preview.request.voucherDate).toBe("20260904");
      expect(preview.date).toBe("2026-09-04");
      expect(wsfe.issue.mock.calls[0][0].data).toEqual(preview.request);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([
    null,
    { ...input, items: [{ net: -1, vat: 21 }] },
    { ...input, to: {} },
    { ...input, salesPoint: 0 },
    { ...input, items: [] },
    { ...input, date: "20260230" },
    { ...input, date: "20260830" },
    { ...input, currency: "USD" },
    { ...input, total: 12_103 },
    { ...input, items: [{ amount: 100 }] },
    { ...input, issuer: "monotributo", items: [{ gross: 100, vat: 21 }] },
    { ...input, items: [{ gross: 1_000_000_000, vat: 21 }] },
    { ...input, kind: "credit_note" },
    {
      ...input,
      service: { from: "20260901", to: "20260930", dueDate: "20260903" },
    },
  ])("throws the same zero-I/O error as issue() for %j", async (value) => {
    const fakes = fake();
    const { service } = fakes;
    const previewError = thrown(() => service.preview(value as IssueInput));
    const issueError = await rejected(() => service.issue(value as IssueInput));
    expect(previewError).toEqual(issueError);
    expect(previewError.name).toBe("ArcaInputError");
    expectNoProviderCalls(fakes);
  });
  it.each([
    null,
    { representedTaxId: "bad" },
    { representedTaxId: 1.5 },
    { include: { rawResponse: true } },
    { idempotencyKey: "key" },
    { forceRefresh: true },
  ])("rejects options it does not support: %j", (options) => {
    const fakes = fake();
    const { service } = fakes;
    expect(() =>
      service.preview(input, options as { representedTaxId?: string })
    ).toThrowError(expect.objectContaining({ name: "ArcaInputError" }));
    expectNoProviderCalls(fakes);
  });
});
