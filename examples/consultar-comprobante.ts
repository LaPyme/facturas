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
  const voucher = await client.wsfe.getVoucherInfo({
    number: 245,
    salesPoint: 1,
    voucherType: ARCA_VOUCHER_TYPES.FACTURA_B,
  });

  console.log(voucher);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
