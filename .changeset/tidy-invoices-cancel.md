---
"facturas": minor
---

Add durable idempotency keys for invoice issuance and full associated credit notes through `vouchers.cancel()`. Bundle Postgres, Redis, file and memory stores without runtime driver dependencies; one store also persists WSAA tickets.

Declared type widenings: client credential fields are optional and discovered from the environment; `ArcaClientConfig` gains `store`; `IssueOptions` gains `idempotencyKey`; `VouchersService` gains `cancel`, which hand-built typed mocks must implement. `issue()` without an idempotency key is unchanged.
