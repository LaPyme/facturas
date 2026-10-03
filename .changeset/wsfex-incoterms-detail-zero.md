---
"facturas": patch
---

Una Factura E de bienes emitida sin `incotermsDetail` ahora se recupera como `authorized`. `FEXGetCMP` devuelve `Incoterms_Ds` como `"0"` cuando el comprobante se mandó sin ese detalle, y la recuperación lo comparaba contra el detalle ausente de la reserva: si se perdía la respuesta de `FEXAuthorize`, un reintento o `recover()` devolvía `conflict` aunque el comprobante fuera el propio. `lookup()` ahora lee ese `"0"` como `incotermsDetail` ausente. Lo reportó @juansegnana en #108.
