import { createArcaClient } from "facturas";

const client = createArcaClient({
  taxId: "20123456786",
  certificatePem:
    "-----BEGIN CERTIFICATE-----\nREPLACE_WITH_YOUR_CERTIFICATE\n-----END CERTIFICATE-----",
  privateKeyPem:
    "-----BEGIN PRIVATE KEY-----\nREPLACE_WITH_YOUR_PRIVATE_KEY\n-----END PRIVATE KEY-----",
  environment: "test",
});

async function main() {
  const taxpayer = await client.padron.getTaxpayerDetails("30717329654");

  console.log(taxpayer);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
