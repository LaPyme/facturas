---
"facturas": patch
---

Normalize the foreign-currency cancellation flag in WSFE and WSMTXCA lookup results. Ignore the flag on peso vouchers so credit and debit notes can be prepared and uncertain issuance outcomes can be recovered without a false identity conflict. Preserve valid foreign-currency flags, validate WSMTXCA values, and retain raw provider evidence for diagnostics.
