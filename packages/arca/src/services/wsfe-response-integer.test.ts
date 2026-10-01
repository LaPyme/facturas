import { describe, expect, it, vi } from "vitest";
import { ArcaInvalidSoapResponseError } from "../errors";
import { createWsfeService } from "./wsfe";

const OPERACIONES_NUMERICAS = [
  {
    method: "getSalesPoints",
    operation: "FEParamGetPtosVenta",
    resultKey: "PtoVenta",
    field: "Nro",
    max: 99_999,
  },
  {
    method: "getVoucherTypes",
    operation: "FEParamGetTiposCbte",
    resultKey: "CbteTipo",
    field: "Id",
    max: Number.MAX_SAFE_INTEGER,
  },
  {
    method: "getDocumentTypes",
    operation: "FEParamGetTiposDoc",
    resultKey: "DocTipo",
    field: "Id",
    max: Number.MAX_SAFE_INTEGER,
  },
  {
    method: "getConceptTypes",
    operation: "FEParamGetTiposConcepto",
    resultKey: "ConceptoTipo",
    field: "Id",
    max: Number.MAX_SAFE_INTEGER,
  },
  {
    method: "getVatRates",
    operation: "FEParamGetTiposIva",
    resultKey: "IvaTipo",
    field: "Id",
    max: Number.MAX_SAFE_INTEGER,
  },
  {
    method: "getTaxTypes",
    operation: "FEParamGetTiposTributos",
    resultKey: "TributoTipo",
    field: "Id",
    max: Number.MAX_SAFE_INTEGER,
  },
  {
    method: "getOptionalTypes",
    operation: "FEParamGetTiposOpcional",
    resultKey: "OpcionalTipo",
    field: "Id",
    max: Number.MAX_SAFE_INTEGER,
  },
  {
    method: "getActivities",
    operation: "FEParamGetActividades",
    resultKey: "ActividadesTipo",
    field: "Id",
    max: Number.MAX_SAFE_INTEGER,
  },
  {
    method: "getReceiverVatConditions",
    operation: "FEParamGetCondicionIvaReceptor",
    resultKey: "CondicionIvaReceptor",
    field: "Id",
    max: Number.MAX_SAFE_INTEGER,
  },
] as const;

function createOptions(operation: string, result: Record<string, unknown>) {
  return {
    config: {
      taxId: "20123456789",
      certificatePem: "cert",
      privateKeyPem: "key",
      environment: "test" as const,
    },
    auth: {
      login: vi.fn().mockResolvedValue({
        token: "token",
        sign: "sign",
        expiresAt: "2099-01-01T00:00:00Z",
      }),
    },
    soap: {
      execute: vi.fn().mockResolvedValue({
        result: {
          [`${operation}Response`]: {
            [`${operation}Result`]: result,
          },
        },
      }),
    },
  };
}

// La sintaxis de enteros se prueba en response-integer.test.ts. Acá importa
// que cada operación use el parser y respete el dominio de su campo.
describe.each(OPERACIONES_NUMERICAS)(
  "validación de enteros en $operation",
  ({ method, operation, resultKey, field, max }) => {
    it.each([
      { nombre: "ausente", valor: undefined },
      { nombre: "malformado", valor: "12abc" },
    ])(
      "rechaza un campo $nombre con un error SOAP tipado",
      async ({ valor }) => {
        const options = createOptions(operation, {
          ResultGet: {
            [resultKey]: { [field]: valor },
          },
        });
        const result = createWsfeService(options)[method]();

        await expect(result).rejects.toBeInstanceOf(
          ArcaInvalidSoapResponseError
        );
        await expect(result).rejects.toMatchObject({
          service: "wsfe",
          operation,
        });
        expect(options.soap.execute).toHaveBeenCalledOnce();
        expect(options.auth.login).toHaveBeenCalledOnce();
      }
    );

    it("acepta un entero válido hasta el límite del dominio", async () => {
      const options = createOptions(operation, {
        ResultGet: {
          [resultKey]: { [field]: String(max) },
        },
      });

      await expect(createWsfeService(options)[method]()).resolves.toMatchObject(
        [{ [field === "Nro" ? "number" : "id"]: max }]
      );
    });

    it("distingue el cero explícito de un campo ausente", async () => {
      const options = createOptions(operation, {
        ResultGet: {
          [resultKey]: [{ [field]: "0" }, { [field]: 1 }],
        },
      });
      const result = createWsfeService(options)[method]();

      if (field === "Nro") {
        await expect(result).rejects.toMatchObject({
          name: "ArcaInvalidSoapResponseError",
          service: "wsfe",
          operation,
        });
      } else {
        await expect(result).resolves.toMatchObject([{ id: 0 }, { id: 1 }]);
      }
    });
  }
);

// Puntos de venta y catálogos tienen recorridos de listas distintos.
// Las demás operaciones numéricas comparten el recorrido de catálogos.
describe.each([OPERACIONES_NUMERICAS[0], OPERACIONES_NUMERICAS[1]])(
  "estructura y límites en $operation",
  ({ method, operation, resultKey, field, max }) => {
    it("rechaza el valor que supera el límite del dominio", async () => {
      const options = createOptions(operation, {
        ResultGet: { [resultKey]: { [field]: max + 1 } },
      });

      await expect(createWsfeService(options)[method]()).rejects.toMatchObject({
        name: "ArcaInvalidSoapResponseError",
        service: "wsfe",
        operation,
      });
    });

    it.each([null, []])(
      "rechaza toda la lista si una entrada está malformada: %j",
      async (entrada) => {
        const options = createOptions(operation, {
          ResultGet: {
            [resultKey]: [{ [field]: 1 }, entrada],
          },
        });

        await expect(
          createWsfeService(options)[method]()
        ).rejects.toMatchObject({
          name: "ArcaInvalidSoapResponseError",
          service: "wsfe",
          operation,
        });
      }
    );

    it.each([null, 0, {}])(
      "rechaza una entrada única malformada: %j",
      async (entrada) => {
        const options = createOptions(operation, {
          ResultGet: { [resultKey]: entrada },
        });

        await expect(
          createWsfeService(options)[method]()
        ).rejects.toMatchObject({
          name: "ArcaInvalidSoapResponseError",
          service: "wsfe",
          operation,
        });
      }
    );

    it.each([{}, { ResultGet: {} }, { ResultGet: { [resultKey]: [] } }])(
      "mantiene vacías las respuestas sin entradas: %j",
      async (result) => {
        const options = createOptions(operation, result);

        await expect(createWsfeService(options)[method]()).resolves.toEqual([]);
      }
    );
  }
);
