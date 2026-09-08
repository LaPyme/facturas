---
"facturas": patch
---

A superseded key no longer reports `conflict` when the voucher at its number belongs to the key that took the sequence. After a crash between reservation and submission, the next claim proves the number empty, takes it and authorizes within seconds; until now the crashed key's retry found that voucher and asked for manual reconciliation. It now returns `indeterminate` with `lookup: { kind: "superseded", by }`, the same answer it gave while the number was still empty, so the caller issues under a new key. `conflict` remains when the successor, or a key that took the number from it in turn, recorded a conflict there: a stranger reached the number and the voucher must be attributed by hand.
