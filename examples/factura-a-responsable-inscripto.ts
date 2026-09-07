import { createArcaClient } from "facturas";
import {
  ARCA_CONCEPT_TYPES,
  ARCA_CURRENCY_IDS,
  ARCA_DOCUMENT_TYPES,
  ARCA_RECEIVER_VAT_CONDITIONS,
  ARCA_VAT_RATES,
  ARCA_VOUCHER_TYPES,
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
  // Exact layer: reserve the number yourself, then issue it exactly once.
  const voucherNumber = await client.wsfe.getNextVoucherNumber({
    salesPoint: 3,
    voucherType: ARCA_VOUCHER_TYPES.FACTURA_A,
  });
  const issued = await client.wsfe.issue({
    voucherNumber,
    data: {
      salesPoint: 3,
      voucherType: ARCA_VOUCHER_TYPES.FACTURA_A,
      concept: ARCA_CONCEPT_TYPES.PRODUCTOS,
      documentType: ARCA_DOCUMENT_TYPES.CUIT,
      documentNumber: 30_717_329_654,
      receiverVatConditionId:
        ARCA_RECEIVER_VAT_CONDITIONS.RESPONSABLE_INSCRIPTO,
      voucherDate: "2026-05-01",
      totalAmount: 1210,
      nonTaxableAmount: 0,
      netAmount: 1000,
      exemptAmount: 0,
      taxAmount: 0,
      vatAmount: 210,
      currencyId: ARCA_CURRENCY_IDS.ARS,
      exchangeRate: 1,
      vatRates: [
        {
          id: ARCA_VAT_RATES.IVA_21,
          baseAmount: 1000,
          amount: 210,
        },
      ],
    },
  });

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
