---
"facturas": minor
---

Follow the WSMTXCA manual for the receiver document, voucher classes and item codes.

- An unidentified final consumer (document type 99) no longer sends `codigoTipoDocumento` or `numeroDocumento` to WSMTXCA, per rules 108 and 128. The result header still reports `documentType: 99` and `documentNumber: "0"`, and recovery accepts a consultation that omits the document or echoes 99/0. Credit and debit notes for a WSMTXCA original with no document treat it as 99/0.
- `{ service: "wsmtxca" }` with a class C voucher throws `ArcaInputError` with `field: "voucherType"` before any call (rule 100).
- WSMTXCA items need `matrixCode` and `matrixUnits` unless `unit` is 97 or 99. `matrixUnits` is a whole number from 1 to 999999, the two travel together, and `code` is at most 50 characters (rules 500–505 and 520). Violations throw `ArcaInputError` naming the item and field before any call.
- New `ARCA_WSMTXCA_GENERIC_CODES` lists ARCA's 13 generic item codes with their descriptions, for concepts that have no GTIN.
