---
"facturas": patch
---

A WSFE 10016 rejection on a number the same call reserved is never resolved by comparing fiscal fields: the consultation returns `conflict` when another voucher occupies the number and `rejected` when the number is empty. Two sales with identical fiscal data, the common retail case, matched on every field and the loser was reported `authorized` with the winner's CAE. Identity matching stays for a pre-existing reservation, the only case where the number can be this key's own earlier write. Every `conflict` is now recorded once with `add` under `arca:v1:settled:{environment}:{taxId}:{idempotencyKey}`, so a keyed retry and `recover()` repeat it with zero provider calls. Reservation records are untouched.
