import { buildFacturaB, createArcaClient } from "facturas";
import {
  ARCA_CONCEPT_TYPES,
  ARCA_DOCUMENT_TYPES,
  ARCA_RECEIVER_VAT_CONDITIONS,
} from "facturas/constants";

const client = createArcaClient({
  taxId: "20123456786",
  certificatePem:
    "-----BEGIN CERTIFICATE-----\nREPLACE_WITH_YOUR_CERTIFICATE\n-----END CERTIFICATE-----",
  privateKeyPem:
    "-----BEGIN PRIVATE KEY-----\nREPLACE_WITH_YOUR_PRIVATE_KEY\n-----END PRIVATE KEY-----",
  environment: "test",
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

  // Exact layer: reserve the number yourself, then issue it exactly once.
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
