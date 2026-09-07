# facturas (English summary)

Node.js SDK for ARCA / AFIP: invoices, credit notes and Padrón, with direct
WSFE and WSMTXCA integration. ESM-only, Node.js >= 20.

**The full documentation is in Spanish**, in [docs/](../README.md). This page
is a summary, not a translation.

## Install

```bash
pnpm add facturas
```

## Set up ARCA

`npx facturas init` generates the private key and the CSR to upload in ARCA,
then prints the exact pages and buttons. Save the certificate ARCA gives you
next to the key, with the name `init` tells you, and `npx facturas check`
finds it on its own: it tests every layer and names the one that fails.
Neither writes to ARCA. See [cli.md](../cli.md).

## Issue an invoice

Set `ARCA_TAX_ID`, `ARCA_CERTIFICATE_PEM`, `ARCA_PRIVATE_KEY_PEM` and
`ARCA_ENVIRONMENT`. Nothing else is required: no database, no table, no
external service. Amounts are integer minor units.

```ts
import { createArcaClient } from "facturas";

const arca = createArcaClient();

const factura = await arca.issue({
  issuer: "monotributo",
  salesPoint: 3,
  to: { condition: "consumidor_final" },
  items: [{ amount: 150_000 }], // ARS 1.500,00 in minor units
});
```

**Safe retries** are strongly recommended and optional: pass a `store` and the
sale's stable ID as `idempotencyKey`, and a retry after a crash consults the
reserved number instead of issuing again. See [stores.md](../stores.md).

## Issue a credit note

ARCA has no cancellation. A correction is a credit note, and it is a real
fiscal document. The partial mode credits the chosen lines; `all: true` credits
the whole original.

```ts
const nota = await arca.issueCreditNote(
  {
    for: { salesPoint: 3, voucherType: 11, number: 41 },
    items: [{ amount: 50_000 }], // ARS 500,00 of an ARS 1.500,00 invoice
  },
  { idempotencyKey: `nc:${devolucion.id}` },
);
```

The same facade also covers debit notes, period notes, tributes, reviewed
fiscal breakdowns, the A con leyenda and FCE families, detailed WSMTXCA
issuance through `{ service: "wsmtxca" }`, and `recover()`, which only consults
a stored reservation and never authorizes. See
[notas-de-credito.md](../notas-de-credito.md) and
[wsmtxca.md](../wsmtxca.md).

## Outcomes

| Outcome | Meaning and caller action |
| --- | --- |
| `authorized` | Save the voucher and CAE. `recoveredByMatch: true` means the stored input matched the consulted identity; it proves consistency, not authorship. |
| `rejected` | Review ARCA's `issues`. A key remains bound to its input even after rejection. |
| `indeterminate` | Preserve the number and evidence. Reconcile or retry the identical input with its existing key. |
| `conflict` | A different voucher occupies the reserved number. Stop and investigate. |

## Where to read more

| Page | Topic |
| --- | --- |
| [inicio-rapido.md](../inicio-rapido.md) | Quick start |
| [cli.md](../cli.md) | The `facturas` CLI: `init`, `check` and `issue` |
| [facturas.md](../facturas.md) | `issue()`, `preview()`, invoice inputs, facade contract |
| [notas-de-credito.md](../notas-de-credito.md) | `issueCreditNote()`, `issueDebitNote()` |
| [wsmtxca.md](../wsmtxca.md) | Detailed WSMTXCA issuance through the facade |
| [stores.md](../stores.md) | Postgres, Redis, files, memory, custom store |
| [configuracion.md](../configuracion.md) | Environment variables and client options |
| [capa-exacta.md](../capa-exacta.md) | Exact WSFE / WSMTXCA layer and service surface |
| [errores.md](../errores.md) | Error classes and troubleshooting |
| [referencia.md](../referencia.md) | Constants, public API, security |
| [ejemplos.md](../ejemplos.md) | Index of [examples/](../../examples) |

[CONTRIBUTING.md](../../CONTRIBUTING.md) is in English.
