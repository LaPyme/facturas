---
"facturas": patch
---

Corregí la emisión de comprobantes exentos o no gravados: `Iva` y `Tributos` ya no se envían vacíos a `FECAESolicitar`, que ARCA rechazaba con el error 10018.
