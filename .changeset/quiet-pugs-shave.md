---
"facturas": minor
---

- `for` on `issueCreditNote()`, `issueDebitNote()`, `previewCreditNote()` and `previewDebitNote()` takes one original or a non-empty list, and the note's limit becomes the sum of the originals' totals. `all: true` still takes a single original.
- `NotePreview.original` is now `originals`, the consulted vouchers in input order.
- `items` carries the line detail and `details` is gone. `WsmtxcaLine` replaces `VoucherItemDetail` and `ItemLine` is the new line input type.
- `{ service: "wsmtxca" }` requires `description`, `quantity`, `unit` and `unitPrice` on every item, and refuses a reviewed `amounts` breakdown.
- `include: { exactInput: true }` is now `include: { sent: true }`, and `ExactIssueInput<S>` is now `IssueRequest<S>`.
- `buildFacturaB()`, `buildFacturaC()` and their types are removed. `client.wsfe`, `client.wsmtxca` and `client.padron` are documented as the transport modules under the facade.
