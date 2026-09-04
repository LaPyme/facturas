import { createArcaClient, createMemoryStore } from "facturas";

// Example only: use a durable store in an app. Memory does not survive restarts.
const arca = createArcaClient({ store: createMemoryStore() });
const venta = { id: "sale-example-001" };
const factura = await arca.vouchers.issue(
  {
    issuer: "monotributo",
    salesPoint: 3,
    to: { condition: "consumidor_final" },
    items: [{ amount: 150_000 }], // ARS 1.500,00 en centavos
  },
  { idempotencyKey: venta.id }
);

switch (factura.kind) {
  case "authorized":
    console.log(factura.voucher);
    break;
  case "rejected":
    console.error(factura.issues);
    break;
  case "indeterminate":
    console.error(factura.attempted, factura.lookup);
    break;
  case "conflict":
    console.error(factura.attempted, factura.found);
    break;
  default:
    factura satisfies never;
}
