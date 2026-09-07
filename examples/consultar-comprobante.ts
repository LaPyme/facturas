import { createArcaClient } from "facturas";
import { ARCA_VOUCHER_TYPES } from "facturas/constants";

const client = createArcaClient({
  taxId: "20123456786",
  certificatePem:
    "-----BEGIN CERTIFICATE-----\nREPLACE_WITH_YOUR_CERTIFICATE\n-----END CERTIFICATE-----",
  privateKeyPem:
    "-----BEGIN PRIVATE KEY-----\nREPLACE_WITH_YOUR_PRIVATE_KEY\n-----END PRIVATE KEY-----",
  environment: "test",
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
