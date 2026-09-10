import { buildFacturaB, createArcaClient } from "facturas";
import {
  ARCA_CONCEPT_TYPES,
  ARCA_DOCUMENT_TYPES,
  ARCA_RECEIVER_VAT_CONDITIONS,
} from "facturas/constants";

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
  const data = buildFacturaB({
    salesPoint: 1,
    concept: ARCA_CONCEPT_TYPES.PRODUCTOS,
    documentType: ARCA_DOCUMENT_TYPES.CONSUMIDOR_FINAL,
    documentNumber: 0,
    receiverVatConditionId: ARCA_RECEIVER_VAT_CONDITIONS.CONSUMIDOR_FINAL,
    voucherDate: "2026-09-02",
    taxableAmount: 10_000,
    vatRate: 21,
  });

  // Reservá el número y emitilo una sola vez.
  const voucherNumber = await client.wsfe.getNextVoucherNumber({
    salesPoint: data.salesPoint,
    voucherType: data.voucherType,
  });
  const issued = await client.wsfe.issue({ voucherNumber, data });

  if (issued.kind === "authorized") {
    console.log(issued.cae, issued.caeExpiry, issued.voucherNumber);
  } else {
    console.error(issued.kind, issued);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
