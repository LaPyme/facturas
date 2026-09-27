---
"facturas": minor
---

Expose the date window, accept issuer ids and return the QR payload.

- A voucher date outside ARCA's window now throws `ArcaInputError` with `code: "ARCA_INPUT_DATE_OUTSIDE_WINDOW"` instead of `ARCA_INPUT_INVALID_VALUE`, and carries `window: { from, to }` in `YYYY-MM-DD`. `field` stays `"date"`. `toArcaSafeErrorMetadata()` keeps `window`.
- New `voucherDateWindow({ voucherType, concept?, service?, now? })` returns the same window with no I/O, for example to bound a date picker.
- `issuer` accepts ARCA's condition ids `1`, `6`, `4` and `15` wherever it accepts `"responsable_inscripto"`, `"monotributo"`, `"exento"` and `"no_alcanzado"`, like `to.condition` already did. The new `IssuerConditionId` type names them.
- An authorized `voucher` carries `qrPayload`, the JSON its `qr` URL encodes, whenever it carries `qr`.
- New `describeVoucherType(voucherType)` returns `{ family, voucherClass, kind }` for any invoice or note type the SDK issues.
- The docs state that an `ArcaInputError` from `issue()`, `issueCreditNote()` or `issueDebitNote()` means that call sent no authorization request, and when a sales point needs `{ service: "wsmtxca" }`.
