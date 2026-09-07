# Capa exacta

La fachada deriva el comprobante por vos. La capa exacta te deja armar el
`WsfeVoucherInput` completo, dueño de tu propia numeración, y te devuelve la
evidencia del proveedor tal como llegó.

## Control exacto

Este bloque es
[examples/factura-b-consumidor-final.ts](../examples/factura-b-consumidor-final.ts):

```ts
import { buildFacturaB, createArcaClient } from "facturas";
import {
  ARCA_CONCEPT_TYPES,
  ARCA_DOCUMENT_TYPES,
  ARCA_RECEIVER_VAT_CONDITIONS,
} from "facturas/constants";

const client = createArcaClient({
  taxId: "20123456786",
  certificatePem:
    "-----BEGIN CERTIFICATE-----\nREPLACE_WITH_YOUR_CERTIFICATE\n-----END CERTIFICATE-----",
  privateKeyPem:
    "-----BEGIN PRIVATE KEY-----\nREPLACE_WITH_YOUR_PRIVATE_KEY\n-----END PRIVATE KEY-----",
  environment: "test",
});

async function main() {
  const data = buildFacturaB({
    salesPoint: 1,
    concept: ARCA_CONCEPT_TYPES.PRODUCTOS,
    documentType: ARCA_DOCUMENT_TYPES.CONSUMIDOR_FINAL,
    documentNumber: 0,
    receiverVatConditionId: ARCA_RECEIVER_VAT_CONDITIONS.CONSUMIDOR_FINAL,
    voucherDate: "2026-09-02",
    taxableAmount: 10_000,
    vatRate: 21,
  });

  // Exact layer: reserve the number yourself, then issue it exactly once.
  const voucherNumber = await client.wsfe.getNextVoucherNumber({
    salesPoint: data.salesPoint,
    voucherType: data.voucherType,
  });
  const issued = await client.wsfe.issue({ voucherNumber, data });

  if (issued.kind === "authorized") {
    console.log(issued.cae, issued.caeExpiry, issued.voucherNumber);
  } else {
    console.error(issued.kind, issued);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

`buildFacturaB()` deriva el tipo Factura B, el neto, el detalle de IVA, el
importe de IVA, los campos en cero y el total, sin aritmética fiscal de punto
flotante. `buildFacturaC()` arma aparte la forma de la Factura C con IVA cero.
Los dos builders aceptan enteros en centavos de la moneda y soportan las ISO
`ARS` (la de por defecto) y `USD`. Factura B requiere un `taxableAmount`
positivo; cuando `vatRate` es positivo, el importe tiene que producir al menos
un centavo de IVA después del redondeo. El IVA usa el criterio Round Half Even
documentado por ARCA, así que un medio centavo exacto se redondea al centavo
par.

Para una factura en USD, pasá el tipo de cambio como string decimal:

```ts
const usdData = buildFacturaB({
  salesPoint: 1,
  concept: ARCA_CONCEPT_TYPES.PRODUCTOS,
  documentType: ARCA_DOCUMENT_TYPES.CONSUMIDOR_FINAL,
  documentNumber: 0,
  receiverVatConditionId: ARCA_RECEIVER_VAT_CONDITIONS.CONSUMIDOR_FINAL,
  voucherDate: "2026-09-02",
  taxableAmount: 10_000, // USD 100.00.
  vatRate: 21,
  currency: "USD",
  exchangeRate: "1095.500000",
});
```

## Superficie de servicios

### `client.wsfe`

Facturación electrónica WSFE. Los inputs usan nombres al estilo JS y el SDK los
mapea internamente a los campos SOAP de AFIP / ARCA.

- Los campos de fecha aceptan `YYYY-MM-DD` o `YYYYMMDD`.
- Armá facturas A/B/C desde afirmaciones explícitas con la fachada de arriba.
- Emití facturas y notas de crédito con los métodos exactos de WSFE.
- `issue({ voucherNumber, data })` manda una autorización exacta y devuelve
  evidencia `authorized`, `rejected` o `indeterminate`.
- `getNextVoucherNumber({ salesPoint, voucherType })` lee el próximo número a
  reservar.
- `getVoucherInfo({ number, salesPoint, voucherType })` devuelve el detalle del
  comprobante o `null`.
- Consultá números y detalles de comprobantes.
- Leé los catálogos de ARCA con métodos como `getVoucherTypes()` y
  `getVatRates()`. Hay métodos de catálogo disponibles para datos de referencia
  en vivo cuando no querés valores fijos en el código.
- Verificá la salud del backend con `getServerStatus()`.
- Los métodos autenticados aceptan `forceRefresh: true` para descartar el TA
  WSAA cacheado y pedir un Token Authorization nuevo para el mismo servicio.

### `client.padron`

- `getTaxpayerDetails(taxId)` devuelve los datos del contribuyente o `null`.
- `getTaxIdByDocument(documentNumber)` resuelve CUIT candidatos a partir de un
  número de documento, o `null`.

El manejo de "no encontrado" en Padrón depende hoy del texto del mensaje del
SOAP fault de ARCA, así que es más frágil que los flujos de WSFE basados en
códigos.

### `client.wsmtxca`

- `issue({ data })`
- `getLastAuthorizedVoucher({ voucherType, salesPoint })`
- `getVoucher({ voucherType, salesPoint, voucherNumber })`
- Los métodos autenticados aceptan `forceRefresh: true` para renovar el TA WSAA
  de WSMTXCA antes de la llamada.

La fachada también emite por WSMTXCA, con detalle de ítems, cuando pasás
`{ service: "wsmtxca" }`: ver [WSMTXCA](./wsmtxca.md). Esta capa exacta sigue
disponible para armar el request completo vos mismo. Si necesitás `issue`,
`getLastAuthorizedVoucher`, `lookupVoucher`, `getVoucher` o `getSalesPoints`, la
API de runtime está disponible, es pública y está cubierta por tests.

## Emisión exacta y evidencia de recuperación

`client.issue()` deriva el request de WSFE, reserva el número y recupera
después de una caída por vos. Cuando necesitás algo que no deriva (una nota en
otra moneda o a otro receptor, o cualquier campo fuera de la
[superficie de la fachada](./facturas.md#datos-de-la-factura)) o la
numeración es de tu aplicación, usá la capa exacta: `client.wsfe.issue(...)`
manda un FECAESolicitar para un número de comprobante que reservaste vos de
forma durable, y te dice si ese intento exacto quedó autorizado, rechazado o
indeterminado. Preserva cada error y observación estructurados con su servicio,
operación, código, origen y nivel de resultado.

```ts
const outcome = await client.wsfe.issue({
  voucherNumber: reservedVoucherNumber,
  data,
});

