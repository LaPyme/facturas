# Emitir tu primera factura con ARCA

## 1. Habilitá ARCA

Necesitás CUIT, certificado y clave privada, la relación del certificado con
el servicio **Facturación Electrónica**, y un punto de venta habilitado para
web services. Homologación y producción tienen certificados y puntos de venta
propios. El SDK no hace estas habilitaciones por vos, pero el CLI te acompaña:

```sh
npx facturas init --cuit 20123456786 --env test
```

Genera la clave privada y el CSR que se sube en ARCA —en homologación te lo
deja en el portapapeles— y después imprime los pasos exactos: qué página, qué
botón y qué servicio autorizar. Cuando ARCA te dé el certificado, lo pegás en
el prompt del final y lo guarda en ese mismo directorio como `arca-test.crt`;
si saliste antes, `npx facturas cert` lo toma después. El
paso a paso completo y las referencias oficiales están en
[Habilitación en ARCA](./habilitacion-arca.md); los comandos, en
[CLI](./cli.md).

## 2. Instalá

```sh
pnpm add facturas
```

Requiere Node.js 20 o superior y módulos ESM. Si usás Vercel Postgres,
instalá también el cliente `@vercel/postgres` de tu aplicación.

## 3. Configurá el cliente

Definí `ARCA_TAX_ID`, `ARCA_CERTIFICATE_PEM`, `ARCA_PRIVATE_KEY_PEM` y
`ARCA_ENVIRONMENT=test`. Los PEM deben contener el certificado y la clave
completos. No los subas al repositorio. No hay entorno predeterminado: `test`
apunta a homologación y `production` a los servidores reales.
Los campos explícitos de `createArcaClient()` tienen prioridad.

```ts
import { createArcaClient } from "facturas";

const arca = createArcaClient();
```

Con eso alcanza para emitir: el cliente lee las variables de entorno y guarda
el ticket WSAA en memoria. No necesitás base de datos ni ningún servicio
externo. El resto de las opciones está en [Configuración](./configuracion.md).

Antes de escribir código, confirmá las habilitaciones:

```sh
npx facturas check
```

Prueba la configuración, el certificado, WSAA, WSFE y los puntos de venta en
ese orden, y nombra la capa que falla con la página de ARCA que la arregla. No
hace falta exportar nada para correrlo: si `arca-test.crt` y `arca-test.key`
están en el directorio, los usa, y saca de ahí el entorno y el CUIT. No
escribe nada en ARCA; sí guarda el ticket WSAA en el directorio temporal, para
poder repetirse. La tabla completa de diagnósticos está en
[CLI](./cli.md#diagnósticos).

## 4. Emití la primera factura

Elegí tu condición real de emisor y tu punto de venta habilitado. Este bloque
es [examples/primera-factura.ts](../examples/primera-factura.ts):

```ts
const factura = await arca.issue({
  issuer: "monotributo",
  salesPoint: 3,
  to: { condition: "consumidor_final" },
  items: [{ amount: 150_000 }], // ARS 1.500,00 en centavos
});
```

El importe se expresa en centavos. Para responsables inscriptos usá
`issuer: "responsable_inscripto"` e ítems como `{ gross: 12_100, vat: 21 }`.
Si preferís probar el circuito antes de escribir código,
`npx facturas issue --sales-point 3 --issuer monotributo` emite una factura de
ARS 1 en homologación y te imprime la llamada que hizo.
ARCA valida la habilitación fiscal; el SDK no infiere tu condición. Todos los
campos del input están en [Facturas](./facturas.md#datos-de-la-factura).

Antes de emitir podés revisar lo que el SDK va a enviar con
`arca.preview(input)`: es sincrónico, no hace ninguna llamada y devuelve la
clase, el tipo de comprobante, los `amounts` y el request exacto. Compará
`preview(input).amounts.sentTotal` con el total de tu venta y recién entonces
llamá a `issue()`.

## 5. Tratá todos los resultados

- `authorized`: guardá `factura.voucher` y su CAE.
- `rejected`: revisá los errores que devolvió ARCA.
- `indeterminate`: conservá el número y la evidencia; conciliá o repetí el mismo input (con su clave, ver el paso 6).
- `conflict`: hay otro comprobante en ese número; detené el flujo e investigá.

La evidencia SOAP y el input exacto no aparecen por defecto. Podés pedirlos
con `include: { raw: true, exactInput: true }`. Qué llamadas hace cada camino
está en
[Contrato fiscal de la fachada](./facturas.md#contrato-fiscal-de-la-fachada).
Cuando una llamada falla, mirá [Errores](./errores.md).

## 6. Hacé seguros los reintentos

Recomendado en toda aplicación real, opcional para empezar. Sin
`idempotencyKey`, un reintento después de una caída puede emitir la factura
dos veces. Configurá un `store` y pasá el ID estable de la venta como clave:
el reintento consulta el número reservado y nunca vuelve a emitir.

Creá una vez la tabla [Postgres](./stores.md#postgres) y usá:

```ts
import { createArcaClient, createPostgresStore } from "facturas";
import { sql } from "@vercel/postgres";

const arca = createArcaClient({
  store: createPostgresStore({ query: (text, params) => sql.query(text, params) }),
});

const factura = await arca.issue(input, { idempotencyKey: venta.id });
```

Un solo `store` guarda tickets WSAA y reservas de comprobantes. También hay
adaptadores Redis, archivos y memoria; memoria sirve para pruebas y no
sobrevive al reinicio del proceso. Están todos en [Stores](./stores.md).

Usá de 1 a 255 caracteres, sin CUIT, DNI ni otros datos personales. No generes
una clave nueva por intento. Una clave con un input diferente produce
`ARCA_INPUT_IDEMPOTENCY_MISMATCH`. No borres ni hagas vencer las reservas:
guardan el número fiscal que el reintento debe consultar.

## 7. Pasá a producción

Habilitá el certificado y punto de venta de producción y cambiá
`ARCA_ENVIRONMENT=production`. Una prueba de ARS 1 usa `items: [{ amount: 100 }]`.
Esa factura **es un documento real y queda registrada**.

## 8. Emití una nota de crédito

ARCA no anula comprobantes: una corrección es una nota de crédito, que también
es un documento real. Lo habitual es la nota parcial, que acredita las líneas
que elegís:

```ts
if (factura.kind === "authorized") {
  const nota = await arca.issueCreditNote(
    {
      for: factura.voucher,
      items: [{ amount: 50 }], // ARS 0,50 de una factura de ARS 1,00.
    },
    { idempotencyKey: `nc:${venta.id}` },
  );
  console.log(nota); // También debe tratarse cada resultado de la nota.
}
```

Con `all: true` en lugar de `items` acreditás el total del original. El modo es
explícito y obligatorio: sin `items` ni `all: true`, el SDK falla antes de
cualquier llamada, así un campo olvidado nunca acredita la factura entera.

La nota es una segunda operación; si falla, la factura sigue pendiente. La
clase, el receptor, la moneda, el concepto y las fechas de servicio salen del
original; vos aportás las líneas y, como mucho, el punto de venta y la fecha de
la nota. La misma fachada emite notas de débito y notas por período: está todo
en [Notas de crédito](./notas-de-credito.md). Si además necesitás detalle de
ítems, el comprobante va por [WSMTXCA](./wsmtxca.md).
