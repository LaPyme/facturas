# @facturas/pdf

## 0.25.0

### Minor Changes

- 0e7bd5f: `buildVoucherDocument()` acepta `globalDiscount`: un descuento sobre todo el comprobante que ya se restó de los ítems al emitir. En las clases A y B va por id de alícuota, como las filas de IVA autorizadas, sin IVA en la A y con IVA en la B; en la C es un solo importe. Los ítems son los de antes del descuento y el SDK no lo reparte: comprueba por alícuota que las líneas menos su descuento den la base autorizada, y rechaza con el `field` de la alícuota que no cierra. `totals.globalDiscount` trae la suma. `@facturas/pdf` lo imprime en un renglón "Descuento global" antes del neto gravado en la clase A y antes del subtotal en las B y C, y los importes negativos llevan el signo antes de la moneda: `-$ 12,00`.

### Patch Changes

- Updated dependencies [0e7bd5f]
  - facturas@0.25.0

## 0.24.0

### Minor Changes

- df2278d: Nuevo paquete `@facturas/pdf`: dibuja en A4 el modelo de `buildVoucherDocument()` con la ubicación de datos de la RG 1415, Anexo II, Apartado B. Los bloques fiscales son fijos: el recuadro del emisor con la letra en el centro, el receptor, las líneas, el IVA por alícuota en la clase A, el bloque de transparencia fiscal abajo a la izquierda y el CAE con su vencimiento en 12 puntos y el QR abajo a la derecha. El QR se dibuja en vectores y es un link a la constatación de ARCA, y en un comprobante largo el recuadro del emisor se repite en cada hoja. `renderVoucherPdf()` toma el modelo con un logo, notas y un tema de tipografía y colores, o un `<Voucher>` armado con sus espacios fuera de las zonas fiscales: `<VoucherBrand>` para el logo, `<VoucherIssuerDetails>` y `<VoucherReceiverDetails>` para datos de contacto, `<VoucherAside>` junto a los totales y `<VoucherNotes>` antes de las líneas. Rechaza cualquier otra composición antes de dibujar. Los totales, las leyendas y el CAE pasan juntos de hoja, así que el CAE nunca queda solo; las líneas y las notas pueden seguir en la hoja siguiente. `facturas` y `@facturas/pdf` salen siempre con la misma versión.

### Patch Changes

- Updated dependencies [df2278d]
  - facturas@0.24.0
