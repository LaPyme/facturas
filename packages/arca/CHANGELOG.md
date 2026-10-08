# facturas

## 0.23.1

### Patch Changes

- 0ce914d: Fix FCE credit and debit notes for services and products with services when annulment is false. Preserve the original service dates without copying its payment due date, which ARCA rejects with WSFE error 10175. Apply the same rule to previews, issuance and explicit optional field 22 with value N.

## 0.23.0

### Minor Changes

- b952dcd: `buildVoucherDocument()` arma, sin I/O, todo lo que el PDF de un comprobante autorizado tiene que mostrar según la RG 1415, la RG 4291, la RG 4892 y la RG 5614: letra y código, número, emisor y receptor con sus leyendas de condición frente al IVA, líneas que suman exactamente lo autorizado, IVA por alícuota en la clase A, el bloque de transparencia fiscal en la clase B, tributos, CAE, QR y la leyenda de la Ley 27.618 en una factura A a un monotributista. Toma el comprobante autorizado, los mismos `items` de la emisión y los datos del emisor, y tira `ArcaInputError` si falta un dato obligatorio o si los ítems no suman lo autorizado. Arma también los comprobantes A con leyenda `OPERACIÓN SUJETA A RETENCIÓN` y `PAGO EN CBU INFORMADA` de la RG 5762, e imprime en la clase A los códigos de las observaciones con las que ARCA autorizó el comprobante. Todavía no arma comprobantes FCE. La guía nueva es [Comprobante impreso](https://facturas-sdk.dev/guides/printed-voucher).
  
  `IssuedVoucher.totals` trae el dinero autorizado en centavos: total, neto gravado, no gravado, exento, IVA, tributos, una fila por alícuota de IVA y el detalle de los tributos, tanto en una autorización directa como recuperada.

## 0.22.1

### Patch Changes

- 1198df0: Una Factura E de bienes emitida sin `incotermsDetail` ahora se recupera como `authorized`. `FEXGetCMP` devuelve `Incoterms_Ds` como `"0"` cuando el comprobante se mandó sin ese detalle, y la recuperación lo comparaba contra el detalle ausente de la reserva: si se perdía la respuesta de `FEXAuthorize`, un reintento o `recover()` devolvía `conflict` aunque el comprobante fuera el propio. `lookup()` ahora lee ese `"0"` como `incotermsDetail` ausente. Lo reportó @juansegnana en #108.

## 0.22.0

### Minor Changes

- 46fd6bc: Factura E de exportación por WSFEX, para bienes y servicios. `issue()` la emite cuando el input trae `export`, `issueCreditNote()` e `issueDebitNote()` emiten notas E cuando `for` apunta a un comprobante 19, 20 o 21, y `lookup()` y `lastAuthorized()` consultan esos tipos en WSFEX. Con `idempotencyKey` la emisión usa el `Id` de requerimiento de WSFEX y un lock por CUIT. `client.wsfex` expone las tablas de referencia y la cotización de ARCA. Lo propuso @juansegnana en #99.

### Patch Changes

- 9e2ee5a: Un `issue()` con `idempotencyKey` cuya clave ya tiene reserva reenvía lo guardado sin volver a derivar la factura. Antes, una factura de servicios sin `date` con `service.dueDate` de hoy no se podía reintentar al día siguiente: la derivación tiraba `ArcaInputError` antes de llegar a la reserva. El input se copia al entrar, así que cambiar el objeto durante la llamada no cambia lo que se manda ni lo que se guarda. Un reintento que reenvía informa los `amounts` del pedido guardado, como `recover()`.
- c2f11e9: El mensaje de `ArcaLockTimeoutError` ya no incluye la clave del lock, que lleva el CUIT del contribuyente. Así, una aplicación que loguea o guarda `error.message` no lo expone. Para distinguir el caso alcanzan `code` y `reason`.
- 57034a2: El QR de un comprobante a consumidor final sin identificar ahora incluye `tipoDocRec: 99` y `nroDocRec: 0`. Sin esos campos, la página de constatación de ARCA dejaba el receptor vacío y había que cargarlo a mano. El QR lleva siempre el documento que se le mandó a ARCA. Lo reportó @santigiuf en #83.
- 118f534: El diagnóstico de `coe.alreadyAuthenticated` en `npx facturas check` ya no dice que hay que esperar hasta 12 horas: ARCA acepta un login nuevo unos minutos después del anterior, 2 en producción y 10 en homologación.

## 0.21.0

### Minor Changes

- f2db2a3: Una llamada que espera el lock de la secuencia ahora deja de esperar cuando vence su `abortSignal`. Antes la espera lo ignoraba y podía durar hasta 120 segundos. Al rendirse, por espera máxima o por `abortSignal`, lanza `ArcaLockTimeoutError` con `code: "ARCA_LOCK_TIMEOUT"` y `reason` `"held"` o `"aborted"`, en vez de un `ArcaConfigurationError` que había que reconocer por el mensaje. En los dos casos no se reservó ni se envió nada, así que la misma llamada se puede repetir. El lock de los tickets WSAA puede lanzar el mismo error con `reason: "held"`, y tampoco envió nada a ARCA.
  
  `withLock` del store acepta un tercer argumento opcional, `{ signal }`, con el tipo `ArcaLockOptions`. Los stores incluidos lo respetan. Un store propio que lo ignora sigue funcionando, pero su espera no se corta con el `abortSignal`.

## 0.20.5

### Patch Changes

- 0615816: Una idempotencyKey rechazada ya no recupera el CAE de otra venta que tomó su número. Si ARCA rechazó todos los envíos de la clave, el rechazo queda guardado en la reserva, y el reintento y `recover()` informan un conflicto si aparece un comprobante en ese número. Si un envío anterior quedó sin respuesta, el rechazo no se guarda, porque ese envío puede haber llegado. El conflicto que encuentra el primer envío de una clave queda guardado siempre. Sin `withLock`, un doble envío de la misma clave puede dejar su propio CAE como conflicto: conciliá ese comprobante a mano. Hay otras diferencias sin `withLock`, que se detallan en la guía "Evitar comprobantes duplicados". Actualizá todos los procesos que comparten un store: las versiones anteriores ignoran el rechazo guardado.
- fb53428: Valida los identificadores enteros de las respuestas SOAP sin truncar ni convertir valores mal formados. WSMTXCA conserva el CAE y la evidencia de una emisión con número inválido como `indeterminate` con `reason: "invalid_response"`, para poder conciliarla con `recover()` sin reenviar. Esto también se aplica a una respuesta `R` con número mal formado, que antes podía clasificarse como `rejected`.
  
  Las consultas `consultarComprobante` de WSMTXCA y `FECompConsultar` de WSFE rechazan números, puntos de venta y tipos inválidos con `ArcaInvalidSoapResponseError`. Los campos opcionales ausentes siguen omitidos. En WSFE, `CbteDesde` o `CbteHasta` debe aportar el número obligatorio del comprobante. Si faltan ambos se rechaza la respuesta, en lugar de inventar el cero, y un extremo válido no oculta otro presente mal formado.
  
  Los puntos de venta de WSMTXCA y WSFE rechazan toda la respuesta si una entrada no tiene un número válido, en lugar de descartarla o inventar el cero. Los catálogos numéricos de WSFE también rechazan identificadores ausentes o mal formados y siguen aceptando un cero explícito. Se aceptan enteros decimales dentro del dominio del campo, incluidos ceros iniciales y espacios exteriores. Un valor presente `null` o vacío es inválido.

## 0.20.4

### Patch Changes

- c453398: Permite completar el certificado o la clave encontrados por el CLI con el otro valor pasado por flag o variable de entorno.
  
  `issue` usa la misma resolución de credenciales para detectar el entorno y
  rechaza producción antes de iniciar la autenticación.
- 6881926: Las consultas de Padrón ahora devuelven `ArcaAuthenticationError` ante los
  rechazos de autenticación del login de WSAA o de la consulta al servicio.
  Conservan el motivo, el servicio y la operación, sin agregar reintentos.

## 0.20.3

### Patch Changes

- 089925d: Corrige el enlace a la guía de inicio que muestra `facturas init`.
- e8edf97: La marca de la secuencia guarda en `issuerTaxId` el CUIT del emisor que la creó. Si dos emisores con certificados distintos representan al mismo contribuyente y comparten store, la barrera encuentra la reserva del otro y ya no le da su número ni su CAE a otra clave. La barrera consulta esa reserva con su CUIT representado o, si no lo tiene, con el del contribuyente dueño de la secuencia, así un contador no deja un conflicto ajeno en la clave del contribuyente que emite con su propio certificado. `lookup` suma `byTaxId` en `blocked` y `superseded` para nombrar al emisor de `by`.
  
  Una marca vieja sin `issuerTaxId`, o un proceso que todavía corre la versión anterior, deja el hueco abierto hasta que se actualicen todos los procesos que comparten el store.
- ebb471a: Las preguntas interactivas de `facturas issue --json` se muestran en stderr para que stdout contenga solamente el resultado JSON.

## 0.20.2

### Patch Changes

- edeacf1: Normalize the foreign-currency cancellation flag in WSFE and WSMTXCA lookup results. Ignore the flag on peso vouchers so credit and debit notes can be prepared and uncertain issuance outcomes can be recovered without a false identity conflict. Preserve valid foreign-currency flags, validate WSMTXCA values, and retain raw provider evidence for diagnostics.
- b95f935: WSMTXCA valida el último número autorizado igual que WSFE. Rechaza respuestas sin un entero decimal explícito entre 0 y 99.999.999, como `"12abc"` o `"1.5"`, con `ArcaInvalidSoapResponseError`. Una respuesta sin número, que antes lanzaba `ArcaServiceError` ("WSMTXCA did not return the last authorized voucher number"), ahora también lanza `ArcaInvalidSoapResponseError` ("Invalid WSMTXCA last authorized number").

## 0.20.1

### Patch Changes

- 199cee8: Rechaza respuestas WSFE sin un último número autorizado explícito y válido.

## 0.20.0

### Minor Changes

- 46b0525: Expose the date window, accept issuer ids and return the QR payload.
  
  - A voucher date outside ARCA's window now throws `ArcaInputError` with `code: "ARCA_INPUT_DATE_OUTSIDE_WINDOW"` instead of `ARCA_INPUT_INVALID_VALUE`, and carries `window: { from, to }` in `YYYY-MM-DD`. `field` stays `"date"`. `toArcaSafeErrorMetadata()` keeps `window`.
  - New `voucherDateWindow({ voucherType, concept?, service?, now? })` returns the same window with no I/O, for example to bound a date picker.
  - `issuer` accepts ARCA's condition ids `1`, `6`, `4` and `15` wherever it accepts `"responsable_inscripto"`, `"monotributo"`, `"exento"` and `"no_alcanzado"`, like `to.condition` already did. The new `IssuerConditionId` type names them, and an idempotency key replays the same voucher whichever spelling the retry uses.
  - An authorized `voucher` carries `qrPayload`, the JSON its `qr` URL encodes, whenever it carries `qr`.
  - New `describeVoucherType(voucherType)` returns `{ family, voucherClass, kind }` for any invoice or note type the SDK issues.
  - The docs state that an `ArcaInputError` from `issue()`, `issueCreditNote()` or `issueDebitNote()` means that call sent no authorization request, and when a sales point needs `{ service: "wsmtxca" }`.
- 46b0525: Follow the WSMTXCA manual for the receiver document, voucher classes and item codes.
  
  - An unidentified final consumer (document type 99) no longer sends `codigoTipoDocumento` or `numeroDocumento` to WSMTXCA, per rules 108 and 128. The result header still reports `documentType: 99` and `documentNumber: "0"`, and recovery accepts a consultation that omits the document or echoes 99/0, whole or in part. Credit and debit notes treat such an original as 99/0 the same way.
  - `{ service: "wsmtxca" }` with a class C voucher throws `ArcaInputError` with `field: "voucherType"` before any call (rule 100), including a note whose original is class C and an invoice whose items would fail line checks.
  - WSMTXCA items need `matrixCode` and `matrixUnits` unless `unit` is 97 or 99. `matrixUnits` is a whole number from 1 to 999999, the two travel together, and `code` is at most 50 characters (rules 500–505 and 520). Violations throw `ArcaInputError` naming the item and field before any call.
  - New `ARCA_WSMTXCA_GENERIC_CODES` lists ARCA's 13 generic item codes with their descriptions, for concepts that have no GTIN.

## 0.19.0

### Minor Changes

- 544623e: Check ARCA's date window before sending, and read the last authorized number on either service.
  
  - `preview()`, `previewCreditNote()`, `previewDebitNote()`, `issue()`, `issueCreditNote()` and `issueDebitNote()` throw `ArcaInputError` with `field: "date"` when the voucher date falls outside the window ARCA accepts, counted from today in Argentina: products 5 days either side without running into the next month, services 10, and on WSFE an FCE invoice 5 days before through 1 after and an FCE note no earlier than 5 days before. A retry with the same `idempotencyKey` still returns what ARCA already authorized.
  - New `arca.lastAuthorized({ salesPoint, voucherType }, options)` returns the last number ARCA authorized on WSFE or WSMTXCA, `0` when none.

## 0.18.0

### Minor Changes

- d5c1d8e: Return data callers previously had to derive or fetch themselves.
  
  - `preview()`, `previewCreditNote()` and `previewDebitNote()` return `date`, the voucher date as `YYYY-MM-DD`.
  - `wsfe.getSalesPoints()` returns the WSMTXCA shape: `blocked` is a boolean and `deletedAt` a `YYYY-MM-DD` date, absent while the point is active.
  - New `arca.lookup(voucher, options)` consults one authorized voucher on WSFE or WSMTXCA and returns a `VoucherSummary` or `null`. It replaces `wsfe.getVoucherInfo()` and `wsmtxca.getVoucher()`, which are removed with `WsmtxcaVoucherLookupResult`.
  - `padron.getTaxpayerDetails()` returns `address`, `activities` and the constancia's `errors`.
  - `toArcaSafeErrorMetadata()` keeps each error class's typed fields, such as `field`, `reason`, `service`, `operation` and `serviceCode`.

### Patch Changes

- ac16e98: Describe the package as a TypeScript SDK in the README and npm description, and drop the Stripe comparison from the retries section.

## 0.17.0

### Minor Changes

- e498ac2: Tidy the public surface before launch.
  
  - The WSFE catalog methods (`getSalesPoints()`, `getVoucherTypes()`, `getDocumentTypes()` and the rest) and `wsmtxca.getSalesPoints()` take their options argument optionally, so `client.wsfe.getSalesPoints()` type-checks.
  - The CLI takes `--cuit` in every command. `check` and `issue` no longer accept `--tax-id`.
  - `ArcaFiscalService` is gone. Use `IssuanceService`, the same `"wsfe" | "wsmtxca"` union.
  - `WsfeAuthorizeVoucherInput` and `WsmtxcaAuthorizeVoucherInput` are now `WsfeIssueInput` and `WsmtxcaIssueInput`, after the `issue()` method they feed.
  - `resolveArcaEnvironment()` is removed. Pass `"test"` or `"production"` directly.

### Patch Changes

- d3c8ecd: Point the README links at facturas-sdk.dev, fill in the package homepage, author and keywords, and document every error code, including `ArcaInvalidSoapResponseError` and the `ArcaInputError` codes.

## 0.16.1

### Patch Changes

- 0c18e1a: Use the canonical sample CUIT in the CLI's source comments.

## 0.16.0

### Minor Changes

- 09950b9: Expose a normalized fiscal `header` on previews and authorized vouchers, including direct and recovered invoice and note outcomes.

## 0.15.0

### Minor Changes

- a7cb28a: - `IssuedVoucher.date` and `caeExpiry` are `YYYY-MM-DD`, and `VoucherSummary` (note `originals`, conflict `found`, matched `lookup`) carries money in minor units and dates in `YYYY-MM-DD`, like the input. Only `request` keeps ARCA's shape. Settled conflict records are written `v: 2` with the normalized summary; `v: 1` records are normalized on read.
  - `IssuedVoucher.qr` is the URL the printed voucher's QR must encode, per ARCA's QR specification. `arcaQrUrl()` and `arcaQrPayload()` build it from stored data.
  - `padron.getTaxpayerDetails()` returns `condition`, the receiver condition derived from the active IVA registrations, and `taxes`. A constancia that says the taxpayer does not exist returns `null`.
  - WSAA tickets in a `store` are sealed with AES-256-GCM under a key derived from the private key. The key prefix is `arca:v2:wsaa:`; a valid plaintext ticket left under `arca:v1:wsaa:` by an earlier release is resealed on first read and left in place until it expires, and the ticket lock keeps the `arca:v1:wsaa:` key so mixed-version rollouts still serialize logins.
  - `issue()`, `issueCreditNote()` and `issueDebitNote()` resubmit once with a fresh ticket after an `authentication_rejected` indeterminate. `forceRefresh: true` disables that retry.
  - `CreditNoteInput.to.condition` supplies the receiver condition when the consulted original does not report one; it must agree when it does.
  - `wsfe.getLastVoucher()` and `ARCA_CURRENCIES` are removed. Use `getNextVoucherNumber()`, `ISO_CURRENCIES` and `ARCA_CURRENCY_IDS`.
  - The npm description now says what the README says.

## 0.14.0

### Minor Changes

- ae91d6b: Require Node.js 22 or later. Node.js 20 reached end of life on 2026-04-30, so the package now builds for Node.js 22 and CI tests Node.js 22 and 24. `fast-xml-parser` is raised to `^5.11.1` and `node-forge` to `^1.4.0`, the versions CI tests.

## 0.13.0

### Minor Changes

- 9baa8ef: The public cancellation option is `abortSignal`. Optional high-level fiscal evidence is selected with `include.request` and `include.rawResponse`, and exposed as `request` and `rawResponse`. The requested fiscal request is available across authorized, rejected, indeterminate, and conflict outcomes, while persisted reservations remain backward compatible.
- 5408372: - `for` on `issueCreditNote()`, `issueDebitNote()`, `previewCreditNote()` and `previewDebitNote()` takes one original or a non-empty list, and the note's limit becomes the sum of the originals' totals. `all: true` still takes a single original.
  - `NotePreview.original` is now `originals`, the consulted vouchers in input order.
  - `items` carries the line detail and `details` is gone. `WsmtxcaLine` replaces `VoucherItemDetail` and `ItemLine` is the new line input type.
  - `{ service: "wsmtxca" }` requires `description`, `quantity`, `unit` and `unitPrice` on every item, and refuses a reviewed `amounts` breakdown.
  - `include: { exactInput: true }` is now `include: { request: true }`, the result field is `request`, and `ExactIssueInput<S>` is now `IssueRequest<S>`.
  - `buildFacturaB()`, `buildFacturaC()` and their types are removed. The high-level API is the normal entry point, while `client.wsfe`, `client.wsmtxca` and `client.padron` remain the provider-specific modules.
  - Existing WSMTXCA `v: 2` reservations with `sent.details` remain recoverable after the `items` migration, including their exact number and optional-discount default.
  - WSMTXCA line rounding is distributed within ARCA's per-line tolerance, zero-rate lines keep zero VAT, full notes preserve authorized historical one-cent differences, duplicate note originals are rejected, and FCE association limits follow the selected provider for both typed and raw optional-field input.

## 0.12.4

### Patch Changes

- 0e46766: Prevent concurrent file-store contenders from deleting a newly claimed lock while they recover an expired holder.
- fc23516: `recover()` now reports `ARCA_INPUT_RESERVATION_NOT_FOUND` when its idempotency key has no stored reservation, so callers do not need to match the English message. Linked credit-note and debit-note previews now return the normalized, raw-free original voucher that the SDK consulted; period-note previews remain consultation-free and have no original.

## 0.12.3

### Patch Changes

- 0e2eae6: WSMTXCA requests without other tributes no longer send `importeOtrosTributos: 0`. ARCA rejects that amount without an `arrayOtrosTributos` detail with error 114 ("Si informa el Importe de Otros Tributos debe informar el detalle de los mismos"), so every detailed invoice without tributes was refused since 0.12.0. The amount and the detail now travel together or not at all, and a non-zero tribute amount without details is rejected as invalid input before any request.

## 0.12.2

### Patch Changes

- f3007e2: A superseded key no longer reports `conflict` when the voucher at its number belongs to the key that took the sequence. After a crash between reservation and submission, the next claim proves the number empty, takes it and authorizes within seconds; until now the crashed key's retry found that voucher and asked for manual reconciliation. It now returns `indeterminate` with `lookup: { kind: "superseded", by }`, the same answer it gave while the number was still empty, so the caller issues under a new key. `conflict` remains when the successor, or a key that took the number from it in turn, recorded a conflict there: a stranger reached the number and the voucher must be attributed by hand.

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

  Reservations now record `operation: "creditNote"`. A stored 0.9 record with `operation: "cancel"` is rejected as an invalid structure with `ArcaConfigurationError`. A keyed replay of a credit note consults only the reserved note and reports `amounts` from the stored request, so `computedTotal` equals `sentTotal` and `vatAdjustment` is `0` on that path.

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
