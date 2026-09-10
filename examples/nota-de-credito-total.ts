import { createArcaClient, createFileStore } from "facturas";

// Configurá las credenciales de ARCA y un directorio privado que sobreviva a
// reinicios. Esto emite una nota de crédito real por toda la factura.
const arca = createArcaClient({
  store: createFileStore("./private-arca-store"),
});
const nota = await arca.issueCreditNote(
  { for: { salesPoint: 3, voucherType: 11, number: 1 }, all: true },
  { idempotencyKey: "nota-de-credito-total-example-001" }
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
