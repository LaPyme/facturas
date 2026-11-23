---
"facturas": patch
---

WSFE y WSFEX de producción ofrecen solo suites ECDHE en lugar de bajar OpenSSL a `SECLEVEL=0`. Funciona en Node.js y en Bun, que rechazaba `DEFAULT@SECLEVEL=0`, y evita la clave DH chica de `servicios1.afip.gov.ar`.
