import { describe, expect, it, vi } from "vitest";
import { ArcaSoapFaultError } from "../errors";
import { createPadronService } from "./padron";

function createBaseOptions() {
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
      execute: vi.fn(),
    },
  };
}

describe("createPadronService", () => {
  it("gets taxpayer details through padron-a5", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce({
      result: {
        personaReturn: {
          idPersona: "20123456789",
          tipoPersona: "JURIDICA",
          datosGenerales: {
            razonSocial: "Mi Empresa SRL",
          },
        },
      },
    });

    const service = createPadronService(options);
    await expect(service.getTaxpayerDetails(20_123_456_789)).resolves.toEqual({
      taxId: "20123456789",
      personType: "JURIDICA",
      name: "Mi Empresa SRL",
      condition: "consumidor_final",
      taxes: [],
      raw: {
        idPersona: "20123456789",
        tipoPersona: "JURIDICA",
        datosGenerales: {
          razonSocial: "Mi Empresa SRL",
        },
      },
    });

    expect(options.auth.login).toHaveBeenCalledWith(
      "ws_sr_constancia_inscripcion"
    );
    expect(options.soap.execute).toHaveBeenCalledWith({
      service: "padron-a5",
      operation: "getPersona_v2",
      bodyElementNamespaceMode: "prefix",
      body: {
        token: "token",
        sign: "sign",
        cuitRepresentada: 20_123_456_789,
        idPersona: 20_123_456_789,
      },
    });
  });

  it("gets tax ids by document through padron-a13", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce({
      result: {
        idPersonaListReturn: {
          idPersona: ["20123456789", "20999888777"],
        },
      },
    });

    const service = createPadronService(options);
    await expect(service.getTaxIdByDocument(12_345_678)).resolves.toEqual({
      taxIds: ["20123456789", "20999888777"],
      raw: {
        idPersona: ["20123456789", "20999888777"],
      },
    });

    expect(options.auth.login).toHaveBeenCalledWith("ws_sr_padron_a13");
  });

  it.each([
    [
      "responsable inscripto",
      {
        datosRegimenGeneral: {
          impuesto: [
            {
              idImpuesto: 30,
              descripcionImpuesto: "IVA",
              estadoImpuesto: "AC",
            },
            { idImpuesto: 10, estadoImpuesto: "AC" },
          ],
        },
      },
      "responsable_inscripto",
    ],
    [
      "monotributo, id as string in either bucket",
      {
        datosMonotributo: {
          impuesto: { idImpuesto: "20", estadoImpuesto: " ac " },
        },
      },
      "monotributo",
    ],
    [
      "exento",
      { datosRegimenGeneral: { impuesto: [{ idImpuesto: 32 }] } },
      "exento",
    ],
    [
      "no alcanzado",
      { datosRegimenGeneral: { impuesto: [{ idImpuesto: 34 }] } },
      "no_alcanzado",
    ],
    [
      "an inactive IVA registration",
      {
        datosRegimenGeneral: {
          impuesto: [{ idImpuesto: 30, estadoImpuesto: "BD" }],
        },
      },
      "consumidor_final",
    ],
    [
      "contradictory registrations",
      {
        datosRegimenGeneral: { impuesto: [{ idImpuesto: 30 }] },
        datosMonotributo: { impuesto: [{ idImpuesto: 20 }] },
      },
      undefined,
    ],
  ])(
    "derives the receiver condition for %s",
    async (_case, data, condition) => {
      const options = createBaseOptions();
      options.soap.execute.mockResolvedValueOnce({
        result: {
          personaReturn: {
            datosGenerales: {
              idPersona: 20_123_456_789,
              tipoPersona: "FISICA",
              nombre: "Ana",
              apellido: "Perez",
            },
            ...data,
          },
        },
      });
      const result =
        await createPadronService(options).getTaxpayerDetails("20123456789");
      expect(result).toMatchObject({
        taxId: "20123456789",
        personType: "FISICA",
        name: "Perez Ana",
      });
      expect(result?.condition).toBe(condition);
      expect(
        result?.taxes.every(
          (tax) =>
            Number.isInteger(tax.id) &&
            ["general", "monotributo"].includes(tax.regime)
        )
      ).toBe(true);
    }
  );

  it("answers null when the constancia says the taxpayer does not exist", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce({
      result: {
        personaReturn: {
          errorConstancia: { error: ["No existe persona con ese Id"] },
        },
      },
    });
    const service = createPadronService(options);
    await expect(service.getTaxpayerDetails("20999999995")).resolves.toBeNull();
    options.soap.execute.mockResolvedValueOnce({
      result: {
        personaReturn: {
          errorConstancia: { error: "La constancia está bloqueada" },
          datosGenerales: { idPersona: 20_999_999_995 },
        },
      },
    });
    await expect(
      service.getTaxpayerDetails("20999999995")
    ).resolves.toMatchObject({
      taxId: "20999999995",
      condition: "consumidor_final",
    });
  });

  it("returns null on not-found SOAP faults and rethrows other SOAP faults", async () => {
    const options = createBaseOptions();
    const service = createPadronService(options);

    options.soap.execute.mockRejectedValueOnce(
      new ArcaSoapFaultError("Persona no existe")
    );
    await expect(service.getTaxpayerDetails(99_999_999)).resolves.toBeNull();

    const fatalFault = new ArcaSoapFaultError("Servicio caido");
    options.soap.execute.mockRejectedValueOnce(fatalFault);
    await expect(service.getTaxIdByDocument(12_345_678)).rejects.toBe(
      fatalFault
    );
  });
});
