import { createArcaClient, createMemoryStore } from "facturas";

// Solo para este ejemplo. En una aplicación, usá un store persistente.
const arca = createArcaClient({ store: createMemoryStore() });
const venta = { id: "sale-example-001" };
const factura = await arca.issue(
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
