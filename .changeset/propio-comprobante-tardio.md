---
"facturas": minor
---

Una clave ya no termina con dos comprobantes cuando ARCA procesa tarde su primer envío. Después de un 10016 en una repetición, si la consulta del número falla o se aborta, `issue()` devuelve `indeterminate` en vez de `rejected`, porque el número puede estar ocupado por ese envío propio. Una clave a la que otra le quitó el número devuelve `authorized` si el comprobante que hay ahí tiene sus datos fiscales y no los de la otra clave, que queda en `conflict`. Mientras ese número sigue vacío, devuelve `indeterminate` con `lookup.kind === "blocked"` en vez de `superseded`, porque su envío todavía puede llegar.
