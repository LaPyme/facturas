# facturas

[![npm version](https://img.shields.io/npm/v/facturas.svg)](https://www.npmjs.com/package/facturas)
[![CI](https://github.com/LaPyme/facturas/actions/workflows/ci.yml/badge.svg)](https://github.com/LaPyme/facturas/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](https://github.com/LaPyme/facturas/blob/main/LICENSE)

Node.js SDK for ARCA / AFIP invoicing, credit notes and Padrón, with direct WSFE and WSMTXCA integration. [Inicio rápido en español](./docs/inicio-rapido.md).

- **ESM-only**, Node.js **>= 20**
- **Direct ARCA integration** with no proxy or hosted dependency
- **WSAA login handling** with in-memory ticket cache, optional durable session stores, in-flight deduplication, and recovery for `coe.alreadyAuthenticated`
- **Strict TypeScript** public API with JS-style field names mapped to SOAP internally
- **Common ARCA reference data** exported as constants so examples and app code do not need magic numbers
- **Copy-pasteable examples** designed to be readable by humans and coding agents

## Install

```bash
pnpm add facturas
```

```bash
npm install facturas
```

## Issue an invoice

Set the [environment variables](#configuration), provision the store table below,
and use the sale's stable ID as the key. The example assumes `venta` is your sale.

```ts
import { createArcaClient, createPostgresStore } from "facturas";
import { sql } from "@vercel/postgres";

const arca = createArcaClient({
  store: createPostgresStore({ query: (text, params) => sql.query(text, params) }),
});

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

Without `idempotencyKey`, a retry after a crash
can issue the invoice twice. Configure a `store` and pass the key so retries
are safe.

A key is 1–255 characters. Use the sale or order ID, never a new UUID for each
attempt. Do not put CUIT, DNI or other personal data in keys. Reuse the same
key and input on retries; changed input throws `ARCA_INPUT_IDEMPOTENCY_MISMATCH`.
Keys are scoped to the client's CUIT and environment. `representedTaxId` is
also checked as part of the input identity. A key without a store throws before
provider I/O. Different keys identify different business operations; a key does
not reserve the entire point-of-sale sequence against other writers.

## Production smoke test and cancellation

After enabling ARCA access and selecting a production point of sale, this emits
an ARS 1 invoice and a full associated credit note. **Both documents are real
and remain in ARCA's records.** The note is a separate operation; a failure
leaves the invoice outstanding. Match `issuer` to your actual tax condition.

```ts
const arca = createArcaClient({ environment: "production" });
const factura = await arca.vouchers.issue({
  issuer: "monotributo",
  salesPoint: 3,
  to: { condition: "consumidor_final" },
  items: [{ amount: 100 }], // ARS 1.00
});
if (factura.kind === "authorized") {
  const nota = await arca.vouchers.cancel(factura.voucher);
  console.log(nota); // Handle every outcome, including a failed credit note.
}
```

`cancel({ salesPoint, voucherType, number }, options)` looks up the original,
then mirrors its full amount into credit note A, B or C (types 3, 8, 13).
It preserves the receiver, currency, exchange rate, VAT rates and service dates.
The note date defaults to today in Buenos Aires; use `options.date` to override.
The payment due date cannot precede the note date. `idempotencyKey` and `include`
work exactly as for `issue()`; give cancellation its own stable key, such as
`cancel:${venta.id}`. Replaying that key consults only the reserved note.

Only authorized invoice types 1, 6 and 11 in ARS or USD are supported.
Originals with tributes, optional fields, buyers, activities or associated
periods require the exact API. Partial notes, debit notes and FCE also require
exact control. Missing original evidence is an error, never guessed.

## Stores

One `store` persists WSAA tickets and immutable invoice/credit-note reservations.
The SDK adds no database or Redis driver dependency. Store failures throw
`ArcaConfigurationError` with their cause attached and a content-free message.

### Postgres

Use your application's existing client. Neon, Supabase Postgres, Vercel Postgres,
`pg` and `postgres` can provide the parameterized query function. Results can
be an array of rows or `{ rows }`. With `postgres`, adapt `sql.unsafe(text, params)`.
Provision the default table once:

```sql
CREATE TABLE arca_store (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

```ts
const store = createPostgresStore({
  query: (text, params) => sql.query(text, params),
  table: "arca_store", // Optional simple SQL identifier.
});
```

Atomic creation uses `INSERT ... ON CONFLICT DO NOTHING RETURNING key`.
The adapter does not create the table or hold a database lock.

### Redis

```ts
import { createRedisStore } from "facturas";
const store = createRedisStore(redis);
// Optional override: createRedisStore(redis, { flavor: "upstash" });
```

A client with `call` uses ioredis `SET key value NX`; otherwise the adapter
uses Upstash `set(key, value, { nx: true })`. Use a durable Redis deployment
without eviction of reservation keys. Neither flavor applies a TTL or lock.

### Files

```ts
import { createFileStore } from "facturas";
const store = createFileStore("/private/durable/arca");
```

Use a private durable volume on a single server. Keys are hashed to filenames;
creation is exclusive, replacement uses a temporary file and rename. Files
have mode `0600`, new directories `0700`. No process lock is provided.

### Memory

```ts
import { createMemoryStore } from "facturas";
const store = createMemoryStore();
```

For tests and examples. It serializes ticket refreshes within the shared object,
but **does not survive a restart**. It does not make serverless retries durable.

### Custom store and record lifetime

```ts
type ArcaStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  add(key: string, value: string): Promise<boolean>;
  delete?(key: string): Promise<void>;
  withLock?<T>(key: string, fn: () => Promise<T>): Promise<T>;
};
```

`add` must atomically return false without changing an existing value. Optional
`withLock` coordinates WSAA ticket refreshes. Explicit `wsaaSessionStore` wins
for tickets when both options are provided.

Keys use `arca:v1:wsaa:{environment}:{service}:{fingerprint}` and
`arca:v1:attempt:{environment}:{taxId}:{idempotencyKey}`. Reservation records
contain the input hash, operation, reserved coordinates and exact sent input.
They contain fiscal/customer data: restrict access and protect backups.

**Do not prune, expire or rewrite reservation records.** The SDK only creates
them, never saves outcomes over them, and always consults ARCA on replay.
Deleting a reservation can let a later retry issue another invoice.

## Invoice inputs

The issuer is your legal assertion on each call; the SDK never infers it from
items or Padrón. An RI issuer produces A for RI or Monotributo receivers and B
for the other supported conditions. Monotributo, Exento and No Alcanzado issuers
produce C and use `items: [{ amount: 10_000 }]`. ARCA validates actual eligibility.
`to` is the fiscal receiver (the exact layer's receiver document/condition fields),
not a customer record.

Amounts are integer minor units. For RI items, choose `net` or `gross` on each
item and one of `0 | 2.5 | 5 | 10.5 | 21 | 27 | "exempt" | "untaxed"` for `vat`.
Numeric zero is a VAT rate; exempt and untaxed amounts have separate fiscal
fields. Items are grouped by rate before Round Half Even rounding.

`total`, when supplied, asserts the sent total. The SDK adjusts header VAT only
within one cent per emitted numeric rate, while keeping VAT non-negative.
Class C totals must match exactly. Authorized results expose `computedTotal`,
`sentTotal` and `vatAdjustment` in `voucher.amounts`, all in minor units.

The defaults are today's date in Buenos Aires, goods (concept 1), and `ARS` at
exchange rate `1`. Use `currency: "USD"` with a positive decimal-string
`exchangeRate`, or `service: { from, to, dueDate }` for concept 2. Dates accept
`YYYY-MM-DD` or `YYYYMMDD`; service end must be on or after its start and the payment due
date must be on or after the invoice date.

Non-final-consumer receivers require an 11-digit `cuit`. A final consumer accepts
one `cuit` or `dni`, or neither below the identification threshold. At or above
ARS 10,000,000 (including USD converted at the supplied rate), identification is
required under [RG 5866/2026](https://www.argentina.gob.ar/normativa/nacional/norma-427092/texto).
When the customer requests a CUIT for an income-tax deduction, supply it regardless
of amount. Document shape checks do not verify provider registration.

### Facade fiscal contract

Without a key, a call reads one next number and authorizes once, with at most
one identity lookup after an indeterminate response. This is the v0.8 behavior.
A first keyed call reserves that number before writing. A keyed replay looks
up the reservation: only `not_found` allows one authorization of the stored
number. A found voucher is never resubmitted. Indeterminate writes and keyed
10016 rejections can add one lookup; a 10016 without a complete match remains
rejected. Cancel adds the original lookup only when creating a new reservation.

| Outcome | Meaning and caller action |
| --- | --- |
| `authorized` | Save the voucher and CAE. `recoveredByMatch: true` means the stored input matched the consulted identity; it proves consistency, not authorship. |
| `rejected` | Review ARCA's `issues`. A key remains bound to its input even after rejection. |
| `indeterminate` | Preserve the number and evidence. Reconcile or retry the identical input with its existing key. |
| `conflict` | A different voucher occupies the reserved number. Stop and investigate. |

The second argument accepts `idempotencyKey`, `representedTaxId`, `forceRefresh`
and `include: { raw: true, exactInput: true }`. Outcomes are raw-free by default;
`sent` is included only on authorized outcomes when requested. Replay without
an observed write outcome uses an indeterminate attempt with
`reason: "incomplete_response"`; the lookup provides the authorization evidence.

The identity matcher compares coordinates, date, concept, receiver, currency,
all header amounts, VAT rates, service dates, and note associations. Missing
fields stay incomplete; differences are conflicts. Unsupported exact extensions
remain incomplete. Use exact APIs for tributes, FCE, other receiver conditions,
same-currency foreign cancellation and WSMTXCA.

## Exact control

This example mirrors [examples/factura-b-consumidor-final.ts](./examples/factura-b-consumidor-final.ts).

```ts
import { buildFacturaB, createArcaClient } from "facturas";
import {
  ARCA_CONCEPT_TYPES,
  ARCA_DOCUMENT_TYPES,
  ARCA_RECEIVER_VAT_CONDITIONS,
} from "facturas/constants";

const client = createArcaClient({
  taxId: "20123456789",
  certificatePem:
    "-----BEGIN CERTIFICATE-----\nREPLACE_WITH_YOUR_CERTIFICATE\n-----END CERTIFICATE-----",
  privateKeyPem:
    "-----BEGIN PRIVATE KEY-----\nREPLACE_WITH_YOUR_PRIVATE_KEY\n-----END PRIVATE KEY-----",
  environment: "test",
});

const data = buildFacturaB({
  salesPoint: 1,
  concept: ARCA_CONCEPT_TYPES.PRODUCTOS,
  documentType: ARCA_DOCUMENT_TYPES.CONSUMIDOR_FINAL,
  documentNumber: 0,
  receiverVatConditionId: ARCA_RECEIVER_VAT_CONDITIONS.CONSUMIDOR_FINAL,
  // Deterministic example date; use an ARCA-allowed current date in homologation.
  voucherDate: "2026-09-02",
  taxableAmount: 10_000, // Integer minor units: ARS 100.00.
  vatRate: 21,
  // currency is omitted, so the builder defaults to ISO ARS.
});

// Exact convenience: the caller coordinates numbering and recovery.
const issued = await client.wsfe.createNextVoucher({
  data,
});

console.log(issued.cae, issued.caeExpiry, issued.voucherNumber);
```

`buildFacturaB()` derives the Factura B type, net amount, IVA detail, IVA
amount, zero-value fields, and total without floating-point tax arithmetic.
`buildFacturaC()` separately builds the zero-IVA Factura C shape. Both builders
accept integer currency minor units and support ISO `ARS` (the default) and
`USD`. Factura B requires a positive `taxableAmount`; when `vatRate` is
positive, the amount must produce at least one currency minor unit of IVA after
rounding. IVA uses the Round Half Even criterion documented by ARCA, so an
exact half-cent is rounded to the even cent.

For a USD invoice, pass a decimal-string exchange rate:

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

## What You Can Do Today

### WSFE

- Build A/B/C invoices from explicit assertions with the facade above
- Issue invoices and credit notes with the existing exact WSFE methods
- Query voucher numbers and voucher details
- Read ARCA catalogs with methods like `getVoucherTypes()` and `getVatRates()`
- Check backend health with `getServerStatus()`

### Padrón

- Look up taxpayer data with `client.padron.getTaxpayerDetails(...)`
- Resolve CUITs from document numbers with `client.padron.getTaxIdByDocument(...)`

### WSMTXCA

WSMTXCA remains supported and exported, but this package currently puts most editorial focus on WSFE and Padrón. If you need `authorizeVoucher`, `authorizeVoucherOutcome`, `getLastAuthorizedVoucher`, `lookupVoucher`, `getVoucher`, or `getSalesPoints`, the runtime API is available and covered by tests.

## Exact authorization and recovery evidence

Use `authorizeVoucherOutcome(...)` with a caller-owned, durably reserved voucher
number when your application must decide whether one exact fiscal attempt was
authorized, rejected, or left indeterminate. It preserves every structured
error and observation with its service, operation, code, source, and result
level.

```ts
const outcome = await client.wsfe.authorizeVoucherOutcome({
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

Authorization outcome methods force one SOAP transport attempt, even when the client has general transport retries configured. They never refresh credentials and resubmit automatically. An explicit provider authentication rejection is returned as `reason: "authentication_rejected"` with safe typed `authentication` evidence; a timeout, connection failure, invalid response, or incomplete/contradictory result remains indeterminate without resubmission. This prevents uncertain fiscal work from causing a hidden second authorization.

The convenience `authorizeVoucher(...)` methods keep their success-or-throw
contract and may repeat the exact same payload once after an explicit typed
authentication rejection. WSFE `createNextVoucher(...)` applies the same rule
to the number it already fetched; it never fetches another number for the retry.
Authenticated read, catalog, and lookup convenience operations also perform at
most one forced-refresh retry. Passing `forceRefresh: true` disables any further
authentication recovery attempt.

Exact lookup absence is operation-specific:

- WSFE `FECompConsultar` code 602 returns `not_found`.
- WSMTXCA `consultarComprobante` code 1503 returns `not_found`.
- WSMTXCA `consultarUltimoComprobanteAutorizado` code 1502 returns voucher number `0`.
- WSMTXCA code 602 is not exact-voucher absence and remains an error.

The SDK normalizes provider protocol evidence only. Your application remains responsible for persisting the exact request, owning its sequence or lane, and deciding when a retry is safe.

For tributes, notes, FCE, or other advanced cases, use the exact
`WsfeVoucherInput` escape hatch. It also continues to support exemptions,
non-taxable amounts and multiple IVA rates. Exact
amounts remain major-unit numbers, are validated locally, and are serialized as
canonical two-decimal strings:

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

Exact inputs and live catalog responses use ARCA protocol identifiers such as
`PES` and `DOL`; the facade and high-level builders accept ISO `ARS` and `USD`.

### Migrating amount and currency inputs

Applications that previously rounded decimal major-unit values and translated
currencies to ARCA IDs can move that provider-boundary work into a builder:

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

Keep using `WsfeVoucherInput` when you need advanced exact fields. Its amounts
remain decimal major-unit values and its `currencyId` remains an ARCA ID.

## Examples

- [Keyed invoice](./examples/issue-invoice.ts)
- [Full credit note](./examples/anular-factura.ts)

Examples live in [examples/](./examples) and are intentionally complete, hardcoded, and readable so they can be adapted quickly by a developer or a coding agent.
Issuance examples use deterministic dates for compilation; replace them with an
ARCA-allowed current date before a homologation request.

- [factura-b-consumidor-final.ts](./examples/factura-b-consumidor-final.ts)
- [factura-a-responsable-inscripto.ts](./examples/factura-a-responsable-inscripto.ts)
- [nota-de-credito-asociada.ts](./examples/nota-de-credito-asociada.ts)
- [factura-servicios-con-periodo.ts](./examples/factura-servicios-con-periodo.ts)
- [consultar-comprobante.ts](./examples/consultar-comprobante.ts)
- [consultar-contribuyente.ts](./examples/consultar-contribuyente.ts)

## Manual Setup Reality

This package does **not** provision ARCA credentials for you. You still need to do the official certificate and service setup outside the SDK.

Before using the SDK:

1. Obtain a valid CUIT.
2. Generate or receive a certificate and matching private key in PEM format.
3. Authorize the certificate for the target service and environment.
4. Start with `environment: "test"` and move to production only after end-to-end validation.

Official ARCA / AFIP references:

- [WSAA documentation](https://www.afip.gob.ar/ws/documentacion/wsaa.asp)
- [Certificates for testing / homologation](https://www.afip.gob.ar/ws/documentacion/certificados.asp)
- [WSAA developer manual](https://www.afip.gob.ar/ws/WSAA/WSAAmanualDev.pdf)
- [WSASS service onboarding](https://www.afip.gob.ar/ws/WSASS/WSASS_como_adherirse.pdf)
- [WSFE developer manual](https://www.afip.gob.ar/ws/documentacion/manuales/manual-desarrollador-ARCA-COMPG.pdf)

## Reference Data

The package exports a small, stable set of common ARCA codes from `facturas/constants`.

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

The constants cover the most common values used by the README and examples:

- voucher types for invoice A/B/C, debit note A/B/C, and credit note A/B/C
- document types for CUIT, DNI, and final consumers
- common receiver IVA conditions, subject to voucher-class and live-catalog rules
- concept types for products, services, and products + services
- IVA rates for `0`, `2.5`, `5`, `10.5`, `21`, and `27`
- builder ISO currencies `ARS` and `USD`, with explicit ARCA mappings to `PES`
  and `DOL`

`ARCA_CURRENCIES` remains a deprecated compatibility alias with its existing
`PES` and `DOL` values. If you need broader catalogs at runtime, WSFE methods
such as `getVoucherTypes()`, `getDocumentTypes()`, `getCurrencyTypes()`, and
`getVatRates()` are still available. `getCurrencyTypes()` returns live ARCA
identifiers, not ISO codes.

## Configuration

### Environment variables

`createArcaClient()` discovers missing fields using the same rules as
`createArcaClientConfigFromEnv()`. Explicit fields win; `process.env` is not changed:

| Variable | Required | Notes |
| --- | --- | --- |
| `ARCA_TAX_ID` | Yes | 11-digit CUIT |
| `ARCA_CERTIFICATE_PEM` | Yes | PEM certificate |
| `ARCA_PRIVATE_KEY_PEM` | Yes | PEM private key |
| `ARCA_ENVIRONMENT` | No | `test` or `production`; defaults to `test` |

For logging without code changes, set `ARCA_LOG_LEVEL` to `debug`, `info`, `warn`, or `error`.

Pass a config object to `createArcaClient`:

```ts
import { createArcaClient } from "facturas";

const client = createArcaClient({
  taxId: "20123456789",
  certificatePem: process.env.ARCA_CERTIFICATE_PEM!,
  privateKeyPem: process.env.ARCA_PRIVATE_KEY_PEM!,
  environment: "test",
  timeout: 30_000,
  retries: 2,
  retryDelay: 500,
  logger: { level: "debug" },
  // Optional: share WSAA login tickets across workers.
  // wsaaSessionStore,
});
```

| Field | Default | Description |
| --- | --- | --- |
| `taxId` | `ARCA_TAX_ID` | 11-digit CUIT |
| `certificatePem` | `ARCA_CERTIFICATE_PEM` | PEM certificate |
| `privateKeyPem` | `ARCA_PRIVATE_KEY_PEM` | PEM private key |
| `environment` | `test` | `test` or `production` |
| `timeout` | `30000` | HTTP request timeout in milliseconds |
| `retries` | `0` | Extra attempts after transport failures only |
| `retryDelay` | `500` | Delay between transport retries in milliseconds |
| `logger` | — | Optional structured logger config |
| `store` | — | Unified durable tickets and reservations |
| `wsaaSessionStore` | — | Optional WSAA ticket store for multi-worker deployments |

### WSAA session stores

By default, WSAA login tickets are cached in the current process only. That keeps scripts and single-process apps zero-config:

```ts
const client = createArcaClient({
  taxId: "20123456789",
  certificatePem: process.env.ARCA_CERTIFICATE_PEM!,
  privateKeyPem: process.env.ARCA_PRIVATE_KEY_PEM!,
  environment: "production",
});
```

A configured `store` supplies durable WSAA tickets automatically. An explicit
`wsaaSessionStore` remains supported and takes precedence for tickets only.

```ts
import {
  type ArcaAuthCredentials,
  type ArcaWsaaSessionKey,
  createArcaClient,
} from "facturas";

const wsaaSessionStore = {
  async get(key: ArcaWsaaSessionKey): Promise<ArcaAuthCredentials | null> {
    // Read from Postgres, Redis, or another shared store.
    return null;
  },
  async set(
    key: ArcaWsaaSessionKey,
    credentials: ArcaAuthCredentials
  ): Promise<void> {
    // Persist token, sign, and expiresAt for the key.
  },
  async withLock<T>(
    key: ArcaWsaaSessionKey,
    fn: () => Promise<T>
  ): Promise<T> {
    // Optional but recommended: serialize cold-start refreshes.
    return await fn();
  },
};

const client = createArcaClient({
  taxId: "20123456789",
  certificatePem: process.env.ARCA_CERTIFICATE_PEM!,
  privateKeyPem: process.env.ARCA_PRIVATE_KEY_PEM!,
  environment: "production",
  wsaaSessionStore,
});
```

The store key is scoped by environment, WSAA service, and certificate fingerprint. Store reads are still checked with the SDK's expiration safety margin. A production store should share data across all workers, encrypt or rely on encrypted storage, enforce expiration on read, and implement locking with advisory locks, Redis locks, or equivalent.

For tests and local coordination through one shared object, the package also exports `createMemoryWsaaSessionStore()`.

## Logging

Default minimum level is `warn`. At `debug`, the SDK logs SOAP requests, response timings, WSAA login source (`cached` vs `fresh`), and retry attempts.

```ts
const client = createArcaClient({
  taxId: "20123456789",
  certificatePem: "...",
  privateKeyPem: "...",
  environment: "test",
  logger: { level: "debug" },
});
```

Custom logger sinks receive `(level, message, ...args)`:

```ts
const client = createArcaClient({
  taxId: "20123456789",
  certificatePem: "...",
  privateKeyPem: "...",
  environment: "production",
  logger: {
    level: "info",
    log(level, message, ...args) {
      // forward to your logger
    },
  },
});
```

Disable logging entirely with `logger: { disabled: true }`.

## Retries and timeouts

Configured transport retries apply only to `ArcaTransportError`: timeouts, connection failures, and non-XML HTTP error responses. XML responses, including HTTP 500 SOAP faults, are parsed and surfaced as SOAP or service errors instead of being retried blindly.

Separately, authenticated WSFE and WSMTXCA convenience operations may perform
one forced-refresh retry only after `ArcaAuthenticationError`. Timeouts,
connection loss, invalid SOAP, incomplete evidence, contradictory evidence, and
generic service rejections never unlock this recovery path. Both
`authorizeVoucherOutcome(...)` methods always perform one exact authorization
attempt, and each authorization SOAP attempt has transport retries set to zero.

## Service Surface

### `client.wsfe`

WSFE electronic invoicing. Inputs use JS-style names and the SDK maps them to AFIP / ARCA SOAP fields internally.

- Date fields accept `YYYY-MM-DD` or `YYYYMMDD`.
- `createNextVoucher({ data })` resolves the next number and requests CAE in one call.
- `getVoucherInfo({ number, salesPoint, voucherType })` returns voucher details or `null`.
- Catalog methods are available for live reference data when you do not want to hardcode values.
- Authenticated methods accept `forceRefresh: true` to discard the cached WSAA TA and request a fresh Token Authorization for the same service.

### `client.padron`

- `getTaxpayerDetails(taxId)` returns taxpayer data or `null`
- `getTaxIdByDocument(documentNumber)` returns CUIT candidates or `null`

Padron "not found" handling currently depends on SOAP fault message text from ARCA and is therefore more fragile than WSFE code-based flows.

### `client.wsmtxca`

- `authorizeVoucher({ data })`
- `getLastAuthorizedVoucher({ voucherType, salesPoint })`
- `getVoucher({ voucherType, salesPoint, voucherNumber })`
- Authenticated methods accept `forceRefresh: true` to renew the WSMTXCA WSAA TA before the call.

The runtime support is stable and public. It is simply not the main documentation path in this SDK-focused pass.

## Error handling

All errors extend `ArcaError` and expose a stable `code` string.

| Class | When |
| --- | --- |
| `ArcaConfigurationError` | Invalid client config |
| `ArcaInputError` | Invalid caller input such as a malformed date |
| `ArcaAuthenticationError` | Explicit provider authentication rejection |
| `ArcaTransportError` | HTTP or transport failure |
| `ArcaSoapFaultError` | SOAP fault returned by ARCA |
| `ArcaServiceError` | Business-level service rejection, especially WSFE-style errors |

```ts
import {
  ArcaAuthenticationError,
  ArcaServiceError,
  ArcaSoapFaultError,
  ArcaTransportError,
} from "facturas";

try {
  await client.wsfe.createNextVoucher({ data: /* ... */ });
} catch (error) {
  if (error instanceof ArcaAuthenticationError) {
    console.error(
      error.reason,
      error.service,
      error.operation,
      error.providerCode
    );
  } else if (error instanceof ArcaServiceError) {
    console.error(error.serviceCode, error.message);
  } else if (error instanceof ArcaSoapFaultError) {
    console.error(error.faultCode, error.message);
  } else if (error instanceof ArcaTransportError) {
    console.error(error.statusCode, error.message);
  }
  throw error;
}
```

Import error classes from `facturas` or `facturas/errors`.
`isArcaAuthenticationError(error)` is also exported for predicate-style
routing. Authentication errors expose only the stable code
`ARCA_AUTHENTICATION_ERROR`, a typed `reason`, service, operation, and a safe
provider code when available; raw provider bodies and credential values are not
attached.

## Troubleshooting

- `coe.alreadyAuthenticated`: the SDK deduplicates in-flight WSAA logins and reuses valid cached tickets. In serverless, queue workers, or any multi-process deployment, configure a durable `wsaaSessionStore` so cold workers can reuse the TA obtained by another process. Memory-only caching cannot recover across processes.
- `dh key too small`: WSFE production requests already use a legacy OpenSSL security level where needed. If you still see this, confirm you are not bypassing the SDK transport or terminating TLS in another layer.
- Expired certificate: replace the PEM certificate with a renewed one that matches the same private key expectations, then redeploy or restart the process.
- Unauthorized service: your certificate may be valid but not authorized for the target service or environment. Re-check WSASS / homologation setup for test and service relationships for production.
- WSFE `10015`: usually means the `DocTipo` / `DocNro` combination is inconsistent for the voucher type and amount. For example, Factura B has special receiver-document rules depending on the total amount.
- WSFE `10016`: the voucher number sent in `CbteDesde` is not the next valid one for that point of sale and voucher type. Call `getNextVoucherNumber()` immediately before authorizing when your numbering may have moved.

When an error is unclear, check these in order:

1. Certificate and private key match.
2. Environment is correct (`test` vs `production`).
3. Service authorization was done for that environment.
4. The voucher type, document type, and amount combination is valid.
5. Your process is not reusing stale assumptions about the next voucher number.

## Public API (semver)

Documented entrypoints:

- `facturas`
- `facturas/constants`
- `facturas/wsfe`
- `facturas/wsmtxca`
- `facturas/padron`
- `facturas/errors`
- `facturas/types`

Low-level SOAP, HTTP, and WSAA internals are not part of the semver contract.

Subpath example:

```ts
import { createWsfeService } from "facturas/wsfe";
import { ARCA_VOUCHER_TYPES } from "facturas/constants";
import { ArcaServiceError } from "facturas/errors";
```

## Security

- Treat certificates and private keys as secrets.
- By default, WSAA tickets are cached in memory only.
- The SDK persists WSAA tickets when you provide `store` or `wsaaSessionStore`. Keep their storage private; certificate and private-key configuration is never stored by the bundled adapters.
- Production `wsaaSessionStore` implementations should encrypt credentials at rest or use a backend that provides encryption at rest.

## Development

```bash
pnpm install
pnpm typecheck
pnpm typecheck:examples
pnpm test
pnpm test:coverage
pnpm pack:check
```

Optional for local DX: install Turbo globally with `pnpm add --global turbo`. The repo scripts still use the local workspace version.

## License

Apache-2.0
