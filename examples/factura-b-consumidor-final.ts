import { buildFacturaB, createArcaClient } from "facturas";
import {
  ARCA_CONCEPT_TYPES,
  ARCA_DOCUMENT_TYPES,
  ARCA_RECEIVER_VAT_CONDITIONS,
} from "facturas/constants";

const client = createArcaClient({
  taxId: "20123456789",
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

  // Exact convenience: the caller coordinates numbering and recovery.
  const issued = await client.wsfe.createNextVoucher({
    data,
  });

  console.log(issued.cae, issued.caeExpiry, issued.voucherNumber);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
