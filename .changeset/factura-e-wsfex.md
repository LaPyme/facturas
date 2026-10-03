---
"facturas": minor
---

Factura E de exportación por WSFEX, para bienes y servicios. `issue()` la emite cuando el input trae `export`, `issueCreditNote()` e `issueDebitNote()` emiten notas E cuando `for` apunta a un comprobante 19, 20 o 21, y `lookup()` y `lastAuthorized()` consultan esos tipos en WSFEX. Con `idempotencyKey` la emisión usa el `Id` de requerimiento de WSFEX y un lock por CUIT. `client.wsfex` expone las tablas de referencia y la cotización de ARCA. Lo propuso @juansegnana en #99.
