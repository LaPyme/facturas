# Referencia

## Datos de referencia

El paquete exporta un conjunto chico y estable de códigos comunes de ARCA desde
`facturas/constants`.

```ts
import {
  ARCA_CONCEPT_TYPES,
  ARCA_CURRENCY_IDS,
  ARCA_CURRENCIES,
  ARCA_DOCUMENT_TYPES,
  ARCA_RECEIVER_VAT_CONDITIONS,
  ARCA_VAT_RATES,
  ARCA_VOUCHER_TYPES,
  ISO_CURRENCIES,
} from "facturas/constants";

ARCA_VOUCHER_TYPES.FACTURA_A; // 1
ARCA_VOUCHER_TYPES.FACTURA_B; // 6
ARCA_DOCUMENT_TYPES.CUIT; // 80
ARCA_DOCUMENT_TYPES.DNI; // 96
ARCA_DOCUMENT_TYPES.CONSUMIDOR_FINAL; // 99
ARCA_RECEIVER_VAT_CONDITIONS.RESPONSABLE_INSCRIPTO; // 1
ARCA_RECEIVER_VAT_CONDITIONS.CONSUMIDOR_FINAL; // 5
ARCA_CONCEPT_TYPES.SERVICIOS; // 2
ARCA_VAT_RATES.IVA_21; // 5
ISO_CURRENCIES.ARS; // "ARS"
ARCA_CURRENCY_IDS.USD; // "DOL"
ARCA_CURRENCIES.PES; // "PES"
ARCA_CURRENCIES.DOL; // "DOL"
```

Las constantes cubren los valores más comunes que usan la documentación y los
ejemplos:

- tipos de comprobante para factura A/B/C, nota de débito A/B/C y nota de
  crédito A/B/C
- tipos de documento para CUIT, DNI y consumidor final
- condiciones de IVA del receptor más comunes, sujetas a las reglas de clase de
  comprobante y de catálogo en vivo
- tipos de concepto para productos, servicios y productos + servicios
- alícuotas de IVA `0`, `2.5`, `5`, `10.5`, `21` y `27`
- monedas ISO de los builders, `ARS` y `USD`, con sus mapeos explícitos a `PES`
  y `DOL` en ARCA

`ARCA_CURRENCIES` sigue siendo un alias de compatibilidad deprecado con sus
valores `PES` y `DOL`. Si necesitás catálogos más amplios en tiempo de
ejecución, siguen disponibles los métodos de WSFE como `getVoucherTypes()`,
`getDocumentTypes()`, `getCurrencyTypes()` y `getVatRates()`.
`getCurrencyTypes()` devuelve identificadores en vivo de ARCA, no códigos ISO.

## API pública (semver)

Métodos del cliente cubiertos por semver: `issue`, `preview`, `recover`,
`issueCreditNote`, `issueDebitNote`, `previewCreditNote`, `previewDebitNote`, y
los módulos `wsfe`, `wsmtxca` y `padron`.

