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

`details` es el detalle del comprobante. Cada fila lleva `description`,
`quantity`, `unit`, `unitPrice`, `vatCondition`, `vatAmount` cuando
corresponde, y `amount`; opcionalmente `discount`, `code`, `matrixCode` y
`matrixUnits`.

Este bloque sale de
[examples/emision-completa.ts](../examples/emision-completa.ts):

```ts
const input = {
  issuer: "responsable_inscripto",
  salesPoint: 1,
  to: { condition: "responsable_inscripto", cuit: "20123456789" },
  items: [{ net: 10_000, vat: 21 }],
  details: [
    {
      description: "Product",
      quantity: 1,
      unit: 7,
      unitPrice: "100.000000",
      vatCondition: 5,
      vatAmount: 2100,
      amount: 12_100,
    },
  ],
} satisfies IssueInput;
```

Los importes de los ítems incluyen el IVA, y un ítem de clase A además informa
su importe de IVA. Los totales del detalle tienen que conciliar con la
cabecera fiscal, sin contar los tributos. Los agregados fiscales salen del
mismo `items` o `amounts` que usa WSFE: el detalle no reemplaza al desglose.

`unitPrice` es la única excepción monetaria del SDK: un **string decimal en
unidades mayores** con hasta seis decimales, para no perder la precisión del
precio unitario del proveedor. Todos los demás importes del detalle son
enteros en centavos.

El SDK arma las dos codificaciones de proveedor; la aplicación no construye
arrays SOAP.

## Previsualizar

`preview(input, { service: "wsmtxca" }).request` es el request de WSMTXCA sin
número de comprobante:

```ts
const previsualizacion = arca.preview(input, { service: "wsmtxca" });
previsualizacion.request.comprobanteCAERequest.importeTotal; // number
```

Con `include: { exactInput: true }`, un resultado autorizado trae en `sent` el
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
con detalle, se escribe como registro `v: 2`; la versión 0.10 no puede
reproducirla, justamente para que no reenvíe por WSFE un comprobante que era de
WSMTXCA. Ver [Stores](./stores.md#store-propio-y-vida-de-los-registros).

Para el acceso directo a `client.wsmtxca` —`issue()`,
`getLastAuthorizedVoucher()`, `getVoucher()`— mirá
[Módulos de transporte](./referencia.md#clientwsmtxca).
