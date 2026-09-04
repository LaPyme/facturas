import { createArcaClient, createFileStore } from "facturas";

// Configure ARCA credentials and a private durable directory before running.
// Both the original invoice and its credit note remain in ARCA's records.
const arca = createArcaClient({
  store: createFileStore("./private-arca-store"),
});
const nota = await arca.vouchers.cancel(
  { salesPoint: 3, voucherType: 11, number: 1 },
  { idempotencyKey: "cancel-sale-example-001" }
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