Las opciones de emisión también entran en semver. Junto a `idempotencyKey`,
`signal` toma un `AbortSignal` y corta el login WSAA, la escritura y las
consultas de esa llamada; un corte posterior al envío devuelve `indeterminate`
con `lookup.kind === "aborted"` y `recover()` concilia la reserva. Los `lookup`
de un `indeterminate` incluyen además `blocked`, mientras otra clave sin
resolver frena la secuencia, y `superseded`, cuando la secuencia siguió sin
esta clave y hay que emitir bajo una clave nueva. Está documentado en
[Facturas](./facturas.md#reintentos-seguros-con-clave-de-idempotencia).

Tipos exportados de la fachada, además de `IssueInput`, `IssueOptions`,
`IssueOutcome`, `IssuePreview`, `IssuedVoucher` y `VouchersService`:
`DebitNoteInput`, `NotePreview`, `PeriodNoteInput`, `PreviewOptions`,
`RecoveryOptions`, `ExactIssueInput`, `IssuanceService`, `FceOptions`,
`InvoiceFamily`, `IssuanceFields`, `Tribute`, `VoucherAmounts`,
`VoucherItemDetail` y `WsmtxcaIssueRequest`.

Entradas documentadas:

- `facturas`
- `facturas/constants`
- `facturas/wsfe`
- `facturas/wsmtxca`
- `facturas/padron`
- `facturas/errors`
- `facturas/types`

Los internos de bajo nivel de SOAP, HTTP y WSAA no forman parte del contrato de
semver.

Ejemplo con subpaths:

```ts
import { createWsfeService } from "facturas/wsfe";
import { ARCA_VOUCHER_TYPES } from "facturas/constants";
import { ArcaServiceError } from "facturas/errors";
```

## Módulos de transporte

`client.wsfe`, `client.wsmtxca` y `client.padron` son la capa que la fachada
usa por debajo. Ahí viven las lecturas, los catálogos, el estado del servicio y
el Padrón, y son la costura que los tests de integración reemplazan por un
doble. No son otra forma de emitir: la emisión entra por `issue()`,
`issueCreditNote()`, `issueDebitNote()` y sus vistas previas, que derivan el
comprobante, reservan el número y recuperan los reintentos.

Los inputs usan nombres al estilo JS y el SDK los mapea internamente a los
campos SOAP de ARCA. Los campos de fecha aceptan `YYYY-MM-DD` o `YYYYMMDD`.
Los métodos autenticados aceptan `forceRefresh: true` para descartar el TA WSAA
cacheado y pedir un Token Authorization nuevo para ese servicio.

### `client.wsfe`

- `issue({ voucherNumber, data })` manda una autorización y devuelve evidencia
  `authorized`, `rejected` o `indeterminate`.
- `getNextVoucherNumber({ salesPoint, voucherType })` lee el próximo número.
- `getVoucherInfo({ number, salesPoint, voucherType })` devuelve el detalle del
  comprobante o `null`.
- `lookupVoucher({ number, salesPoint, voucherType })` devuelve la consulta
  normalizada, con `not_found` para el código 602 de `FECompConsultar`.
- `getSalesPoints()` devuelve los puntos de venta; el código 602 de
  `FEParamGetPtosVenta` es una lista vacía, que es como ARCA informa un
  contribuyente sin puntos de venta para web services.
- Los catálogos en vivo, como `getVoucherTypes()`, `getDocumentTypes()`,
  `getCurrencyTypes()` y `getVatRates()`, para datos de referencia sin valores
  fijos en el código.
- `getServerStatus()` para la salud del backend.

### `client.wsmtxca`

- `issue({ data })`
- `getLastAuthorizedVoucher({ voucherType, salesPoint })`, donde el código 1502
  devuelve el número de comprobante `0`.
- `getVoucher({ voucherType, salesPoint, voucherNumber })` y `lookupVoucher()`,
  donde el código 1503 de `consultarComprobante` es `not_found`. El código 602
  de WSMTXCA no es ausencia de comprobante y sigue siendo un error.
- `getSalesPoints()` para los puntos de venta habilitados en WSMTXCA.

Para emitir por WSMTXCA con detalle de ítems, pasá `{ service: "wsmtxca" }` a
la fachada: ver [WSMTXCA](./wsmtxca.md).

### `client.padron`

- `getTaxpayerDetails(taxId)` devuelve los datos del contribuyente o `null`.
- `getTaxIdByDocument(documentNumber)` resuelve CUIT candidatos a partir de un
  número de documento, o `null`.

El manejo de "no encontrado" en Padrón depende hoy del texto del mensaje del
SOAP fault de ARCA, así que es más frágil que los flujos de WSFE basados en
códigos.

### Un intento por llamada

`wsfe.issue()` y `wsmtxca.issue()` fuerzan un único intento de transporte SOAP,
incluso cuando el cliente tiene configurados reintentos generales. Nunca
refrescan credenciales ni reenvían de forma automática. Un rechazo de
autenticación explícito del proveedor vuelve como
`reason: "authentication_rejected"` con evidencia tipada y segura en
`authentication`; un timeout, una falla de conexión, una respuesta inválida o
un resultado incompleto o contradictorio quedan indeterminados y sin reenvío.
Así se evita que un trabajo fiscal incierto provoque una segunda autorización
oculta.

Las operaciones autenticadas de lectura, catálogo y consulta pueden repetirse
una vez con un refresco forzado de credenciales después de un rechazo de
autenticación explícito y tipado. Pasar `forceRefresh: true` desactiva
cualquier otro intento de recuperación de autenticación.

## Seguridad

- Tratá los certificados y las claves privadas como secretos.
- Por defecto, los tickets WSAA se cachean solo en memoria.
- El SDK persiste los tickets WSAA cuando le pasás `store` o
  `wsaaSessionStore`. Mantené privado su almacenamiento; los adaptadores
  incluidos nunca guardan la configuración de certificado ni de clave privada.
- Las implementaciones de `wsaaSessionStore` en producción tendrían que cifrar
  las credenciales en reposo o usar un backend que provea cifrado en reposo.
