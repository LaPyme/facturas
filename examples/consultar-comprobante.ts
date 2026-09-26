import { createArcaClient } from "facturas";
import { ARCA_VOUCHER_TYPES } from "facturas/constants";

const environment = process.env.ARCA_ENVIRONMENT;
if (environment !== "test" && environment !== "production") {
  throw new Error("ARCA_ENVIRONMENT debe ser test o production");
}

const client = createArcaClient({
  taxId: process.env.ARCA_TAX_ID,
  certificatePem: process.env.ARCA_CERTIFICATE_PEM,
  privateKeyPem: process.env.ARCA_PRIVATE_KEY_PEM,
  environment,
});

async function main() {
  const voucher = await client.lookup({
    salesPoint: 1,
    voucherType: ARCA_VOUCHER_TYPES.FACTURA_B,
    number: 245,
  });

  console.log(voucher ?? "ARCA no tiene ese comprobante");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