if (outcome.kind === "authorized") {
  console.log(outcome.cae, outcome.voucherNumber);
} else if (outcome.kind === "rejected") {
  console.error(outcome.errors, outcome.observations);
} else {
  if (outcome.reason === "authentication_rejected") {
    console.error(outcome.authentication?.reason);
  }
  // Consult the same number before any new authorization attempt.
  const lookup = await client.wsfe.lookupVoucher({
    number: reservedVoucherNumber,
    salesPoint: data.salesPoint,
    voucherType: data.voucherType,
  });
  console.log(lookup.kind);
}
```

`wsfe.issue()` y `wsmtxca.issue()` fuerzan un único intento de transporte SOAP,
incluso cuando el cliente tiene configurados reintentos generales de
transporte. Nunca refrescan credenciales ni reenvían de forma automática. Un
rechazo de autenticación explícito del proveedor vuelve como
`reason: "authentication_rejected"` con evidencia tipada y segura en
`authentication`; un timeout, una falla de conexión, una respuesta inválida o
un resultado incompleto o contradictorio quedan indeterminados y sin reenvío.
Así se evita que un trabajo fiscal incierto provoque una segunda autorización
oculta.

Las operaciones autenticadas de lectura, catálogo y consulta pueden repetirse
una vez con un refresco forzado de credenciales después de un rechazo de
autenticación explícito y tipado. Pasar `forceRefresh: true` desactiva
cualquier otro intento de recuperación de autenticación.

La ausencia en las consultas exactas depende de la operación:

- WSFE `FECompConsultar` código 602 devuelve `not_found`.
- WSMTXCA `consultarComprobante` código 1503 devuelve `not_found`.
- WSMTXCA `consultarUltimoComprobanteAutorizado` código 1502 devuelve el número
  de comprobante `0`.
- El código 602 de WSMTXCA no es ausencia de comprobante exacto y sigue siendo
  un error.

El SDK normaliza solamente la evidencia de protocolo del proveedor. Tu
aplicación sigue siendo responsable de persistir el request exacto, de ser
dueña de su secuencia o carril, y de decidir cuándo un reintento es seguro.

Para los campos fiscales que la fachada no expone, usá la salida de emergencia
`WsfeVoucherInput`. También sigue soportando exenciones, importes no gravados y
varias alícuotas de IVA. Los importes exactos siguen siendo números en unidades
mayores, se validan localmente y se serializan como strings canónicos de dos
decimales:

```ts
import type { WsfeVoucherInput } from "facturas/wsfe";
import {
  ARCA_CONCEPT_TYPES,
  ARCA_CURRENCY_IDS,
  ARCA_DOCUMENT_TYPES,
  ARCA_RECEIVER_VAT_CONDITIONS,
  ARCA_VAT_RATES,
  ARCA_VOUCHER_TYPES,
} from "facturas/constants";

