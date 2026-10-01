import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArcaTransportError } from "../errors";
import { createMemoryStore } from "../store/memory";
import { attemptKey } from "../store/types";
import { createVouchersService } from "./vouchers";
import { createWsfeService } from "./wsfe";
import type { IssueInput } from "./wsfe-derive";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-05T15:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const invoice: IssueInput = {
  issuer: "responsable_inscripto",
  salesPoint: 1,
  date: "20260906",
  to: { condition: "responsable_inscripto", cuit: "20123456789" },
  items: [{ net: 10_000, vat: 21 }],
};

function fixture(invalidCoordinates: Record<string, unknown>) {
  const voucher: Record<string, unknown> = {};
  const soap = {
    execute: vi.fn().mockImplementation(async ({ operation, body }) => {
      await Promise.resolve();
      if (operation === "FECAESolicitar") {
        const request = body.FeCAEReq;
        // ARCA pudo autorizar el comprobante antes de perderse la respuesta.
        Object.assign(voucher, structuredClone(request.FeCabReq), {
          ...structuredClone(request.FeDetReq.FECAEDetRequest),
          Resultado: "A",
          CodAutorizacion: "12345678901234",
          FchVto: "20260916",
          ...invalidCoordinates,
        });
        throw new ArcaTransportError("Se perdió la respuesta de autorización");
      }
      if (operation === "FECompConsultar") {
        return { result: { ResultGet: structuredClone(voucher) } };
      }
      throw new Error(`Operación inesperada: ${operation}`);
    }),
  };
  const config = {
    taxId: "20123456789",
    certificatePem: "cert",
    privateKeyPem: "key",
    environment: "test" as const,
  };
  const auth = {
    login: vi.fn().mockResolvedValue({
      token: "token",
      sign: "sign",
      expiresAt: "2099-01-01T00:00:00Z",
    }),
  };
  const store = createMemoryStore();
  const add = vi.spyOn(store, "add");
  const client = createVouchersService(
    createWsfeService({ config, auth, soap }),
    {
      store,
      environment: "test",
      taxId: config.taxId,
    }
  );
  return { client, soap, store, add, voucher };
}

describe("recuperación WSFE con el adaptador SOAP real", () => {
  it.each([
    ["CbteDesde inválido con CbteHasta válido", { CbteDesde: "9abc" }],
    ["CbteHasta inválido con CbteDesde válido", { CbteHasta: "9abc" }],
    ["PtoVta inválido", { PtoVta: "1abc" }],
    ["CbteTipo inválido", { CbteTipo: "1abc" }],
    ["ambos números ausentes", { CbteDesde: undefined, CbteHasta: undefined }],
  ] as const)(
    "conserva la reserva ante %s y recupera sin volver a emitir",
    async (_description, invalidCoordinates) => {
      const { client, soap, store, add, voucher } = fixture(invalidCoordinates);
      const options = { idempotencyKey: "consulta-invalida", number: 9 };
      const uncertain = {
        kind: "indeterminate",
        attempted: { salesPoint: 1, voucherType: 1, number: 9 },
        lookup: {
          kind: "failed",
          error: {
            name: "ArcaInvalidSoapResponseError",
            code: "ARCA_INVALID_SOAP_RESPONSE",
            service: "wsfe",
            operation: "FECompConsultar",
          },
        },
      };
      expect(await client.issue(invoice, options)).toMatchObject(uncertain);
      const key = attemptKey("test", "20123456789", options.idempotencyKey);
      const reservation = await store.get(key);
      expect(JSON.parse(reservation ?? "{}")).toMatchObject({
        salesPoint: 1,
        voucherType: 1,
        number: 9,
      });
      expect(await client.recover(options.idempotencyKey)).toMatchObject(
        uncertain
      );
      expect(await client.issue(invoice, options)).toMatchObject(uncertain);
      expect(await store.get(key)).toBe(reservation);

      Object.assign(voucher, {
        CbteDesde: 9,
        CbteHasta: 9,
        PtoVta: 1,
        CbteTipo: 1,
      });
      const authorized = {
        kind: "authorized",
        recoveredByMatch: true,
        voucher: {
          salesPoint: 1,
          voucherType: 1,
          number: 9,
          cae: "12345678901234",
          caeExpiry: "2026-09-16",
        },
      };
      expect(await client.recover(options.idempotencyKey)).toMatchObject(
        authorized
      );
      expect(await client.issue(invoice, options)).toMatchObject(authorized);
      expect(await store.get(key)).toBe(reservation);
      expect(add).toHaveBeenCalledExactlyOnceWith(key, reservation);
      expect(soap.execute.mock.calls.map(([arg]) => arg.operation)).toEqual([
        "FECAESolicitar",
        "FECompConsultar",
        "FECompConsultar",
        "FECompConsultar",
        "FECompConsultar",
        "FECompConsultar",
      ]);
      expect(soap.execute.mock.calls[0]?.[0]).toMatchObject({
        operation: "FECAESolicitar",
        retries: 0,
      });
    }
  );
});
