---
"facturas": minor
"@facturas/pdf": minor
---

Nuevo paquete `@facturas/pdf`: dibuja en A4 el modelo de `buildVoucherDocument()` con la ubicación de datos de la RG 1415, Anexo II, Apartado B. Los bloques fiscales son fijos: el recuadro del emisor con la letra en el centro, el receptor, las líneas, el IVA por alícuota en la clase A, el bloque de transparencia fiscal abajo a la izquierda y el CAE con su vencimiento en 12 puntos y el QR abajo a la derecha. El QR se dibuja en vectores y es un link a la constatación de ARCA, y en un comprobante largo el recuadro del emisor se repite en cada hoja. `renderVoucherPdf()` toma el modelo con un logo, notas y un tema de tipografía y colores, o un `<Voucher>` armado con `<VoucherBrand>` y `<VoucherNotes>`, y rechaza cualquier otra composición antes de dibujar. `facturas` y `@facturas/pdf` salen siempre con la misma versión.
