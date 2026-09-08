---
"facturas": patch
---

`recover()` now reports `ARCA_INPUT_RESERVATION_NOT_FOUND` when its idempotency key has no stored reservation, so callers do not need to match the English message. Linked credit-note and debit-note previews now return the normalized, raw-free original voucher that the SDK consulted; period-note previews remain consultation-free and have no original.
