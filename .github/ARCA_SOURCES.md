# ARCA sources and rules

The SDK's WSFE validation rules follow the official ARCA developer manual.
This note records which artifact was reviewed so the rules the SDK encodes
can be traced to a specific document version.

- [Official documentation index](https://www.arca.gob.ar/ws/documentacion/ws-factura-electronica.asp).
- [Linked official manual](https://www.arca.gob.ar/ws/documentacion/manuales/manual-desarrollador-ARCA-COMPG.pdf).
- Version: 4.7; cover revision date: 2026-09-01.
- Retrieved: 2026-09-03. The cover date is not a universal legal effective date.
- SHA-256: `11dd8e4c5dc409d9e05a88a0043cfe43ee1577e887dbc94ed765ee2c053a6aed`.

The PDF is not committed. Verify a downloaded copy against the checksum above.

The older `/fe/ayuda/documentos/wsfev1-RG-4291.pdf` URL served a v4.8
document dated 2026-12-01 at retrieval time. It was not selected as the
baseline.

## Rules the SDK relies on

Compared with v4.6, no semantic change was found in 10022, 10023, 10047,
10048, 10051, 10061, or the Round Half Even rounding criterion.

| Rule | Physical PDF pages | Contract |
| --- | --- | --- |
| 10022 / 10023 | 44 | Group IVA by rate; header reconciliation tolerance |
| 10047 / 10048 | 48-49 | Zero IVA for class C; total decomposition |
| 10051 / 10061 | 49-50 | Rate arithmetic; base reconciliation and exclusions |
| Rounding | 202 | Round Half Even |
| Receiver matrix | 203 | Receiver condition to voucher class |

Version 4.7 changes: 10054 and new 10273-10282 concern insurance options;
10067/10283 and CAEA 1425/1527 concern uncategorized recipients; new
10284/1528 concern document-type consistency. The SDK does not implement
the first two groups.

## Separate legal source

[RG 5866/2026, article 1(f) and article 4](https://www.argentina.gob.ar/normativa/nacional/norma-427092/texto)
supports the ARS 10,000,000 identification threshold, the requested CUIT for
an income-tax deduction regardless of amount, and general application from
2026-07-01. The threshold is not the only reason a receiver may need
identification. This is a technical input review, not tax advice.

This note is a focused extraction, not a replacement for the complete manual.

## Credit and debit notes

Re-downloaded 2026-09-04; the v4.7 checksum above is unchanged. Rules 10040
and 10197 were re-read against the same pinned file on 2026-09-06.

| Rule | Physical PDF pages | Contract |
| --- | --- | --- |
| 10197 | 67-68 | Notes require associated vouchers or an associated period. Re-checked 2026-09-06: the rule reads "Si el comprobante es Debito o Credito, se deberá informar de forma obligatoria los campos Fecha Comprobantes Asociados Desde/Hasta, o al menos un comprobante asociado", so a single associated invoice satisfies it and no manual rule ties the note's amount to the associated voucher. A partial-amount ordinary credit note with one associated invoice and no further field is allowed. |
| 10040 | 46-47 | Credit notes 3, 8 and 13 may associate invoices 1, 6 and 11 respectively. Re-checked 2026-09-06: the full lists on page 47 are 1, 2, 3, 4, 5, 34, 39, 60, 63, 88 and 991 for 2 and 3; 6, 7, 8, 9, 10, 35, 40, 61, 64, 88 and 991 for 7 and 8; and 11, 12, 13 and 15 for 12 and 13. Debit notes 2, 7 and 12 are therefore allowed association targets for credit notes 3, 8 and 13; the high-level API now accepts invoice and debit-note targets in the supported ordinary, retention-legend and FCE families. |
| 10237 | 75-76 | A credit note whose amount exceeds the associated voucher it adjusts is an observation, not a rejection. The CAEA list repeats it as observation 818 (page 159). |
| CbtesAsoc structure | 31 | An associated voucher requires only Tipo, PtoVta and Nro; Cuit and CbteFch are optional. |
| 10031-10033, 10035-10036 | 45-46 | Service dates and due date accompany each other; start cannot exceed end; due date cannot precede issuance. |
| 10210-10212 | 68-69 | Association dates must be valid; a later electronic original must be in the same month/year. |
| 10242-10243, 10246 | 71 | Receiver VAT condition is required and must suit the voucher class. |
| 10122 | 57-58 | Receiver matching applies to the listed remittance types, not ordinary invoices. |
| 10183 | 66 | Issuer and receiver matching is explicit for MiPyMEs notes. |
| 10151 | 61 | An optional associated issuer CUIT must have eleven digits; MiPyMEs notes require it. |

## 10061 and the FCE family (2026-09-07)

Re-read against the same pinned v4.7 file. Rule 10061 requires the sum of
`BaseImp` in `AlicIva` to equal `ImpNeto`, except for voucher types 02, 03, 07,
08, class C types 11, 12, 13, 15, and class M types 52 and 53. The enumeration
predates the FCE (MiPyME) types and was never extended, so the SDK exempts 202,
203, 207 and 208 as the notes of the FCE
family - the same document role as 02, 03, 07 and 08 - and 211, 212 and 213 as
class C vouchers, which carry no VAT breakdown at all under 10047. The
exemption is a local pre-flight allowance only: ARCA remains authoritative, and
being permissive here never rejects a voucher ARCA would authorize. FCE
invoices 201 and 206 still reconcile their bases.

The extra association obligations at 10153-10160 (pages 61-63) - a mandatory
associated voucher, a mandatory associated date, the issuer CUIT match and the
single associated invoice - are written for MiPyMEs (FCE) notes only and do not
reach ordinary notes 3, 8 and 13. Together with the CbtesAsoc structure on page
31 this means an ordinary partial credit note needs no field that
FECompConsultar on the original does not return.

For ordinary full credit notes, preserving the original receiver document and
VAT condition is the high-level API contract; the narrower matching validations above
must not be presented as a universal ordinary-note rule. The original is
consulted under the issuing taxpayer's authenticated CUIT (FECompConsultar,
pages 190-191). Service dates are preserved for concepts 2 and 3; the due date
is raised to the note date when needed by 10036.

FECompConsultar returns FECAEDetRequest fields (page 193). Its abbreviated
XML example omits newer fields; the official homologation WSDL confirms
FECompConsResponse inherits FECAEDetRequest/FEDetRequest, including receiver
VAT condition, associations and extensions.

## High-level API expansion (2026-09-06)

Rechecked the official WSFE v4.7 and
[WSMTXCA v0.25.8](https://www.arca.gob.ar/fe/ayuda/documentos/wsmtxca-RG-2904.pdf)
manuals for this expansion. WSFE note associations include debit-note targets;
receiver conditions follow its final matrix. WSFE FCE options 2101/2102 encode
CBU/alias, while WSMTXCA combines them as additional-data type 21 (`c1`/`c2`).
Both use 22 for explicit annulment and 27 for transfer. See WSFE rules
10165-10173 and WSMTXCA rules 327-334. WSMTXCA's authorization and consultation
schemas include associated periods, buyers, activities and foreign-currency
payment (physical pages 22-25 and 257-260). Its detailed item consultation is
used to check the reserved request, not just its header total.

## Voucher date window (2026-09-26)

Re-downloaded the WSFE manual; the v4.7 checksum above is unchanged. WSMTXCA
is the v0.25.8 manual linked above. `preview()` and `issue()` check the
voucher date against the day of submission in Argentina before any I/O.

| Rule | Physical PDF pages | Contract |
| --- | --- | --- |
| WSFE 10016 | 42-43 (field on 28-29) | `CbteFch` within N-5..N+5 for concept 1, not past the month of submission; N-10..N+10 for concepts 2 and 3. FCE (MiPyMEs) invoices N-5..N+1; FCE notes no earlier than N-5. The bullets are cumulative, so an FCE voucher also keeps its concept's bounds. |
| WSMTXCA 103 | 39 | `fechaEmision` within 5 days either side for concept 1, "sin extenderse al mes siguiente", which reads the WSFE month clause as an upper bound only; 10 days either side for concepts 2 and 3. WSMTXCA states no FCE-specific window, so none is applied there. |

Not checked locally: the date must be on or after the last voucher of the same
type and sales point (WSFE 10016, WSMTXCA 104), and an FCE note on or after its
associated invoice. Both need a provider read, and ARCA stays authoritative.

## FCE service note payment due date (2026-10-08)

Re-downloaded both pinned manuals. Their checksums above and below are
unchanged. No live issuance backs this correction.

| Rule | Physical PDF page | Contract |
| --- | --- | --- |
| WSFE 10175 | 65 | `FchVtoPago` must be omitted from FCE debit and credit notes unless the note is an annulment. |
| WSMTXCA 149 | 46 | `fechaVencimientoPago` is forbidden on FCE debit and credit notes (202, 203, 207 and 208). |

The SDK now omits the original payment due date on FCE notes explicitly marked
without annulment (optional field 22 = N), for both services. It preserves the
original service window for concepts 2 and 3. The generic service due-date
requirement (WSFE 10035, physical page 46) does not override 10175 for these
notes. Ordinary notes and WSFE annulments keep their existing due-date
behavior. WSMTXCA annulment behavior is outside this correction.

## WSMTXCA

- [Linked official manual](https://www.arca.gob.ar/fe/ayuda/documentos/wsmtxca-RG-2904.pdf).
- Version: 0.25.8.
- Retrieved: 2026-09-27.
- SHA-256: `8dbb73ea4c8d201a73c62e19759bb440801c168f04365261d9b207cf1a1eaaf4`.

The PDF is not committed. Verify a downloaded copy against the checksum above.
No homologation run backs these rows; they come from the manual alone.

| Rule | Physical PDF pages | Contract |
| --- | --- | --- |
| 10010 | 37 | The issuer must be registered in Codificación de Productos, opción Factura con Detalle. |
| 100 | 38 | Voucher types 1, 2, 3, 6, 7, 8, 51, 52, 53, 201-203 and 206-208 only. Class C goes through WSFE. |
| 101 | 39 | The sales point must be of the "CAE Codificación de Productos - Web Services" type and not blocked. |
| 108 | 40 | `codigoTipoDocumento` and `numeroDocumento` travel together or not at all. |
| 128 / 129 | 44 | The receiver document is optional. It is required for class A, retention-legend and FCE types, which also require document type 80, and for 6, 7 and 8 at or above the RG 4444 amount. The SDK omits both fields for document type 99 and reads an omitted document back as 99/0. |
| 500 / 503 | 63-64 | `unidadesMtx` and `codigoMtx` are required unless `codigoUnidadMedida` is 97 or 99. |
| 501 / 502 | 64 | `unidadesMtx` is a whole number from 1 with at most six digits. |
| 504 | 63 | An unregistered GTIN in `codigoMtx` is an observation, not a rejection. |
| 505 | 64 | `codigo` is optional, at most 50 characters. |
| 520 | 66 | `unidadesMtx` and `codigoMtx` travel together. |

With WSFE rule 10005 (v4.7, physical page 40: the sales point must be of the
RECE type), rules 10010 and 101 make the sales point's type decide the
service, which is what the WSMTXCA guide documents.

The SDK derives no synthetic lines: the VAT adjustment is absorbed by the
caller's lines, so the ajuste IVA code rule does not apply.

### Generic item codes

- [Official list](https://www.afip.gob.ar/fe/documentos/codigosGenericosYEspecificos.xls),
  section "B - CÓDIGOS GENÉRICOS", 13 codes.
- Retrieved: 2026-09-27.
- SHA-256: `1e5cead89fe9c9fdc1b9fb9a6da121d7c28eec56fdb33597d6777f74268c9522`.
- [RG 2904, Anexo VII](https://www.afip.gob.ar/fe/regimenes-especiales/autorizacion.asp):
  generic codes are for concepts outside the issuer's main line of goods;
  samples and promotional material use Ventas varias.

`ARCA_WSMTXCA_GENERIC_CODES` mirrors section B. Section C lists
sector-specific codes, which the SDK does not ship.
