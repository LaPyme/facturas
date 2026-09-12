import { createArcaClient } from "facturas";

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
  const taxpayer = await client.padron.getTaxpayerDetails("30717329654");

  console.log(taxpayer);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
