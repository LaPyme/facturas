# Facturas

`issue()` es la fachada: derivá el comprobante desde datos de negocio, reservá
el número y recuperá los reintentos. Para los campos que no deriva, usá la
[capa exacta](./capa-exacta.md).

## Emitir

Definí las [variables de entorno](./configuracion.md#variables-de-entorno).
No hace falta store ni ningún servicio externo. Este bloque es
[examples/primera-factura.ts](../examples/primera-factura.ts):

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

## Reintentos seguros con clave de idempotencia

Recomendado en toda aplicación real, opcional para empezar. Sin
`idempotencyKey`, un reintento después de una caída puede emitir la factura
dos veces. Configurá un `store` y pasá el ID estable de la venta como clave:
el reintento consulta el número reservado y nunca vuelve a emitir. El ejemplo
asume que `venta` es tu venta y que la tabla del
[store](./stores.md#postgres) existe.

```ts
import { createArcaClient, createPostgresStore } from "facturas";
import { sql } from "@vercel/postgres";

const arca = createArcaClient({
  store: createPostgresStore({ query: (text, params) => sql.query(text, params) }),
});

const factura = await arca.issue(input, { idempotencyKey: venta.id });
```

Una clave tiene de 1 a 255 caracteres. Usá el ID de la venta o del pedido,
nunca un UUID nuevo por intento. No pongas CUIT, DNI ni otros datos personales
en las claves. Reusá la misma clave y el mismo input en los reintentos; si el
input cambia, se lanza `ARCA_INPUT_IDEMPOTENCY_MISMATCH`. Las claves están
alcanzadas al CUIT del cliente y al entorno. `representedTaxId` también se
controla como parte de la identidad del input. Una clave sin store lanza antes
de cualquier I/O con el proveedor. Claves distintas identifican operaciones de
negocio distintas.

Con un store que provee `withLock` —Postgres, Redis, archivos, memoria o el
tuyo—, las llamadas con clave sobre el mismo punto de venta y tipo de
comprobante se serializan: cada una toma el número siguiente y escribe una sola
vez. La coordinación alcanza a los procesos que comparten ese store, no a otros
escritores del mismo punto de venta. El detalle, con la tabla de garantías por
adaptador, está en [Stores](./stores.md#qué-garantiza-cada-store).

`signal` es tu deadline, un `AbortSignal` cualquiera, por ejemplo
`AbortSignal.timeout(20_000)`. Aborta el login WSAA, la escritura y las
consultas de esa llamada. Si se corta después de haber enviado la escritura, el
resultado es `indeterminate` con `lookup.kind === "aborted"`: la reserva queda y
`recover()` la concilia. No hay un `timeoutMs` aparte: un solo `signal` compone
con el que ya tenga tu aplicación.

El ejemplo completo, con el tratamiento de los cuatro resultados, está en
[examples/issue-invoice.ts](../examples/issue-invoice.ts).

`recover(clave, opciones)` concilia sin emitir. Solo consulta la reserva
guardada, con el proveedor y el número que quedaron registrados: nunca autoriza
ni reserva un número nuevo. Si ARCA confirma que el número está vacío, el
resultado es `indeterminate` con `lookup.kind === "not_found"`, no una
autorización; para emitir se llama `issue()` con la misma clave. Si no hay
reserva para esa clave, lanza `ArcaInputError`. Acepta `representedTaxId`,
`forceRefresh`, `include` y `signal`.

## Revisá antes de emitir

`preview()` deriva exactamente lo que enviaría `issue()`, sin ninguna I/O: sin
store, sin WSAA, sin SOAP y sin lectura del próximo número. Lanza los mismos
errores de input que lanza `issue()` antes de su primera llamada, así que un
input que previsualiza limpio no genera ningún error local nuevo al emitir.

Este bloque es [examples/preview.ts](../examples/preview.ts):

```ts
import { createArcaClient, createMemoryStore, type IssueInput } from "facturas";

// Example only: use a durable store in an app. Memory does not survive restarts.
const arca = createArcaClient({ store: createMemoryStore() });
const venta = { id: "sale-example-002", totalEnCentavos: 121_000 };

const input: IssueInput = {
  issuer: "responsable_inscripto",
  salesPoint: 3,
  to: { condition: "consumidor_final" },
  items: [{ gross: 121_000, vat: 21 }], // ARS 1.210,00 en centavos
};

// preview() is synchronous and reaches no store, no WSAA and no SOAP.
const previsualizacion = arca.preview(input);
console.log(
  previsualizacion.voucherClass, // "B"
  previsualizacion.voucherType, // 6
  previsualizacion.amounts, // computedTotal, sentTotal, vatAdjustment
  previsualizacion.request // the exact WSFE input, without the voucher number
);

if (previsualizacion.amounts.sentTotal !== venta.totalEnCentavos) {
  throw new Error("The derived invoice does not match the sale total.");
}

const factura = await arca.issue(input, { idempotencyKey: venta.id });
if (factura.kind === "authorized") {
  // The issued amounts are the ones the preview showed.
  console.log(factura.voucher.amounts, previsualizacion.amounts);
}
```

`preview()` es sincrónico y devuelve la `voucherClass` derivada, el
`voucherType`, los mismos `amounts` que informa un resultado autorizado, y
`request`, el input exacto que enviaría `issue()`: un `WsfeVoucherInput`, o el
request de WSMTXCA si pasás `{ service: "wsmtxca" }`. El número de comprobante
no aparece porque recién se conoce cuando se reserva el número al emitir.
Previsualizar una nota sí necesita el original, así que `previewCreditNote()` y
`previewDebitNote()` son asincrónicas y hacen esa consulta; están en
[Notas de crédito](./notas-de-credito.md#vista-previa-de-notas).

## Datos de la factura

El emisor es tu afirmación legal en cada llamada; el SDK nunca lo infiere de
los ítems ni del Padrón. Un emisor RI produce A para receptores RI o
Monotributo y B para las demás condiciones soportadas. Los emisores
Monotributo, Exento y No Alcanzado producen C y usan
`items: [{ amount: 10_000 }]`. ARCA valida la habilitación real. `to` es el
receptor fiscal (los campos de documento y de condición del receptor de la capa
exacta), no un registro de cliente.

Los importes son enteros en centavos. Para ítems de RI, elegí `net` o `gross`
en cada ítem y uno de `0 | 2.5 | 5 | 10.5 | 21 | 27 | "exempt" | "untaxed"`
para `vat`. El cero numérico es una alícuota de IVA; los importes exentos y no
gravados tienen campos fiscales propios. Los ítems se agrupan por alícuota
antes del redondeo Round Half Even.

`total`, cuando lo pasás, afirma el total enviado. El SDK ajusta el IVA de
cabecera solo dentro de un centavo por cada alícuota numérica emitida, y
mantiene el IVA no negativo. Los totales de clase C tienen que coincidir
exactamente. Los resultados autorizados exponen `computedTotal`, `sentTotal` y
`vatAdjustment` en `voucher.amounts`, todos en centavos.

Los valores por defecto son la fecha de hoy en Buenos Aires, productos
(concepto 1) y `ARS` con tipo de cambio `1`. Usá `currency: "USD"` con un
`exchangeRate` decimal positivo en string, o `service: { from, to, dueDate }`
para el concepto 2. Las fechas aceptan `YYYY-MM-DD` o `YYYYMMDD`; el fin del
servicio tiene que ser igual o posterior a su inicio y el vencimiento de pago
igual o posterior a la fecha de la factura.

Los receptores que no son consumidor final requieren un `cuit` de 11 dígitos.
Un consumidor final acepta un `cuit` o un `dni`, o ninguno por debajo del
umbral de identificación. Desde ARS 10.000.000 (incluidos los USD convertidos
al tipo de cambio informado), la identificación es obligatoria según la
[RG 5866/2026](https://www.argentina.gob.ar/normativa/nacional/norma-427092/texto).
Cuando el cliente pide el CUIT para deducir en Ganancias, informalo sin importar
el monto. Los controles de forma del documento no verifican la inscripción ante
el proveedor.

`family` elige la familia del comprobante y por defecto es `"ordinary"`
(1, 6, 11). `"retention_legend"` es A con leyenda y existe solo en clase A
(51, 52, 53). `"fce"` es Factura de Crédito Electrónica MiPyME (201 a 213):
requiere `dueDate` y `fce: { cbu, alias?, transfer?, reference? }`, con un CBU
de 22 dígitos. ARCA valida la cuenta bancaria real y tu habilitación.

`taxes` son tributos y percepciones. Cada fila es
`{ id, description?, base, rate, amount }`, con `base` y `amount` en centavos y
`rate` en porcentaje. Los tributos quedan fuera de la aritmética de los ítems y
suman al total.

`amounts` es un desglose fiscal ya revisado y es excluyente con `items`: el SDK
no recalcula el IVA ni lo ajusta. Toma
`{ net, vat, exempt?, untaxed?, vatRates? }` en centavos, con filas `vatRates`
de la forma `{ id, base, amount }`. El `total` opcional afirma el total
revisado: se controla contra las reglas de conciliación de importes del
proveedor y no se reescribe en silencio.

`concept: "products_and_services"` es el concepto 3, junto a `"products"` y
`"services"`; `dueDate` informa el vencimiento de pago. `paidInForeignCurrency`
marca la cancelación en la misma moneda extranjera y no se acepta en ARS. Para
monedas que no son `ARS` ni `USD`, pasá `currency: { id: "060" }` con un
`exchangeRate` explícito; ARCA controla la elegibilidad.

`to.condition` también acepta el número de la condición de IVA del receptor del
catálogo de ARCA, con `cuit`, `dni` o `document: { type, number }`. Los campos
`optionalFields`, `buyers` y `activities` pasan tal cual a WSFE y a WSMTXCA; no
dupliques ahí lo que ya informa `fce`.

Para el detalle de ítems de WSMTXCA, mirá [WSMTXCA](./wsmtxca.md). El ejemplo
compilado de todo esto es
[examples/emision-completa.ts](../examples/emision-completa.ts).

## Contrato fiscal de la fachada

Sin clave, una llamada lee un próximo número y autoriza una vez, con a lo sumo
una consulta de identidad después de una respuesta indeterminada. Es el
comportamiento de la v0.8. Una primera llamada con clave reserva ese número
antes de escribir. Una repetición con clave consulta la reserva: solo
`not_found` habilita una autorización del número guardado. Un comprobante
encontrado nunca se reenvía. Las escrituras indeterminadas y los rechazos 10016
con clave pueden agregar una consulta. `issueCreditNote()` agrega la consulta
del original solo cuando crea una reserva nueva.

Un 10016 sobre un número que esta misma llamada reservó no se resuelve por
coincidencia de campos: si la consulta encuentra un comprobante el resultado es
`conflict`, y si no encuentra nada sigue siendo `rejected`. Dos ventas con
datos fiscales idénticos —dos consumidor final por el mismo importe el mismo
día— coinciden en todos los campos, así que la coincidencia probaría
consistencia y nunca autoría. La comparación de identidad queda para una
reserva que ya existía, el único caso en el que el número puede ser una
escritura propia anterior. Todo `conflict` se anota en el store antes de
responder; una repetición con esa clave, o un `recover()`, devuelve el mismo
`conflict` sin ninguna llamada al proveedor.

| Resultado | Significado y acción del llamador |
| --- | --- |
| `authorized` | Guardá el comprobante y el CAE. `recoveredByMatch: true` significa que el input guardado coincidió con la identidad consultada; prueba consistencia, no autoría. |
| `rejected` | Revisá los `issues` de ARCA. Una clave queda ligada a su input incluso después de un rechazo. |
| `indeterminate` | Conservá el número y la evidencia. Conciliá o repetí el input idéntico con su clave existente. |
| `conflict` | Hay otro comprobante en el número reservado. Detené el flujo e investigá. |

Un `indeterminate` informa en `lookup` por qué quedó abierto: `not_found`,
`incomplete`, `failed`, `aborted` cuando venció tu `signal`, `blocked` cuando
otra reserva sin resolver todavía frena la secuencia y `superseded` cuando la
secuencia siguió sin esta clave. En `blocked` no se reservó ningún número:
`by` nombra la clave a conciliar con `recover()`. En `superseded` la clave
`by` se llevó el número: esta clave nunca va a escribir, así que emití bajo una
clave nueva.

El segundo argumento acepta `idempotencyKey`, `signal`, `representedTaxId`,
`forceRefresh`, `service`, `number` e
`include: { raw: true, exactInput: true }`.
Los resultados no traen la evidencia cruda por defecto; `sent` se incluye solo
en resultados autorizados y solo si lo pedís. Una repetición sin un resultado
de escritura observado usa un intento indeterminado con
`reason: "incomplete_response"`; la consulta aporta la evidencia de
autorización.

`service` elige el proveedor: `"wsfe"` por defecto, `"wsmtxca"` para el detalle
de ítems. Nunca cambia solo. `number` es un número reservado por fuera: cuando
lo pasás, la llamada no lee el próximo número, así que la aplicación sigue
siendo dueña de la secuencia del punto de venta.

La fachada cubre la emisión de CAE de facturas y notas. CAEA, exportación y
los demás servicios de ARCA no están cubiertos por ella.

El comparador de identidad compara coordenadas, fecha, concepto, receptor,
moneda, todos los importes de cabecera, alícuotas de IVA, fechas de servicio,
tributos, campos opcionales, compradores, actividades, las asociaciones de
notas (incluidos el CUIT emisor y la fecha informados) y el flag de pago en
moneda extranjera. Los campos faltantes quedan incompletos y nunca cuentan como
prueba de coincidencia; las diferencias son conflictos. Las extensiones exactas
fuera de ese conjunto quedan incompletas.
