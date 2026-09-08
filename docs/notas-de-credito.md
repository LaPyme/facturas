# Notas de crédito

ARCA no anula comprobantes. Una corrección es una nota de crédito, y todos los
modos de `issueCreditNote()` escriben un documento fiscal real que queda en los
registros de ARCA.

Una nota de crédito nombra el comprobante que corrige, o el período que
ajusta. `issueDebitNote()` emite notas de débito con el mismo contrato.

## Nota parcial

Lo habitual es la nota parcial: una devolución o una corrección de precio que
acredita las líneas que elegís en vez de la factura entera.

Este bloque es [examples/nota-de-credito-parcial.ts](../examples/nota-de-credito-parcial.ts):

```ts
import { createArcaClient, createFileStore } from "facturas";

// Configure ARCA credentials and a private durable directory before running.
// ARCA has no cancellation: this writes a real credit note for part of the
// original invoice. Both documents remain in ARCA's records.
const arca = createArcaClient({
  store: createFileStore("./private-arca-store"),
});
const devolucion = { id: "refund-example-001" };

const nota = await arca.issueCreditNote(
  {
    // The original invoice: a class C invoice of ARS 1.500,00 here.
    for: { salesPoint: 3, voucherType: 11, number: 41 },
    // Class C originals take amount items; A and B take { gross | net, vat }.
    items: [{ amount: 50_000 }], // ARS 500,00 en centavos
  },
  { idempotencyKey: `nc:${devolucion.id}` }
);

switch (nota.kind) {
  case "authorized":
    console.log(nota.voucher);
    break;
  case "rejected":
    console.error(nota.issues);
    break;
  case "indeterminate":
    console.error(nota.attempted, nota.lookup);
    break;
  case "conflict":
    console.error(nota.attempted, nota.found);
    break;
  default:
    nota satisfies never;
}
```

## Nota total

`all: true` acredita el original completo: espeja sus importes y sus alícuotas
de IVA línea por línea.

Este bloque es [examples/nota-de-credito-total.ts](../examples/nota-de-credito-total.ts):

```ts
import { createArcaClient, createFileStore } from "facturas";

// Configure ARCA credentials and a private durable directory before running.
// ARCA has no cancellation: this writes a real credit note for the whole
// invoice. Both the original and the note remain in ARCA's records.
const arca = createArcaClient({
  store: createFileStore("./private-arca-store"),
});
const nota = await arca.issueCreditNote(
  { for: { salesPoint: 3, voucherType: 11, number: 1 }, all: true },
  { idempotencyKey: "nota-de-credito-total-example-001" }
);
switch (nota.kind) {
  case "authorized":
    console.log(nota.voucher);
    break;
  case "rejected":
    console.error(nota.issues);
    break;
  case "indeterminate":
    console.error(nota.attempted, nota.lookup);
    break;
  case "conflict":
    console.error(nota.attempted, nota.found);
    break;
  default:
    nota satisfies never;
}
```

El modo es explícito y obligatorio: un input sin `items` ni `all: true`, o con
los dos, se rechaza antes de cualquier I/O, así un campo olvidado nunca puede
acreditar la factura entera.

## Qué sale del original y qué aportás vos

Del original el SDK toma la clase y por lo tanto el tipo de nota
(1 → 3, 6 → 8, 11 → 13), el tipo, el número y la condición de IVA del receptor,
la moneda y el tipo de cambio, el concepto y, para los conceptos 2 y 3, las
fechas de servicio, con el vencimiento elevado a la fecha de la nota. El
llamador aporta `for`, el modo (`items` o `amounts`, con un `total` opcional,
o `all: true`) y, como mucho, el `salesPoint` de la nota, que por defecto es el
del original, y `date`, que por defecto es hoy en Buenos Aires. Una nota
vinculada no tiene campos `issuer`, `to` ni `currency`; solo las notas por
período los llevan, porque no hay original de donde tomarlos.

La forma de los ítems sigue la clase del original. Una nota de clase C acepta
ítems `{ amount }`; las notas de clase A y B aceptan ítems `{ gross | net, vat }`
con las mismas alícuotas y la misma conciliación que `issue()`. La clase es
evidencia del original, así que una forma que la contradice se rechaza después
de la única consulta del original y antes de cualquier escritura.

En lugar de `items` podés pasar `amounts`, el mismo desglose fiscal revisado
que acepta `issue()`: `{ net, vat, exempt?, untaxed?, vatRates? }` en centavos,
con un `total` opcional. Es el modo para una nota parcial cuya composición ya
calculó tu aplicación; el SDK no recalcula el IVA. `items` y `amounts` son
excluyentes, y ninguno de los dos se combina con `all: true`.

