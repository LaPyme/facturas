---
"facturas": patch
---

Una idempotencyKey rechazada ya no recupera el CAE de otra venta que tomó su número. Si ARCA rechazó todos los envíos de la clave, el rechazo queda guardado en la reserva, y el reintento y `recover()` informan un conflicto si aparece un comprobante en ese número. Si un envío anterior quedó sin respuesta, el rechazo no se guarda, porque ese envío puede haber llegado. El conflicto que encuentra el primer envío de una clave queda guardado siempre. Sin `withLock`, un doble envío de la misma clave puede dejar su propio CAE como conflicto: conciliá ese comprobante a mano. Hay otras diferencias sin `withLock`, que se detallan en la guía "Evitar comprobantes duplicados". Actualizá todos los procesos que comparten un store: las versiones anteriores ignoran el rechazo guardado.
