# Emitir tu primera factura con ARCA

## 1. Habilitá ARCA

Necesitás CUIT, certificado y clave privada, la relación del certificado con
el servicio **Facturación Electrónica**, y un punto de venta habilitado para
web services. Homologación y producción tienen certificados y puntos de venta
propios. Consultá la [documentación oficial](https://www.arca.gob.ar/ws/documentacion/ws-factura-electronica.asp).
El SDK no hace estas habilitaciones por vos.

## 2. Instalá

```sh
pnpm add facturas
```

Requiere Node.js 20 o superior y módulos ESM. Si usás Vercel Postgres,
instalá también el cliente `@vercel/postgres` de tu aplicación.

## 3. Configurá el cliente

Definí `ARCA_TAX_ID`, `ARCA_CERTIFICATE_PEM`, `ARCA_PRIVATE_KEY_PEM` y
`ARCA_ENVIRONMENT=test`. Los PEM deben contener el certificado y la clave
completos. No los subas al repositorio. El entorno predeterminado es `test`.
Los campos explícitos de `createArcaClient()` tienen prioridad.

Creá una vez la tabla [Postgres del README](../README.md#postgres) y usá:

```ts
import { createArcaClient, createPostgresStore } from "facturas";
import { sql } from "@vercel/postgres";

const arca = createArcaClient({
  store: createPostgresStore({ query: (text, params) => sql.query(text, params) }),
});
```

Un solo `store` guarda tickets WSAA y reservas de comprobantes. También hay
adaptadores Redis, archivos y memoria; memoria sirve para pruebas y no
sobrevive al reinicio del proceso.

## 4. Emití la primera factura

`venta.id` es el identificador estable de tu venta. Elegí tu condición real de
emisor y tu punto de venta habilitado:

```ts
const factura = await arca.vouchers.issue(
  {
    issuer: "monotributo",
    salesPoint: 3,
    to: { condition: "consumidor_final" },
    items: [{ amount: 150_000 }], // ARS 1.500,00 en centavos
  },
  { idempotencyKey: venta.id },
);
```

El importe se expresa en centavos. Para responsables inscriptos usá
`issuer: "responsable_inscripto"` e ítems como `{ gross: 12_100, vat: 21 }`.
ARCA valida la habilitación fiscal; el SDK no infiere tu condición.

## 5. Tratá todos los resultados

- `authorized`: guardá `factura.voucher` y su CAE.
- `rejected`: revisá los errores que devolvió ARCA.
- `indeterminate`: conservá el número y la evidencia; conciliá o repetí con la misma clave e input.
- `conflict`: hay otro comprobante en ese número; detené el flujo e investigá.

La evidencia SOAP y el input exacto no aparecen por defecto. Podés pedirlos
con `include: { raw: true, exactInput: true }`.

## 6. Reintentá con la misma clave

Sin `idempotencyKey`, un reintento después de una caída puede emitir la factura
dos veces. Configurá un `store` y pasá la clave para que los reintentos sean seguros.

Usá de 1 a 255 caracteres, sin CUIT, DNI ni otros datos personales. No generes
una clave nueva por intento. Una clave con un input diferente produce
`ARCA_INPUT_IDEMPOTENCY_MISMATCH`. No borres ni hagas vencer las reservas:
guardan el número fiscal que el reintento debe consultar.

## 7. Pasá a producción

Habilitá el certificado y punto de venta de producción y cambiá
`ARCA_ENVIRONMENT=production`. Una prueba de ARS 1 usa `items: [{ amount: 100 }]`.
Para anularla por su importe completo:

```ts
if (factura.kind === "authorized") {
  const nota = await arca.vouchers.cancel(factura.voucher, {
    idempotencyKey: `cancel:${venta.id}`,
  });
  console.log(nota); // También debe tratarse cada resultado de la nota.
}
```

La factura y la nota de crédito **son documentos reales y quedan registrados**.
La nota es una segunda operación; si falla, la factura sigue pendiente.
`cancel()` admite facturas A, B y C en ARS o USD, sin tributos ni extensiones.
Para notas parciales u otros casos usá la API exacta.
