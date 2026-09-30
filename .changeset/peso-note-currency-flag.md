---
"facturas": patch
---

Omit the foreign-currency cancellation flag when deriving credit and debit notes from peso invoices. ARCA can return `CanMisMonExt: "N"` for those originals, which previously caused note previews and issuance to fail with `Invalid paidInForeignCurrency`. Preserve the reported flag for foreign-currency invoices.
