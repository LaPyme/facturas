---
"facturas": minor
---

- `for` on `issueCreditNote()`, `issueDebitNote()`, `previewCreditNote()` and `previewDebitNote()` takes one original or a non-empty list, and the note's limit becomes the sum of the originals' totals. `all: true` still takes a single original.
- `NotePreview.original` is now `originals`, the consulted vouchers in input order.
- `items` carries the line detail and `details` is gone. `WsmtxcaLine` replaces `VoucherItemDetail` and `ItemLine` is the new line input type.
- `{ service: "wsmtxca" }` requires `description`, `quantity`, `unit` and `unitPrice` on every item, and refuses a reviewed `amounts` breakdown.
- `include: { exactInput: true }` is now `include: { sent: true }`, and `ExactIssueInput<S>` is now `IssueRequest<S>`.
- `buildFacturaB()`, `buildFacturaC()` and their types are removed. `client.wsfe`, `client.wsmtxca` and `client.padron` are documented as the transport modules under the facade.
- Existing WSMTXCA `v: 2` reservations with `sent.details` remain recoverable after the `items` migration, including their exact number and optional-discount default.
- WSMTXCA line rounding is distributed within ARCA's per-line tolerance, zero-rate lines keep zero VAT, full notes preserve authorized historical one-cent differences, duplicate note originals are rejected, and FCE association limits follow the selected provider for both typed and raw optional-field input.
