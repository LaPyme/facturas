---
"facturas": minor
"@facturas/pdf": minor
---

Agregá ajustes con etiqueta y centavos con signo a `buildVoucherDocument()` con `adjustments: [{ label, amount }]`. En clases A/B el importe va por id de alícuota de ARCA, sin IVA en A y con IVA en B. En C es un solo importe. Las líneas conservan sus precios y cada alícuota se concilia con lo autorizado, junto con `globalDiscount` si lo hay.

El modelo incluye `totals.adjustments` y el PDF imprime cada etiqueta y su importe con signo antes del subtotal o importe neto gravado. Sirve para facturas y notas de crédito y débito. Sin ajustes, el modelo y el PDF conservan el comportamiento anterior. El campo singular `totals.adjustment` mantiene su uso como residuo de IVA de cabecera.
