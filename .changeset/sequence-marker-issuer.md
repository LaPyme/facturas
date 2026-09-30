---
"facturas": patch
---

La marca de la secuencia guarda en `issuerTaxId` el CUIT del emisor que la creó. Si dos emisores con certificados distintos representan al mismo contribuyente y comparten store, la barrera encuentra la reserva del otro y ya no le da su número ni su CAE a otra clave. La barrera consulta esa reserva con su CUIT representado o, si no lo tiene, con el del contribuyente dueño de la secuencia, así un contador no deja un conflicto ajeno en la clave del contribuyente que emite con su propio certificado. `lookup` suma `byTaxId` en `blocked` y `superseded` para nombrar al emisor de `by`.

Una marca vieja sin `issuerTaxId`, o un proceso que todavía corre la versión anterior, deja el hueco abierto hasta que se actualicen todos los procesos que comparten el store.
