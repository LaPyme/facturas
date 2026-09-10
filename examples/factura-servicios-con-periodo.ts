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
    salesPoint: 2,
    voucherType: ARCA_VOUCHER_TYPES.FACTURA_A,
  });
  const issued = await client.wsfe.issue({
    voucherNumber,
    data: {
      salesPoint: 2,
      voucherType: ARCA_VOUCHER_TYPES.FACTURA_A,
      concept: ARCA_CONCEPT_TYPES.SERVICIOS,
      documentType: ARCA_DOCUMENT_TYPES.CUIT,
      documentNumber: 30_717_329_654,
      receiverVatConditionId:
        ARCA_RECEIVER_VAT_CONDITIONS.RESPONSABLE_INSCRIPTO,
      voucherDate: "2026-05-10",
      totalAmount: 2420,
      nonTaxableAmount: 0,
      netAmount: 2000,
      exemptAmount: 0,
      taxAmount: 0,
      vatAmount: 420,
      currencyId: ARCA_CURRENCY_IDS.ARS,
      exchangeRate: 1,
      serviceStartDate: "2026-05-01",
      serviceEndDate: "2026-05-31",
      paymentDueDate: "2026-06-10",
      vatRates: [
        {
          id: ARCA_VAT_RATES.IVA_21,
          baseAmount: 2000,
          amount: 420,
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
