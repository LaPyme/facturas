---
"facturas": minor
---

Close the gaps the app worked around.

- `preview()`, `previewCreditNote()` and `previewDebitNote()` return `date`, the voucher date as `YYYY-MM-DD`.
- `wsfe.getSalesPoints()` returns the WSMTXCA shape: `blocked` is a boolean and `deletedAt` a `YYYY-MM-DD` date, absent while the point is active.
- New `arca.lookup(voucher, options)` consults one authorized voucher on WSFE or WSMTXCA and returns a `VoucherSummary` or `null`. It replaces `wsfe.getVoucherInfo()` and `wsmtxca.getVoucher()`, which are removed with `WsmtxcaVoucherLookupResult`.
- `padron.getTaxpayerDetails()` returns `address`, `activities` and the constancia's `errors`.
- `toArcaSafeErrorMetadata()` keeps each error class's typed fields, such as `field`, `reason`, `service`, `operation` and `serviceCode`.
