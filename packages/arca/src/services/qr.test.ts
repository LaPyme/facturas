import { describe, expect, it } from "vitest";
import { ARCA_QR_URL, arcaQrPayload, arcaQrUrl } from "./qr";

const base = {
  taxId: "30000000007",
  salesPoint: 10,
  voucherType: 1,
  number: 94,
  date: "2020-10-13",
  total: 1_210_000,
  currency: "DOL",
  exchangeRate: 65,
  cae: "70417054367476",
  document: { type: 80, number: "20000000001" },
};

describe("arcaQrUrl", () => {
  it("reproduces the example of ARCA's specification byte for byte", () => {
    expect(arcaQrUrl(base)).toBe(
      `${ARCA_QR_URL}?p=eyJ2ZXIiOjEsImZlY2hhIjoiMjAyMC0xMC0xMyIsImN1aXQiOjMwMDAwMDAwMDA3LCJwdG9WdGEiOjEwLCJ0aXBvQ21wIjoxLCJucm9DbXAiOjk0LCJpbXBvcnRlIjoxMjEwMCwibW9uZWRhIjoiRE9MIiwiY3R6Ijo2NSwidGlwb0RvY1JlYyI6ODAsIm5yb0RvY1JlYyI6MjAwMDAwMDAwMDEsInRpcG9Db2RBdXQiOiJFIiwiY29kQXV0Ijo3MDQxNzA1NDM2NzQ3Nn0=`
    );
  });
  it("defaults pesos, accepts compact dates and omits an unidentified receiver", () => {
    expect(
      arcaQrPayload({
        ...base,
        date: "20260904",
        total: 12_150,
        currency: undefined,
        exchangeRate: "1.000000",
        document: { type: 99, number: 0 },
      })
    ).toEqual({
      ver: 1,
      fecha: "2026-09-04",
      cuit: 30_000_000_007,
      ptoVta: 10,
      tipoCmp: 1,
      nroCmp: 94,
      importe: 121.5,
      moneda: "PES",
      ctz: 1,
      tipoCodAut: "E",
      codAut: 70_417_054_367_476,
    });
    expect(arcaQrPayload({ ...base, document: undefined })).not.toHaveProperty(
      "tipoDocRec"
    );
    expect(
      arcaQrPayload({ ...base, document: { type: 96, number: 0 } })
    ).not.toHaveProperty("nroDocRec");
    expect(arcaQrPayload({ ...base, authorization: "CAEA" }).tipoCodAut).toBe(
      "A"
    );
    expect(arcaQrPayload({ ...base, exchangeRate: "65.5" }).ctz).toBe(65.5);
  });
  it("rejects malformed input before encoding", () => {
    for (const change of [
      { date: "13/10/2020" },
      { taxId: "123" },
      { salesPoint: 0 },
      { number: 100_000_000 },
      { total: 12.5 },
      { total: -1 },
      { currency: "PESOS" },
      { exchangeRate: 0 },
      { cae: "1234" },
      { document: { type: 80, number: "12A" } },
    ]) {
      expect(() => arcaQrPayload({ ...base, ...change })).toThrow(
        expect.objectContaining({ name: "ArcaInputError" })
      );
    }
  });
});
