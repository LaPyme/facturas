# WSMTXCA

WSMTXCA es el otro servicio de CAE de ARCA. Su diferencia con WSFE es el
detalle: cada comprobante lleva sus ítems, no solo la cabecera fiscal. La
fachada lo cubre con los mismos métodos que WSFE.

## Elegir el proveedor

El proveedor es explícito y se pasa en el segundo argumento. El SDK nunca lo
cambia solo, ni después de un rechazo ni después de un timeout.

```ts
const factura = await arca.issue(input, { service: "wsmtxca" });
```

Sin `service`, o con `service: "wsfe"`, la llamada va a WSFE. `issue()`,
`issueCreditNote()`, `issueDebitNote()`, `preview()`, `previewCreditNote()` y
`previewDebitNote()` aceptan la opción. Los tipos del resultado siguen el
literal que pasaste: con `{ service: "wsmtxca" }` el `request` y el `sent` son
los de WSMTXCA, sin casts.

## Detalle de ítems

El detalle vive en los mismos `items`. Además de la plata —`net` o `gross` con
`vat`, o `amount` en clase C— cada ítem puede llevar `description`, `quantity`,
`unit`, `unitPrice` y, opcionalmente, `discount`, `code`, `matrixCode` y
`matrixUnits`. WSMTXCA necesita los cuatro primeros en todos los ítems; si
falta alguno, se lanza `ArcaInputError` con el índice del ítem y el campo. WSFE
ignora estos campos y arma su cabecera igual que siempre.

Este bloque sale de
[examples/emision-completa.ts](../examples/emision-completa.ts):

```ts
const input = {
  issuer: "responsable_inscripto",
  salesPoint: 1,
  to: { condition: "responsable_inscripto", cuit: "20123456789" },
  items: [
    {
      net: 10_000,
      vat: 21,
      description: "Product",
      quantity: 1,
      unit: 7,
      unitPrice: "100.000000",
    },
  ],
} satisfies IssueInput;
```

El SDK deriva de ahí las filas del proveedor: la condición de IVA sale de la
alícuota del ítem (21 → 5, 10,5 → 4, 0 → 3, 2,5 → 9, 5 → 8, 27 → 6, exento → 2,
no gravado → 1, y clase C → 3), el importe del ítem incluye el IVA, y un ítem
de clase A además informa su importe de IVA. Como la cabecera y las líneas
salen de los mismos ítems, no hay dos descripciones de la misma plata que
puedan discrepar: el IVA por línea se concilia con el redondeo agrupado por
alícuota, y que las líneas sumen la cabecera es un invariante del SDK.

Un desglose `amounts` ya revisado no tiene líneas, así que
`{ service: "wsmtxca" }` con `amounts` se rechaza con `ArcaInputError`: WSMTXCA
necesita `items` con detalle.

`unitPrice` es la única excepción monetaria del SDK: un **string decimal en
unidades mayores** con hasta seis decimales, para no perder la precisión del
precio unitario del proveedor. Todos los demás importes del ítem son enteros en
centavos.

El SDK arma las dos codificaciones de proveedor; la aplicación no construye
arrays SOAP.

## Previsualizar

`preview(input, { service: "wsmtxca" }).request` es el request de WSMTXCA sin
número de comprobante:

```ts
const previsualizacion = arca.preview(input, { service: "wsmtxca" });
previsualizacion.request.comprobanteCAERequest.importeTotal; // number
```

Con `include: { sent: true }`, un resultado autorizado trae en `sent` el
request de WSMTXCA que efectivamente se envió. Los llamadores de WSFE
conservan sus tipos `WsfeVoucherInput` de siempre.

## FCE en los dos proveedores

Los datos de negocio son los mismos: `fce: { cbu, alias?, transfer?, reference? }`
en la factura y `fce: { annulment, reference? }` en la nota. La codificación,
en cambio, difiere:

| Dato | WSFE | WSMTXCA |
| --- | --- | --- |
| CBU / alias | opcionales 2101 y 2102 | dato adicional 21, combinado (`c1`/`c2`) |
| Anulación | opcional 22 | dato adicional 22 |
| Transferencia | opcional 27 | dato adicional 27 |

No dupliques estas entradas a través de `optionalFields` cuando ya usás `fce`.

## Consulta y reservas

La consulta de WSMTXCA compara la evidencia completa del detalle, no solo el
total de cabecera, así que una reserva repetida se resuelve contra los ítems
que ARCA tiene registrados. Si la consulta vuelve incompleta, el resultado
queda `indeterminate` y no se reenvía nada.

Las reservas guardan el proveedor. Una reserva de WSMTXCA, o cualquier reserva
con líneas de proveedor, se escribe como registro `v: 2`; la versión 0.10 no puede
reproducirla, justamente para que no reenvíe por WSFE un comprobante que era de
WSMTXCA. Ver [Stores](./stores.md#store-propio-y-vida-de-los-registros).

Para el acceso directo a `client.wsmtxca` —`issue()`,
`getLastAuthorizedVoucher()`, `getVoucher()`— mirá
[Módulos de transporte](./referencia.md#clientwsmtxca).
