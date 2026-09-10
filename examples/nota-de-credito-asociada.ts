import { createArcaClient } from "facturas";
import {
  ARCA_CONCEPT_TYPES,
  ARCA_CURRENCY_IDS,
  ARCA_DOCUMENT_TYPES,
  ARCA_RECEIVER_VAT_CONDITIONS,
  ARCA_VAT_RATES,
  ARCA_VOUCHER_TYPES,
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
  // Reservá el número y emitilo una sola vez.
  const voucherNumber = await client.wsfe.getNextVoucherNumber({
    salesPoint: 1,
    voucherType: ARCA_VOUCHER_TYPES.NOTA_CREDITO_B,
  });
  const issued = await client.wsfe.issue({
    voucherNumber,
    data: {
      salesPoint: 1,
      voucherType: ARCA_VOUCHER_TYPES.NOTA_CREDITO_B,
      concept: ARCA_CONCEPT_TYPES.PRODUCTOS,
      documentType: ARCA_DOCUMENT_TYPES.DNI,
      documentNumber: 30_123_456,
      receiverVatConditionId: ARCA_RECEIVER_VAT_CONDITIONS.CONSUMIDOR_FINAL,
      voucherDate: "2026-05-02",
      totalAmount: 121,
      nonTaxableAmount: 0,
      netAmount: 100,
      exemptAmount: 0,
      taxAmount: 0,
      vatAmount: 21,
      currencyId: ARCA_CURRENCY_IDS.ARS,
      exchangeRate: 1,
      associatedVouchers: [
        {
          type: ARCA_VOUCHER_TYPES.FACTURA_B,
          salesPoint: 1,
          number: 245,
          voucherDate: "2026-04-30",
        },
      ],
      vatRates: [
        {
          id: ARCA_VAT_RATES.IVA_21,
          baseAmount: 100,
          amount: 21,
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
