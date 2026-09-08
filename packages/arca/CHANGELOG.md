# facturas

## 0.12.1

### Patch Changes

- b70db71: Write the sequence marker before the reservation, so no reservation can exist that the barrier does not see. In 0.12.0 a coordinated claim created the reservation first and the marker second; a store failure or a crash between the two left a reservation on a number the barrier never learned about. The next key read the same number from ARCA and wrote it, and `recover()` of the orphan reservation found that voucher, matched its fiscal fields and reported it `authorized` with the other key's CAE. Now a loss before the marker writes nothing, and a loss between the marker and the reservation leaves a marker that names a key without a reservation: that key never submitted, so the barrier hands the number over without consulting ARCA and `recover()` throws `ArcaInputError` because there is nothing to recover; retry under the same key. A loss after the reservation is consulted by the barrier as any unresolved claim: the number is superseded only when ARCA proves it empty, and the orphan key then answers `conflict`, never `authorized`. The claim also re-reads its key under the sequence lock, so a same-key call that lost the race replays the winner instead of reading a number it could have written into the marker. The barrier now takes the reserved number from the reservation record rather than the marker. Record formats are unchanged.

## 0.12.0

### Minor Changes

- 969d854: Coordinate the sales point sequence through the store and add a deadline to the facade. `createPostgresStore()`, `createRedisStore()` and `createFileStore()` now provide `withLock` with no new dependency: a lease row with a conditional `UPDATE` on Postgres, which survives a transaction-mode pooler; `SET NX PX` with a verified release on Redis, where a client without `del` keeps no lock; a lock directory with staleness on files. When the configured store provides `withLock`, `issue()`, `issueCreditNote()` and `issueDebitNote()` take the sequence lock, clear the barrier left by the last claim, read the next number, reserve it, submit and resolve before releasing. Two concurrent calls on one sales point and voucher type now take consecutive numbers and write once each. A claim nobody resolved holds the sequence: the next call answers `indeterminate` with `lookup: { kind: "blocked", by: <key> }` and writes nothing until `recover()` settles that key. When the barrier proves the number is free — the consultation finds nothing and ARCA's next number is still that one — it records the old key as `superseded` and hands the number over, so a late retry of that key consults once, never resends, and answers `conflict` or `indeterminate` with `lookup: { kind: "superseded", by }`. A replay holds the same sequence lock as a claim. Without a store, or with a custom store that provides no `withLock`, behavior is unchanged. The facade options take `signal`, any `AbortSignal`, threaded through the WSAA login, the submission and every consultation; an abort after the write was sent answers `indeterminate` with `lookup: { kind: "aborted" }`, keeps the reservation and leaves it for `recover()`. No `timeoutMs` was added.

### Patch Changes

- 5822ade: A WSFE 10016 rejection on a number the same call reserved is never resolved by comparing fiscal fields: the consultation returns `conflict` when another voucher occupies the number and `rejected` when the number is empty. Two sales with identical fiscal data, the common retail case, matched on every field and the loser was reported `authorized` with the winner's CAE. Identity matching stays for a pre-existing reservation, the only case where the number can be this key's own earlier write. Every `conflict` is now recorded once with `add` under `arca:v1:settled:{environment}:{taxId}:{idempotencyKey}`, so a keyed retry and `recover()` repeat it with zero provider calls. Reservation records are untouched.

## 0.11.0

### Minor Changes

- c22a730: Complete high-level WSFE and WSMTXCA issuance for invoices, debit notes and credit notes. Add tributes, reviewed fiscal breakdowns, A con leyenda and FCE families, extended receiver identities, mixed concepts, foreign currency payment, detailed WSMTXCA items, period notes, note previews and read-only recovery. Support externally reserved numbers and preserve provider-aware keyed reservations across retries. Extend consultation identity checks to associations and fiscal extensions. Existing ordinary WSFE calls and stored reservations remain supported. Reservations that carry a WSMTXCA provider or detailed items are written as version-2 records, which 0.10 refuses to read instead of replaying them through WSFE; plain WSFE reservations stay version 1.
- 1a291ae: Add the `facturas` CLI: `init` generates the key and CSR and tells you where to save the certificate, `check` diagnoses each ARCA layer, and `issue` emits one homologation invoice. `check` and `issue` resolve their inputs from flags, then environment variables, then the `arca-<entorno>.crt` and `.key` files in the directory, taking the CUIT from the certificate, so the first run after `init` needs no configuration at all.

### Patch Changes

