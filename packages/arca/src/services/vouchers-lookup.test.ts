import { describe, expect, it, vi } from "vitest";
import { createVouchersService } from "./vouchers";
import type { WsfeVoucherLookupResult } from "./wsfe";
import { deriveWsfeInvoice } from "./wsfe-derive";
import type { WsmtxcaService, WsmtxcaVoucherLookupOutcome } from "./wsmtxca";

const data = deriveWsfeInvoice({
  issuer: "monotributo",
  salesPoint: 1,
  date: "20260904",
  to: { condition: "consumidor_final" },
  items: [{ amount: 100 }],
}).data;
const voucher = { salesPoint: 1, voucherType: 11, number: 7 };
function found(number = 7): WsfeVoucherLookupResult {
  return {
    kind: "found",
    service: "wsfe",
    operation: "FECompConsultar",
    observations: [],
    raw: { secret: true },
    voucher: {
      ...data,
      documentNumber: String(data.documentNumber),
      exchangeRate: Number(data.exchangeRate),
      voucherNumber: number,
      result: "A",
      cae: "74123456789012",
      caeExpiry: "20260915",
      raw: { secret: true },
    },
  };
}
function fake(result: WsfeVoucherLookupResult, wsmtxca?: WsmtxcaService) {
  const wsfe = {
    getNextVoucherNumber: vi.fn(),
    issue: vi.fn(),
    lookupVoucher: vi.fn().mockResolvedValue(result),
  };
  return { wsfe, service: createVouchersService(wsfe, undefined, wsmtxca) };
}

describe("vouchers.lookup", () => {
  it("returns the raw-free summary in the facade's units", async () => {
    const { wsfe, service } = fake(found());
    const summary = await service.lookup(voucher, {
      representedTaxId: "20123456786",
    });
    expect(wsfe.lookupVoucher).toHaveBeenCalledExactlyOnceWith({
      representedTaxId: "20123456786",
      forceRefresh: undefined,
      ...voucher,
    });
    expect(summary).toMatchObject({
      number: 7,
      salesPoint: 1,
      voucherType: 11,
      date: "2026-09-04",
      totalAmount: 100,
      cae: "74123456789012",
      caeExpiry: "2026-09-15",
    });
    expect(summary).not.toHaveProperty("raw");
    expect(wsfe.issue).not.toHaveBeenCalled();
    expect(wsfe.getNextVoucherNumber).not.toHaveBeenCalled();
  });

  it("returns null when ARCA has no such voucher", async () => {
    const { service } = fake({
      kind: "not_found",
      service: "wsfe",
      operation: "FECompConsultar",
      errors: [
        {
          service: "wsfe",
          operation: "FECompConsultar",
          source: "error",
          category: "business",
          code: "602",
          message: "No existen datos",
        },
      ],
      observations: [],
      raw: {},
    });
    await expect(service.lookup(voucher)).resolves.toBeNull();
  });

  it("throws when ARCA answers with other coordinates", async () => {
    const { service } = fake(found(8));
    await expect(service.lookup(voucher)).rejects.toMatchObject({
      name: "ArcaServiceError",
      service: "wsfe",
      operation: "FECompConsultar",
    });
  });

  it("consults WSMTXCA with service: wsmtxca", async () => {
    const outcome: WsmtxcaVoucherLookupOutcome = {
      kind: "found",
      service: "wsmtxca",
      operation: "consultarComprobante",
      observations: [],
      raw: {},
      voucher: {
        voucherNumber: 7,
        salesPoint: 1,
        voucherType: 1,
        invoiceDate: "2026-09-04",
        totalAmount: 121,
        raw: {},
      },
    };
    const wsmtxca = {
      lookupVoucher: vi.fn().mockResolvedValue(outcome),
    } as unknown as WsmtxcaService;
    const { wsfe, service } = fake(found(), wsmtxca);
    await expect(
      service.lookup({ ...voucher, voucherType: 1 }, { service: "wsmtxca" })
    ).resolves.toMatchObject({
      number: 7,
      salesPoint: 1,
      voucherType: 1,
      date: "2026-09-04",
      totalAmount: 12_100,
    });
    expect(wsmtxca.lookupVoucher).toHaveBeenCalledWith(
      expect.objectContaining({ voucherType: 1, voucherNumber: 7 })
    );
    expect(wsfe.lookupVoucher).not.toHaveBeenCalled();
  });

  it.each([
    [null, "voucher"],
    [{ ...voucher, number: 0 }, "voucher.number"],
    [{ ...voucher, salesPoint: 1.5 }, "voucher.salesPoint"],
    [{ ...voucher, voucherType: "11" }, "voucher.voucherType"],
    [{ ...voucher, extra: true }, "voucher.extra"],
  ])("rejects %j before any call", async (value, field) => {
    const { wsfe, service } = fake(found());
    await expect(service.lookup(value as typeof voucher)).rejects.toMatchObject(
      { name: "ArcaInputError", field }
    );
    expect(wsfe.lookupVoucher).not.toHaveBeenCalled();
  });

  it("rejects options that only apply to issuance", async () => {
    const { wsfe, service } = fake(found());
    await expect(
      service.lookup(voucher, { idempotencyKey: "key" } as never)
    ).rejects.toMatchObject({ name: "ArcaInputError" });
    expect(wsfe.lookupVoucher).not.toHaveBeenCalled();
  });
});
