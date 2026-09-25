---
"facturas": minor
---

Tidy the public surface before launch.

- The WSFE catalog methods (`getSalesPoints()`, `getVoucherTypes()`, `getDocumentTypes()` and the rest) and `wsmtxca.getSalesPoints()` take their options argument optionally, so `client.wsfe.getSalesPoints()` type-checks.
- The CLI takes `--cuit` in every command. `check` and `issue` no longer accept `--tax-id`.
- `ArcaFiscalService` is gone. Use `IssuanceService`, the same `"wsfe" | "wsmtxca"` union.
- `WsfeAuthorizeVoucherInput` and `WsmtxcaAuthorizeVoucherInput` are now `WsfeIssueInput` and `WsmtxcaIssueInput`, after the `issue()` method they feed.
- `resolveArcaEnvironment()` is removed. Pass `"test"` or `"production"` directly.
