---
"facturas": patch
---

Un `issue()` con `idempotencyKey` cuya clave ya tiene reserva reenvía lo guardado sin volver a derivar la factura. Antes, una factura de servicios sin `date` con `service.dueDate` de hoy no se podía reintentar al día siguiente: la derivación tiraba `ArcaInputError` antes de llegar a la reserva. El input se copia al entrar, así que cambiar el objeto durante la llamada no cambia lo que se manda ni lo que se guarda. Un reintento que reenvía informa los `amounts` del pedido guardado, como `recover()`.
