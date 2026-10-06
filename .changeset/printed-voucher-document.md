---
"facturas": minor
---

`buildVoucherDocument()` arma, sin I/O, todo lo que el PDF de un comprobante autorizado tiene que mostrar según la RG 1415, la RG 4291, la RG 4892 y la RG 5614: letra y código, número, emisor y receptor con sus leyendas de condición frente al IVA, líneas que suman exactamente lo autorizado, IVA por alícuota en la clase A, el bloque de transparencia fiscal en la clase B, tributos, CAE, QR y la leyenda de la Ley 27.618 en una factura A a un monotributista. Toma el comprobante autorizado, los mismos `items` de la emisión y los datos del emisor, y tira `ArcaInputError` si falta un dato obligatorio o si los ítems no suman lo autorizado. Todavía no arma comprobantes FCE ni con leyenda de retención. La guía nueva es [Comprobante impreso](https://facturas-sdk.dev/guides/printed-voucher).

`IssuedVoucher.totals` trae el dinero autorizado en centavos: total, neto gravado, no gravado, exento, IVA, tributos, una fila por alícuota de IVA y el detalle de los tributos, tanto en una autorización directa como recuperada.
