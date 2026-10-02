---
"facturas": patch
---

El QR de un comprobante a consumidor final sin identificar ahora incluye `tipoDocRec: 99` y `nroDocRec: 0`. Sin esos campos, la página de constatación de ARCA dejaba el receptor vacío y había que cargarlo a mano. El QR lleva siempre el documento que se le mandó a ARCA. Lo reportó @santigiuf en #83.
