---
"facturas": minor
---

One input vocabulary for issuing, and notes that can correct more than one voucher.

`issueCreditNote()`, `issueDebitNote()`, `previewCreditNote()` and `previewDebitNote()` take either one original or a non-empty list in `for`. Every original is consulted, every one reaches WSFE as an associated voucher, and the limit that a note may not exceed its original becomes the sum of the originals' totals. The note holds one value of each field it inherits — class and family, receiver, currency and rate, concept and service dates — so the originals must agree on all of them; one that differs throws `ArcaInputError` naming the field. `all: true` still takes a single original, because a full note of several has no single total. `NotePreview.original` is now `originals`, the consulted vouchers in input order.

`items` carries the line detail and `details` is gone. Each item may describe its own line — `description`, `quantity`, `unit`, `unitPrice`, `discount`, `code`, `matrixCode`, `matrixUnits` — beside the money it already carried. WSFE ignores those fields and derives the same header as before; WSMTXCA derives `arrayItems` from the same items, taking the VAT condition from the item's rate, the item amount with VAT included and the VAT amount on class A lines, and reconciling per-line VAT against the grouped Half Even arithmetic. The header and the lines can no longer describe different money, so their agreement is an SDK invariant that throws `ArcaError` instead of caller validation. WSMTXCA requires `description`, `quantity`, `unit` and `unitPrice` on every item and names the item index and field when one is missing, and `{ service: "wsmtxca" }` with a reviewed `amounts` breakdown is refused because it has no lines. `VoucherItemDetail` is replaced by `WsmtxcaLine`, the WSMTXCA lookup's read side and the derived provider row; `ItemLine` is the new line input type. Reservations record those lines instead of the old details.

`include: { exactInput: true }` is now `include: { sent: true }`, named after the field it adds, and `ExactIssueInput<S>` is now `IssueRequest<S>`.

`buildFacturaB()` and `buildFacturaC()` and their types are removed, along with the four examples that issued through the transport modules. `docs/capa-exacta.md` is removed too: the method reference for `client.wsfe`, `client.wsmtxca` and `client.padron` lives in `docs/referencia.md` under "Módulos de transporte", which is what those modules are — reads, catalogs, server status and padrón under the facade, not a second way to issue a voucher.
