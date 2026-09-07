# facturas

[![npm version](https://img.shields.io/npm/v/facturas.svg)](https://www.npmjs.com/package/facturas)
[![CI](https://github.com/LaPyme/facturas/actions/workflows/ci.yml/badge.svg)](https://github.com/LaPyme/facturas/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](https://github.com/LaPyme/facturas/blob/main/LICENSE)

SDK de Node.js para ARCA / AFIP: facturas, notas de crédito y Padrón, con
integración directa a WSFE y WSMTXCA.

- **Solo ESM**, Node.js **>= 20**
- **CLI incluido**: `npx facturas init` genera la clave y el CSR, y
  `npx facturas check` nombra la capa de ARCA que falla
- **Integración directa con ARCA**, sin proxy ni dependencia alojada
- **Login WSAA resuelto**: caché en memoria, stores de sesión durables,
  deduplicación de logins en vuelo y recuperación de `coe.alreadyAuthenticated`
- **API pública en TypeScript estricto**, con nombres al estilo JS mapeados a
  SOAP internamente
- **Datos de referencia comunes de ARCA** exportados como constantes, para que
  los ejemplos y tu código no necesiten números mágicos
- **Ejemplos copiables**, escritos para que los lean personas y agentes de
  código

La documentación está en castellano, en [docs/](./docs/README.md).
[English summary](./docs/en/README.md).

## Instalación

```bash
pnpm add facturas
# o
npm install facturas
```

## Emití tu primera factura

Definí las [variables de entorno](./docs/configuracion.md#variables-de-entorno)
con tu CUIT, certificado y clave. No hace falta nada más: ni base de datos, ni
tabla, ni servicio externo.

```ts
import { createArcaClient } from "facturas";

const arca = createArcaClient();

const factura = await arca.issue({
  issuer: "monotributo",
  salesPoint: 3,
  to: { condition: "consumidor_final" },
  items: [{ amount: 150_000 }], // ARS 1.500,00 en centavos
});
```

Tratá siempre los cuatro resultados:

| Resultado | Significado y acción del llamador |
| --- | --- |
| `authorized` | Guardá el comprobante y el CAE. `recoveredByMatch: true` significa que el input guardado coincidió con la identidad consultada; prueba consistencia, no autoría. |
| `rejected` | Revisá los `issues` de ARCA. Una clave queda ligada a su input incluso después de un rechazo. |
| `indeterminate` | Conservá el número y la evidencia. Conciliá o repetí el input idéntico con su clave existente. |
| `conflict` | Hay otro comprobante en el número reservado. Detené el flujo e investigá. |

El paso a paso está en [Inicio rápido](./docs/inicio-rapido.md); el detalle, en
[Facturas](./docs/facturas.md).

## Reintentos seguros

Recomendado en toda aplicación real, opcional para empezar. Sin
`idempotencyKey`, un reintento después de una caída puede emitir la factura dos
veces. Con un `store` y el ID estable de la venta como clave, el reintento
consulta el número reservado y nunca vuelve a emitir.

```ts
import { createArcaClient, createPostgresStore } from "facturas";
import { sql } from "@vercel/postgres";

const arca = createArcaClient({
  store: createPostgresStore({ query: (text, params) => sql.query(text, params) }),
});

const factura = await arca.issue(input, { idempotencyKey: venta.id });
```

Hay adaptadores para Postgres, Redis, archivos y memoria, y podés escribir el
tuyo; con ellos, dos emisiones simultáneas sobre el mismo punto de venta se
serializan y cada una escribe su número. Ver [Stores](./docs/stores.md).

## Nota de crédito

ARCA no anula comprobantes: una corrección es una nota de crédito y también es
un documento real que queda en los registros de ARCA. Lo habitual es la nota
parcial, que acredita las líneas que elegís.

```ts
const nota = await arca.issueCreditNote(
  {
    for: { salesPoint: 3, voucherType: 11, number: 41 },
    items: [{ amount: 50_000 }], // ARS 500,00 de una factura de ARS 1.500,00.
  },
  { idempotencyKey: `nc:${devolucion.id}` },
);
```

Con `all: true` acreditás el original completo. El modo es explícito y
obligatorio. La misma fachada emite [notas de débito y por
período](./docs/notas-de-credito.md), tributos, FCE, [detalle de ítems por
WSMTXCA](./docs/wsmtxca.md) y `recover()`, que concilia sin emitir.

## Documentación

- [Inicio rápido](./docs/inicio-rapido.md): de cero a la primera factura y su
  nota de crédito.
- [Habilitación en ARCA](./docs/habilitacion-arca.md): CUIT, certificado, punto
  de venta y referencias oficiales.
- [CLI](./docs/cli.md): `init`, `check` e `issue`, con la tabla de diagnósticos.
- [Facturas](./docs/facturas.md): `issue()`, `preview()`, datos de la factura y
  contrato fiscal de la fachada.
- [Notas de crédito](./docs/notas-de-credito.md): `issueCreditNote()`, modo
  parcial y modo total.
- [Stores](./docs/stores.md): Postgres, Redis, archivos, memoria, store propio
  y vida de los registros.
- [Configuración](./docs/configuracion.md): variables de entorno, opciones del
  cliente, sesiones WSAA, logging, reintentos y timeouts.
- [Capa exacta](./docs/capa-exacta.md): builders, superficie de servicios,
  emisión exacta y evidencia de recuperación.
- [Errores](./docs/errores.md): clases de error y diagnóstico.
- [Referencia](./docs/referencia.md): constantes, API pública con semver y
  seguridad.
- [Ejemplos](./docs/ejemplos.md): índice de [examples/](./examples).

## Estado del proyecto

Pre-1.0. Mientras la versión empiece en `0.`, un minor puede cambiar o quitar
partes de la API pública. Fijá la versión exacta y leé el
[changelog](./packages/arca/CHANGELOG.md) antes de actualizar.

Para contribuir, mirá [CONTRIBUTING.md](./CONTRIBUTING.md).

## Licencia

Apache-2.0
