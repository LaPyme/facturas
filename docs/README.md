# Documentación

La documentación de `facturas` está en castellano. Los identificadores de la
API, los nombres de opciones, los códigos de error, los tipos de resultado y
los términos de ARCA quedan como están en el código.

- [Inicio rápido](./inicio-rapido.md): de cero a la primera factura y su nota
  de crédito.
- [Habilitación en ARCA](./habilitacion-arca.md): CUIT, certificado, punto de
  venta y referencias oficiales.
- [CLI](./cli.md): `npx facturas init`, `check` e `issue`, con la tabla de
  diagnósticos y los códigos de salida.
- [Facturas](./facturas.md): `issue()`, `preview()`, `recover()`, datos de la
  factura —familias, tributos, FCE, desgloses revisados— y contrato fiscal de
  la fachada.
- [Notas de crédito](./notas-de-credito.md): `issueCreditNote()`,
  `issueDebitNote()`, modo parcial, modo total, notas por período y vistas
  previas.
- [WSMTXCA](./wsmtxca.md): emisión con detalle de ítems por el segundo
  servicio de CAE.
- [Stores](./stores.md): Postgres, Redis, archivos, memoria, store propio y
  vida de los registros.
- [Configuración](./configuracion.md): variables de entorno, opciones del
  cliente, sesiones WSAA, logging, reintentos y timeouts.
- [Capa exacta](./capa-exacta.md): builders, superficie de servicios, emisión
  exacta y evidencia de recuperación.
- [Errores](./errores.md): clases de error y diagnóstico.
- [Referencia](./referencia.md): constantes, API pública con semver y
  seguridad.
- [Ejemplos](./ejemplos.md): índice de [examples/](../examples).
- [English summary](./en/README.md): a short overview in English.

Para mantenedores: [docs/external/README.md](./external/README.md) registra qué
reglas del manual de ARCA codifica el SDK y contra qué versión del documento se
verificaron. Está en inglés y no se traduce.

Para contribuir al repositorio, mirá [CONTRIBUTING.md](../CONTRIBUTING.md).
