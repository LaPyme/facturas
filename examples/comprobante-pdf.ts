import { readFile, writeFile } from "node:fs/promises";
import { renderVoucherPdf } from "@facturas/pdf";
import { buildVoucherDocument, createArcaClient, type VatItem } from "facturas";

const arca = createArcaClient();

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
      tradeName: "Ferretería del Sur",
      address: "Av. Rivadavia 1234, CABA",
      taxId: "20-12345678-9",
      condition: "responsable_inscripto",
      grossIncome: "901-123456-7",
      activitiesStartDate: "2019-10-01",
    },
    saleConditions: "Contado",
  });

  // A4 con la ubicación de la RG 1415, Anexo II, Apartado B. El tema cambia
  // tipografía y colores, nunca dónde va un dato fiscal ni su tamaño.
  const pdf = await renderVoucherPdf(comprobante, {
    logo: await readFile("logo.png"),
    notes: "Garantía oficial de 6 meses. Cambios dentro de los 10 días.",
    theme: { accentColor: "#C00000" },
  });
  await writeFile(`factura-${comprobante.number}.pdf`, pdf);
}
