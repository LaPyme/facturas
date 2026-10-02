---
"facturas": patch
---

El mensaje de `ArcaLockTimeoutError` ya no incluye la clave del lock, que lleva el CUIT del contribuyente. Así, una aplicación que loguea o guarda `error.message` no lo expone. Para distinguir el caso alcanzan `code` y `reason`.
