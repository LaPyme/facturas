---
"facturas": minor
---

Check ARCA's date window before sending, and read the last authorized number on either service.

- `preview()`, `previewCreditNote()`, `previewDebitNote()`, `issue()`, `issueCreditNote()` and `issueDebitNote()` throw `ArcaInputError` with `field: "date"` when the voucher date falls outside the window ARCA accepts, counted from today in Argentina: products 5 days either side without running into the next month, services 10, and on WSFE an FCE invoice 5 days before through 1 after and an FCE note no earlier than 5 days before. A retry with the same `idempotencyKey` still returns what ARCA already authorized.
- New `arca.lastAuthorized({ salesPoint, voucherType }, options)` returns the last number ARCA authorized on WSFE or WSMTXCA, `0` when none.
