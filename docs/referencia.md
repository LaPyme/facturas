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
con `lookup.kind === "aborted"` y `recover()` concilia la reserva. Está
documentado en [Facturas](./facturas.md#reintentos-seguros-con-clave-de-idempotencia).

Tipos exportados de la fachada, además de `IssueInput`, `IssueOptions`,
`IssueOutcome`, `IssuePreview`, `IssuedVoucher` y `VouchersService`:
`DebitNoteInput`, `PeriodNoteInput`, `PreviewOptions`, `RecoveryOptions`,
`ExactIssueInput`, `IssuanceService`, `FceOptions`, `InvoiceFamily`,
`IssuanceFields`, `Tribute`, `VoucherAmounts`, `VoucherItemDetail` y
`WsmtxcaIssueRequest`.

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

## Seguridad

- Tratá los certificados y las claves privadas como secretos.
- Por defecto, los tickets WSAA se cachean solo en memoria.
- El SDK persiste los tickets WSAA cuando le pasás `store` o
  `wsaaSessionStore`. Mantené privado su almacenamiento; los adaptadores
  incluidos nunca guardan la configuración de certificado ni de clave privada.
- Las implementaciones de `wsaaSessionStore` en producción tendrían que cifrar
  las credenciales en reposo o usar un backend que provea cifrado en reposo.
