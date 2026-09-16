---
"facturas": minor
---

- `IssuedVoucher.date` and `caeExpiry` are `YYYY-MM-DD`, and `VoucherSummary` (note `originals`, conflict `found`, matched `lookup`) carries money in minor units and dates in `YYYY-MM-DD`, like the input. Only `request` keeps ARCA's shape. Settled conflict records are written `v: 2` with the normalized summary; `v: 1` records are normalized on read.
- `IssuedVoucher.qr` is the URL the printed voucher's QR must encode, per ARCA's QR specification. `arcaQrUrl()` and `arcaQrPayload()` build it from stored data.
- `padron.getTaxpayerDetails()` returns `condition`, the receiver condition derived from the active IVA registrations, and `taxes`. A constancia that says the taxpayer does not exist returns `null`.
- WSAA tickets in a `store` are sealed with AES-256-GCM under a key derived from the private key. The key prefix is `arca:v2:wsaa:`; earlier plaintext records are ignored.
- `issue()`, `issueCreditNote()` and `issueDebitNote()` resubmit once with a fresh ticket after an `authentication_rejected` indeterminate. `forceRefresh: true` disables that retry.
- `CreditNoteInput.to.condition` supplies the receiver condition when the consulted original does not report one; it must agree when it does.
- `wsfe.getLastVoucher()` and `ARCA_CURRENCIES` are removed. Use `getNextVoucherNumber()`, `ISO_CURRENCIES` and `ARCA_CURRENCY_IDS`.
- The npm description now says what the README says.
