---
"facturas": minor
---

Una clave ya no termina con dos comprobantes cuando ARCA procesa tarde su primer envío. Después de un rechazo que puede indicar un número ocupado en una repetición (10016 en WSFE, cualquier rechazo en WSMTXCA), si la consulta del número falla o se aborta, `issue()` devuelve `indeterminate` en vez de `rejected`, porque el número puede estar ocupado por ese envío propio. Una clave a la que otra le quitó el número devuelve `authorized` si el comprobante que hay ahí tiene sus datos fiscales y no los de ninguna de las claves que se sucedieron en ese número, que quedan en `conflict`. Si una de esas claves fue rechazada, el número quedó libre para cualquier otra, así que el comprobante queda en `conflict` para atribuirlo a mano. Mientras ese número sigue vacío, devuelve `indeterminate` con `lookup.kind === "blocked"` en vez de `superseded`, porque su envío todavía puede llegar.
