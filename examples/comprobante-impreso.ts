import { buildVoucherDocument, createArcaClient, type VatItem } from "facturas";

const arca = createArcaClient();

// Los mismos ítems sirven para emitir y para imprimir. Cada uno lleva su
// descripción, y la cantidad va junto al precio unitario con IVA de la clase B.
const items = [
  {
    description: "Taladro percutor 13 mm",
    quantity: 2,
    unitPrice: "605.00",
    gross: 121_000,
    vat: 21,
  },
  { description: "Mechas para metal", gross: 2420, vat: 10.5 },
] satisfies VatItem[];

const factura = await arca.issue({
  issuer: "responsable_inscripto",
  salesPoint: 3,
  to: { condition: "consumidor_final" },
  items,
});

if (factura.kind === "authorized") {
  const comprobante = buildVoucherDocument({
    voucher: factura.voucher,
    items,
    issuer: {
      legalName: "Ferretería del Sur SRL",
      address: "Av. Rivadavia 1234, CABA",
      taxId: "20-12345678-9",
      condition: "responsable_inscripto",
      grossIncome: "901-123456-7",
      activitiesStartDate: "2019-10-01",
    },
    saleConditions: "Contado",
  });

  // Letra, código, número, leyendas, líneas, IVA, transparencia fiscal, CAE y
  // QR, listos para tu plantilla. Los importes siguen en centavos.
  console.log(comprobante.voucherClass, comprobante.number);
  console.log(comprobante.transparency, comprobante.authorization);
}