const exactData: WsfeVoucherInput = {
  salesPoint: 1,
  voucherType: ARCA_VOUCHER_TYPES.FACTURA_B,
  concept: ARCA_CONCEPT_TYPES.PRODUCTOS,
  documentType: ARCA_DOCUMENT_TYPES.CONSUMIDOR_FINAL,
  documentNumber: 0,
  receiverVatConditionId: ARCA_RECEIVER_VAT_CONDITIONS.CONSUMIDOR_FINAL,
  voucherDate: "2026-09-02",
  totalAmount: 121,
  nonTaxableAmount: 0,
  netAmount: 100,
  exemptAmount: 0,
  taxAmount: 0,
  vatAmount: 21,
  currencyId: ARCA_CURRENCY_IDS.ARS,
  exchangeRate: "1",
  vatRates: [{ id: ARCA_VAT_RATES.IVA_21, baseAmount: 100, amount: 21 }],
};
```

Los inputs exactos y las respuestas de catálogo en vivo usan identificadores de
protocolo de ARCA como `PES` y `DOL`; la fachada y los builders de alto nivel
aceptan las ISO `ARS` y `USD`.

## Migrar importes y monedas

Las aplicaciones que antes redondeaban valores decimales en unidades mayores y
traducían monedas a IDs de ARCA pueden mover ese trabajo de frontera del
proveedor a un builder:

```ts
// Before: caller-owned decimal rounding and provider vocabulary.
const exactAmount = Number(sourceAmount.toFixed(2));
const exactCurrencyId = sourceCurrency === "ARS" ? "PES" : "DOL";

// After: integer minor units and ISO currency input.
const data = buildFacturaB({
  salesPoint: 1,
  concept: ARCA_CONCEPT_TYPES.PRODUCTOS,
  documentType: ARCA_DOCUMENT_TYPES.CONSUMIDOR_FINAL,
  documentNumber: 0,
  receiverVatConditionId: ARCA_RECEIVER_VAT_CONDITIONS.CONSUMIDOR_FINAL,
  voucherDate: "2026-09-02",
  taxableAmount: 10_000, // 100.00 in the selected currency.
  vatRate: 21,
  currency: "USD",
  exchangeRate: "1095.5",
});
```

Seguí usando `WsfeVoucherInput` cuando necesites campos exactos avanzados. Sus
importes siguen siendo valores decimales en unidades mayores y su `currencyId`
sigue siendo un ID de ARCA.
