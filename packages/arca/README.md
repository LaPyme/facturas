<div align="center">
  <h1>facturas</h1>

<a href="https://lapyme.com.ar"><img alt="Creado por LaPyme" src="https://img.shields.io/badge/Creado%20por%20LaPyme-000000.svg?style=for-the-badge&labelColor=000000"></a>
<a href="https://www.npmjs.com/package/facturas"><img alt="Versión en npm" src="https://img.shields.io/npm/v/facturas.svg?style=for-the-badge&labelColor=000000"></a>
<a href="https://github.com/LaPyme/facturas/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/LaPyme/facturas/ci.yml?branch=main&style=for-the-badge&label=CI&labelColor=000000"></a>
<a href="https://github.com/LaPyme/facturas/blob/main/LICENSE"><img alt="Licencia" src="https://img.shields.io/npm/l/facturas.svg?style=for-the-badge&labelColor=000000"></a>

</div>

SDK de TypeScript para facturación electrónica con ARCA / AFIP. Emití facturas,
notas de crédito y notas de débito, y consultá el Padrón con una sola API.

- **Solo ESM**, Node.js **>= 22**
- **CLI incluido**: `npx facturas init` genera la clave y el CSR, y
  `npx facturas check` nombra la capa de ARCA que falla
- **Integración directa con ARCA**, sin proxy ni dependencia alojada
- **Una API de emisión**: el SDK deriva el pedido fiscal y mantiene los detalles
  de cada servicio fuera del flujo normal
- **Login WSAA resuelto**: caché en memoria, tickets cifrados en el store,
  deduplicación de logins en vuelo y recuperación de `coe.alreadyAuthenticated`
- **QR y Padrón incluidos**: cada comprobante autorizado trae la URL de su QR,
  y el Padrón devuelve la condición de IVA lista para facturar
- **API pública en TypeScript estricto**, con nombres al estilo JS mapeados a
  SOAP internamente
- **Datos de referencia comunes de ARCA** exportados como constantes, para que
  los ejemplos y tu código no necesiten números mágicos
- **Ejemplos copiables**, escritos para que los lean personas y agentes de
  código

La documentación está en castellano, en el [sitio de documentación](https://facturas-sdk.dev)
y en su [fuente Mintlify](./docs/index.mdx).

## Instalación

```bash
pnpm add facturas
# o
npm install facturas
```

## Emití tu primera factura

Definí las [variables de entorno](https://facturas-sdk.dev/reference/configuration#variables-de-entorno)
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

| Resultado | Qué significa y qué hacer |
| --- | --- |
| `authorized` | Guardá el comprobante, el CAE, `voucher.header` y el `qr` para imprimir. La cabecera tiene el mismo formato en una autorización directa o recuperada. `recoveredByMatch: true` significa que el input guardado coincidió con la identidad consultada. Esto prueba consistencia, no autoría. |
| `rejected` | Revisá los `issues` de ARCA. Una clave queda ligada a su input incluso después de un rechazo. |
| `indeterminate` | Conservá el número y la evidencia. Conciliá o repetí el input idéntico con su clave existente. |
| `conflict` | Hay otro comprobante en el número reservado. Detené el flujo e investigá. |

El paso a paso está en [Inicio rápido](https://facturas-sdk.dev/getting-started/quickstart).
El detalle está en [Facturas](https://facturas-sdk.dev/guides/invoices).

## Reintentos seguros

ARCA no recibe una clave de idempotencia. Si una respuesta se
pierde, no puede distinguir un reintento de una emisión nueva. `facturas` te
permite guardar cada intento en un `store` con el ID estable de tu venta. Al
repetir esa clave, consulta el número reservado en vez de empezar otra emisión.

```ts
import { createArcaClient, createPostgresStore } from "facturas";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const arca = createArcaClient({
  store: createPostgresStore({ query: (text, params) => pool.query(text, params) }),
});

const factura = await arca.issue(input, { idempotencyKey: venta.id });
```

Hay adaptadores para Postgres, Redis, archivos y memoria, y podés escribir el
tuyo. Con ellos, dos emisiones simultáneas sobre el mismo punto de venta se
serializan y cada una escribe su número. Ver
[Evitar comprobantes duplicados](https://facturas-sdk.dev/guides/avoid-duplicates).

## Nota de crédito

ARCA no anula comprobantes. Una corrección es una nota de crédito y también es
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
obligatorio. También podés emitir [notas de débito y por
período](https://facturas-sdk.dev/guides/credit-notes), tributos y FCE. `recover()` concilia
una reserva sin emitir.

## Documentación

- [Inicio rápido](https://facturas-sdk.dev/getting-started/quickstart): de cero a la primera factura y su
  nota de crédito.
- [Habilitación en ARCA](https://facturas-sdk.dev/getting-started/arca-setup): CUIT, certificado, punto
  de venta y referencias oficiales.
- [CLI](https://facturas-sdk.dev/getting-started/cli): `init`, `check` e `issue`, con la tabla de diagnósticos.
- [Facturas](https://facturas-sdk.dev/guides/invoices): `issue()`, `preview()`, datos de la factura y
  contrato fiscal de emisión.
- [Notas de crédito](https://facturas-sdk.dev/guides/credit-notes): `issueCreditNote()`, modo
  parcial y modo total.
- [Evitar comprobantes duplicados](https://facturas-sdk.dev/guides/avoid-duplicates): claves para
  reintentos, Postgres, Redis, archivos y memoria.
- [WSMTXCA para casos requeridos](https://facturas-sdk.dev/guides/wsmtxca): configuración
  avanzada para contribuyentes o puntos de venta que operan con ese servicio.
- [Configuración](https://facturas-sdk.dev/reference/configuration): variables de entorno, opciones del
  cliente, sesiones WSAA, logs, reintentos y límites de tiempo.
- [Módulos de transporte](https://facturas-sdk.dev/reference/arca-services): `client.wsfe`,
  `client.wsmtxca` y `client.padron` para lecturas, catálogos, estado del
  servicio y Padrón.
- [Errores](https://facturas-sdk.dev/reference/errors): clases de error y diagnóstico.
- [Referencia](https://facturas-sdk.dev/reference/public-api): constantes, API pública con semver y
  seguridad.
- [Ejemplos](https://facturas-sdk.dev/reference/examples): índice de [examples/](./examples).

## Contribuir

Las contribuciones son bienvenidas. [CONTRIBUTING.md](./CONTRIBUTING.md)
explica cómo levantar el repositorio y proponer un cambio. Usá los
[issues](https://github.com/LaPyme/facturas/issues) para reportar errores y
conversar propuestas.

## Seguridad

No abras issues públicos para reportar vulnerabilidades. Seguí
[SECURITY.md](./SECURITY.md) y escribinos a
[tomas@lapyme.com.ar](mailto:tomas@lapyme.com.ar).

## Estado del proyecto

Pre-1.0. Mientras la versión empiece en `0.`, un minor puede cambiar o quitar
partes de la API pública. Fijá la versión exacta y leé el
[changelog](./packages/arca/CHANGELOG.md) antes de actualizar.

## Licencia

Apache-2.0
