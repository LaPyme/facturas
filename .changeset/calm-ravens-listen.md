---
"facturas": minor
---

Rename the public cancellation option from `signal` to `abortSignal`. Rename optional high-level fiscal evidence from `include.sent` and `include.raw` to `include.request` and `include.rawResponse`, exposed as `request` and `rawResponse`. The requested fiscal request is now available across authorized, rejected, indeterminate, and conflict outcomes, while persisted reservations remain backward compatible.