- ff46daf: `init` now suggests an alphanumeric alias (`facturasTest`, `facturasProduction`), because ARCA's alias fields reject hyphens; anything else in `--name` is dropped from the alias while the CSR common name keeps it.
- f795dc1: Hand the CSR and the certificate over inside the terminal. `init` now copies the CSR to the system clipboard in homologación, with the tool the platform already ships and no shell, and prints the request inline when there is none, so step 3 in ARCA is one paste either way. It then asks for the certificate right there, verifies that it belongs to the key it just wrote and to the CUIT it was given before writing `arca-<entorno>.crt`, and reports its expiry; `--no-clipboard`, `--no-paste`, Ctrl-C and a run without a terminal all keep the previous instructions. The new `npx facturas cert` command takes that same paste on its own, for the certificate you saved for later.
- c325fe6: `npx facturas issue` now reports the result as `Factura C emitida - 00001-00000009   CAE …   Vto. CAE …   ARS 1,00`, so it reads as an issued voucher and not a dry run, and the sales point is padded to five digits like ARCA prints it.
- 69c6a07: `wsfe.getSalesPoints()` returns an empty list when WSFE answers error 602 (Sin Resultados), which is how ARCA reports a taxpayer with no sales point for web services. Previously it threw `ArcaServiceError`, which made `npx facturas check` fail its WSFE layer on a fresh homologación CUIT. Other errors still throw.

## 0.10.0

### Minor Changes

- ca634dc: Replace `cancel()` with `issueCreditNote()` and add `preview()`.

  `client.issueCreditNote(input, options)` writes an ordinary credit note against an authorized invoice, in one of two explicit modes: `{ for, items, total? }` credits chosen lines through the same amount pipeline as `issue()`, and `{ for, all: true }` mirrors the whole original line by line, which is what 0.9's `cancel()` did. The mode is required: neither, both, or `all` other than the literal `true` throws `ArcaInputError` with `ARCA_INPUT_INVALID_VALUE` before any I/O, so a forgotten field cannot credit the whole invoice. Everything except the credited lines, the note's own `salesPoint` and its `date` comes from the original: class and note type (1 → 3, 6 → 8, 11 → 13), receiver, currency and rate, concept and service dates. The note may not exceed the original's total, and the SDK does not track earlier notes against an original. The new `CreditNoteInput` type is exported.

  `client.preview(input, options?)` is synchronous and pure: it derives what `issue()` would send with no store, WSAA, SOAP or next-number call, and returns `{ voucherClass, voucherType, amounts, request }`, where `request` is the exact `WsfeVoucherInput` minus the voucher number. It throws exactly the input errors `issue()` throws before its first call. The new `IssuePreview` type is exported.

  Removals. `client.cancel()` and `VouchersService.cancel` are gone with no alias: `cancel(target)` becomes `issueCreditNote({ for: target, all: true })`. The exact layer loses the aliases and throwing methods deprecated in 0.9.0: `wsfe.authorizeVoucherOutcome()`, `wsmtxca.authorizeVoucherOutcome()`, `wsfe.authorizeVoucher()`, `wsmtxca.authorizeVoucher()` and `wsfe.createNextVoucher()`, together with the `WsfeAuthorizationResult` and `WsmtxcaAuthorizationResult` types they returned. Use `client.issue()`, or reserve a number and call `wsfe.issue()`.

  Reservations now record `operation: "creditNote"`. A stored 0.9 record with `operation: "cancel"` is rejected as an invalid structure with `ArcaConfigurationError`; no released consumer wrote one, since `cancel()` shipped in 0.9.0 without adoption. A keyed replay of a credit note consults only the reserved note and reports `amounts` from the stored request, so `computedTotal` equals `sentTotal` and `vatAdjustment` is `0` on that path.

  Declared type widening: `VouchersService` gains `issueCreditNote` and `preview` and loses `cancel`; hand-built typed mocks must follow. `issue()` is unchanged in signature, behaviour and results.

## 0.9.0

### Minor Changes

