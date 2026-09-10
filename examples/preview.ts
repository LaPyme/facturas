import { createArcaClient, createMemoryStore, type IssueInput } from "facturas";

// Solo para este ejemplo. En una aplicación, usá un store persistente.
const arca = createArcaClient({ store: createMemoryStore() });
const venta = { id: "sale-example-002", totalEnCentavos: 121_000 };

const input: IssueInput = {
  issuer: "responsable_inscripto",
  salesPoint: 3,
  to: { condition: "consumidor_final" },
  items: [{ gross: 121_000, vat: 21 }], // ARS 1.210,00 en centavos
};

// preview() es sincrónico y no consulta el store, WSAA ni SOAP.
const previsualizacion = arca.preview(input);
console.log(
  previsualizacion.voucherClass, // "B"
  previsualizacion.voucherType, // 6
  previsualizacion.amounts, // computedTotal, sentTotal y vatAdjustment
  previsualizacion.request // El input de WSFE, sin el número de comprobante.
);

if (previsualizacion.amounts.sentTotal !== venta.totalEnCentavos) {
  throw new Error("El total de la factura no coincide con el de la venta.");
}

const factura = await arca.issue(input, { idempotencyKey: venta.id });
if (factura.kind === "authorized") {
  // Los importes emitidos son los que mostró la vista previa.
  console.log(factura.voucher.amounts, previsualizacion.amounts);
}