## Tributos en las notas

Una nota total espeja los tributos del original tal como los devuelve la
consulta. Una nota parcial no prorratea nada: si la nota lleva tributos, los
pasás vos en `taxes`, con las mismas filas
`{ id, description?, base, rate, amount }` en centavos que usa `issue()`. El
SDK nunca adivina qué percepción corresponde ni en qué proporción.

## Límites

La nota no puede superar el total del original. El SDK no lleva la cuenta de
notas anteriores contra un original; evitar que varias notas sumen más que la
factura es tarea de la aplicación.

El original puede ser una factura o una nota de débito autorizada de las
familias ordinaria (1, 2, 6, 7, 11, 12), A con leyenda (51, 52) o FCE
(201, 202, 206, 207, 211, 212), incluidos los originales con tributos. `for`
identifica el original con `{ salesPoint, voucherType, number }` y nada más:
alcanza con esas tres coordenadas del comprobante anterior.

Los saldos acumulados, el stock, la contabilidad, la condición de agente de
retención o percepción y qué percepción corresponde en cada caso siguen siendo
de la aplicación. Los campos opcionales propios de la nota los aportás vos: no
se copian del original.

Una nota a otro receptor o en otra moneda es un documento distinto y pertenece
a la [capa exacta](./capa-exacta.md). Para emitir la nota con detalle de ítems,
mirá [WSMTXCA](./wsmtxca.md).

## Notas de débito

`issueDebitNote({ for, items | amounts })` emite una nota de débito contra los
mismos originales. No admite `all: true`: una nota de débito agrega al saldo,
así que sus líneas son siempre explícitas.

```ts
const debito = await arca.issueDebitNote(
  {
    for: { salesPoint: 3, voucherType: 1, number: 42 },
    items: [{ net: 1000, vat: 21 }],
  },
  { idempotencyKey: `nd:${ajuste.id}` },
);
```

## Notas por período

Con `associatedPeriod: { from, to }` la nota ajusta un período en vez de un
comprobante. En ese modo no hay `for` y no hay original que consultar, así que
la nota lleva los mismos datos de negocio que una factura: `issuer`, `to`,
`items` o `amounts`, moneda y demás.

```ts
const nota = await arca.issueCreditNote(
  {
    issuer: "responsable_inscripto",
    salesPoint: 3,
    to: { condition: "responsable_inscripto", cuit: "20123456789" },
    items: [{ net: 10_000, vat: 21 }],
    associatedPeriod: { from: "20260801", to: "20260831" },
  },
  { idempotencyKey: `nc:periodo:${cierre.id}` },
);
```

## Notas FCE

Una nota FCE necesita un original FCE. `fce: { annulment, reference? }` informa
la anulación de forma explícita: `all: true` no la elige por vos. El CUIT del
emisor y la fecha del original viajan en la asociación, no en campos sueltos.

```ts
const nota = await arca.issueCreditNote(
  {
    for: { salesPoint: 3, voucherType: 201, number: 7 },
    all: true,
    fce: { annulment: true },
  },
  { idempotencyKey: `nc:fce:${rechazo.id}` },
);
```

## Vista previa de notas

`previewCreditNote()` y `previewDebitNote()` derivan lo que enviaría la
emisión. A diferencia de `preview()`, que no hace ninguna I/O, estas consultan
el original: una lectura, sin escritura y sin reservar número. La respuesta de
una nota vinculada incluye ese comprobante como `original`, un
`VoucherSummary` normalizado y sin datos raw. Una nota por período no tiene
original, así que tampoco necesita esa consulta ni devuelve esa propiedad.

```ts
const previsualizacion = await arca.previewCreditNote({
  for: { salesPoint: 3, voucherType: 11, number: 41 },
  all: true,
});
console.log(
  previsualizacion.voucherType,
  previsualizacion.amounts,
  previsualizacion.original.cae,
  previsualizacion.original.totalAmount,
);
```

## Idempotencia y prueba en producción

`idempotencyKey` e `include` funcionan igual que en `issue()`; dale a la nota su
propia clave estable, por ejemplo `nc:${devolucion.id}`. Una repetición con
clave consulta solo la nota reservada e informa `amounts` a partir del request
guardado, así que en ese camino `computedTotal` es igual a `sentTotal` y
`vatAdjustment` es `0`.

Una prueba de humo en producción es una factura de ARS 1 seguida de una nota
total. **Los dos documentos son reales y quedan en los registros de ARCA.** La
nota es una operación aparte; si falla, la factura queda pendiente. Hacé
coincidir `issuer` con tu condición fiscal real.