- dadb5d4: Add durable idempotency keys for invoice issuance and full associated credit notes through `cancel()`. Bundle Postgres, Redis, file and memory stores without runtime driver dependencies; one store also persists WSAA tickets.

  The facade moves onto the client: `client.vouchers.issue()` is now `client.issue()` and the new credit note is `client.cancel()`. On the exact layer, `wsfe.authorizeVoucherOutcome()` and `wsmtxca.authorizeVoucherOutcome()` are renamed to `issue()`; the old names remain as deprecated aliases for one release. The throwing `authorizeVoucher()` methods and `createNextVoucher()` are deprecated and will be removed in the next minor release. `createArcaClient()` now throws when neither `environment` nor `ARCA_ENVIRONMENT` is set, instead of silently using `test`. A keyed retry whose reserved number is already occupied by a different voucher now returns `conflict` instead of `rejected`.

  Declared type widenings: client credential fields are optional and discovered from the environment; `ArcaClientConfig` gains `store`; `IssueOptions` gains `idempotencyKey`; `VouchersService` gains `cancel`, which hand-built typed mocks must implement. `issue()` without an idempotency key is unchanged.

## 0.8.0

### Minor Changes

- 6b7e79b: Add `client.vouchers.issue()` for single-writer A/B/C invoices from explicit
  issuer and receiver assertions and integer-minor-unit items. Group net/gross
  items by VAT rate with Round Half Even rounding; expose computed and sent totals
  and any bounded VAT adjustment. Derive receiver identification, currency,
  service dates and the RG 5866 final-consumer identification threshold.

  Return `authorized`, `rejected`, `indeterminate`, or `conflict` without retrying
  an authorization. Recover only after a complete identity match, expose the pure
  `matchWsfeVoucherIdentity()` helper, and extend consultation details with VAT,
  taxes and service dates. Evidence is raw-free unless explicitly included.

  All existing exports retain their names, signatures and runtime behavior,
  including the v0.7.1 builders. The one declared type widening is required
  `ArcaClient.vouchers`: hand-built typed client mocks must add this member.
  The SDK does not coordinate writers; serialize per represented taxpayer,
  sales point and voucher type, or use the exact API with durable attempts.

## 0.7.1

### Patch Changes

- ea2bf1a: Correct Factura B IVA calculations at exact half-cent boundaries to use ARCA's documented Round Half Even criterion.
- 0dc9adf: Restore the schema-required WSMTXCA SOAP field order so `authRequest` is serialized before each operation payload.

## 0.7.0

### Minor Changes

- 58d12a1: Add deterministic WSFE money handling and high-level Factura B/C builders. Receiver VAT condition is now required, exact amounts and exchange rates are validated and canonically serialized, input errors expose stable codes and field paths, builders accept integer minor units with ISO `ARS`/`USD` input and an `ARS` default, and the legacy `ARCA_CURRENCIES` export is deprecated without changing its values.
- d12a5b8: Establish the v0.7.0 safe diagnostics contract. `client.config` now exposes an immutable credential-free operational view, transport and invalid-SOAP errors replace full response bodies with bounded redacted metadata, parsed provider details are removed from public errors, and internal logger events receive only safe scalar diagnostics.
- 7c7bb9c: Add typed ARCA authentication failures and one proven-safe forced-refresh recovery attempt to authenticated convenience operations. Exact authorization outcome methods remain single-attempt and now expose safe authentication-rejection evidence; transport, parser, incomplete, contradictory, and generic service failures are never automatically resubmitted. Strengthen the packed runtime and declaration consumer contract for builders, currency constants, errors, and exact WSFE types.

## 0.6.1

### Patch Changes

- c2f7277: Reject encrypted PKCS#8 and legacy RSA private keys during configuration, preserve forced WSAA refresh intent under local concurrency, and reject caller-supplied WSMTXCA authentication fields before network work. Normalize omitted peso exchange rates to one, validate foreign exchange rates, add common ARCA voucher, document, receiver IVA condition, and VAT rate constants, and correct the invoice examples.

## 0.6.0

### Minor Changes

- b4006df: Add structured WSFE and WSMTXCA authorization outcomes, operation-scoped exact voucher lookup, corrected consultation fields, and source-level WSMTXCA sales-point support. Exact authorization now disables transport retries so uncertain callers can consult before resubmission.

## 0.5.2

### Patch Changes

- d4af327: Upgrade fast-xml-parser to the patched v5 line and refresh repository links before public announcement.
- d4af327: Publish ESM-only package entrypoints with explicit `.mjs` runtime files and default export conditions.

## 0.5.1

### Patch Changes

- Expose `forceRefresh` consistently on authenticated WSFE and WSMTXCA methods so callers can renew the service-specific WSAA Token Authorization before retrying auth failures.

## 0.5.0

### Minor Changes

- 6d09e04: add memory support for the arca client

### Patch Changes

- 0a2f1e2: bug fixes
