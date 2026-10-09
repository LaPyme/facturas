---
"facturas": minor
"@facturas/pdf": minor
---

`buildVoucherDocument()` acepta `globalDiscount`: un descuento sobre todo el comprobante que ya se restó de los ítems al emitir. En las clases A y B va por id de alícuota, como las filas de IVA autorizadas, sin IVA en la A y con IVA en la B; en la C es un solo importe. Los ítems son los de antes del descuento y el SDK no lo reparte: comprueba por alícuota que las líneas menos su descuento den la base autorizada, y rechaza con el `field` de la alícuota que no cierra. `totals.globalDiscount` trae la suma. `@facturas/pdf` lo imprime en un renglón "Descuento global" antes del neto gravado en la clase A y antes del subtotal en las B y C, y los importes negativos llevan el signo antes de la moneda: `-$ 12,00`.
