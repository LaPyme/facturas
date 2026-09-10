import { createArcaClient } from "facturas";

// Solo necesitás ARCA_TAX_ID, ARCA_CERTIFICATE_PEM, ARCA_PRIVATE_KEY_PEM y
// ARCA_ENVIRONMENT. Este primer ejemplo no usa store ni clave para reintentos.
const arca = createArcaClient();

const factura = await arca.issue({
  issuer: "monotributo",
  salesPoint: 3,
  to: { condition: "consumidor_final" },
  items: [{ amount: 150_000 }], // ARS 1.500,00 en centavos
});

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
