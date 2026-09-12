import type { createArcaClient, IssueInput } from "facturas";

// Ejemplos importables: importar este archivo no hace ninguna llamada fiscal.
export async function issueReviewedSale(
  arca: ReturnType<typeof createArcaClient>
) {
  const sale = {
    issuer: "responsable_inscripto",
    salesPoint: 1,
    to: { condition: "responsable_inscripto", cuit: "20123456789" },
    // Desglose fiscal ya revisado: el SDK no recalcula el IVA.
    amounts: {
      net: 10_000, // ARS 100,00 en centavos
      vat: 2100,
      vatRates: [{ id: 5, base: 10_000, amount: 2100 }],
    },
    // Los tributos suman al total y van aparte del desglose.
    taxes: [{ id: 2, description: "IIBB", base: 10_000, rate: 3, amount: 300 }],
    total: 12_400,
  } satisfies IssueInput;
  const preview = arca.preview(sale);
  preview.request.totalAmount satisfies number;
  return await arca.issue(sale, { idempotencyKey: "sale:example", number: 42 });
}
export async function issueDetailedInvoice(
  arca: ReturnType<typeof createArcaClient>
) {
  const input = {
    issuer: "responsable_inscripto",
    salesPoint: 1,
    to: { condition: "responsable_inscripto", cuit: "20123456789" },
    // Los mismos ítems llevan el detalle de línea que pide WSMTXCA.
    // unitPrice es la única excepción: string decimal en unidades mayores.
    items: [
      {
        net: 10_000,
        vat: 21,
        description: "Producto",
        quantity: 1,
        unit: 7,
        unitPrice: "100.000000",
      },
    ],
  } satisfies IssueInput;
  const preview = arca.preview(input, { service: "wsmtxca" });
  preview.request.comprobanteCAERequest.importeTotal satisfies number;
  return await arca.issue(input, {
    service: "wsmtxca",
    idempotencyKey: "detailed:example",
  });
}
export async function issueAdjustments(
  arca: ReturnType<typeof createArcaClient>
) {
  const original = { salesPoint: 1, voucherType: 1, number: 42 };
  const debit = await arca.issueDebitNote(
    { for: original, items: [{ net: 1000, vat: 21 }] },
    { idempotencyKey: "debit:example" }
  );
  if (debit.kind !== "authorized") {
    return debit;
  }
  const credit = {
    for: {
      salesPoint: debit.voucher.salesPoint,
      voucherType: debit.voucher.voucherType,
      number: debit.voucher.number,
    },
    all: true as const,
  };
  // Este método consulta el original una vez. No reserva número ni escribe nada.
  await arca.previewCreditNote(credit);
  return await arca.issueCreditNote(credit, {
    idempotencyKey: "credit:example",
  });
}
export function previewFce(arca: ReturnType<typeof createArcaClient>) {
  return arca.preview({
    issuer: "responsable_inscripto",
    family: "fce",
    salesPoint: 1,
    to: { condition: "responsable_inscripto", cuit: "20123456789" },
    items: [{ net: 10_000, vat: 21 }],
    date: "2026-09-06",
    dueDate: "2026-10-01",
    // FCE: el CBU de 22 dígitos y el vencimiento son obligatorios.
    fce: { cbu: "1234567890123456789012", transfer: "SCA" },
  });
}
