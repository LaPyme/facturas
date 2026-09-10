import { createArcaClient, createFileStore } from "facturas";

// Configurá las credenciales de ARCA y un directorio privado que sobreviva a
// reinicios. Esto emite una nota de crédito real por parte de la factura.
const arca = createArcaClient({
  store: createFileStore("./private-arca-store"),
});
const devolucion = { id: "refund-example-001" };

const nota = await arca.issueCreditNote(
  {
    // La factura original es de clase C por ARS 1.500,00.
    for: { salesPoint: 3, voucherType: 11, number: 41 },
    // Para clase C usá amount. Para A y B, usá gross o net junto con vat.
    items: [{ amount: 50_000 }], // ARS 500,00 en centavos
  },
  { idempotencyKey: `nc:${devolucion.id}` }
);

switch (nota.kind) {
  case "authorized":
    console.log(nota.voucher);
    break;
  case "rejected":
    console.error(nota.issues);
    break;
  case "indeterminate":
    console.error(nota.attempted, nota.lookup);
    break;
  case "conflict":
    console.error(nota.attempted, nota.found);
    break;
  default:
    nota satisfies never;
}
