# ARCA WSFE reference

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

Re-downloaded 2026-09-04; the v4.7 checksum above is unchanged.

| Rule | Physical PDF pages | Contract |
| --- | --- | --- |
| 10197 | 67-68 | Notes require associated vouchers or an associated period. |
| 10040 | 46-47 | Credit notes 3, 8 and 13 may associate invoices 1, 6 and 11 respectively. |
| 10031-10033, 10035-10036 | 45-46 | Service dates and due date accompany each other; start cannot exceed end; due date cannot precede issuance. |
| 10210-10212 | 68-69 | Association dates must be valid; a later electronic original must be in the same month/year. |
| 10242-10243, 10246 | 71 | Receiver VAT condition is required and must suit the voucher class. |
| 10122 | 57-58 | Receiver matching applies to the listed remittance types, not ordinary invoices. |
| 10183 | 66 | Issuer and receiver matching is explicit for MiPyMEs notes. |
| 10151 | 61 | An optional associated issuer CUIT must have eleven digits; MiPyMEs notes require it. |

For ordinary full credit notes, preserving the original receiver document and
VAT condition is the facade contract; the narrower matching validations above
must not be presented as a universal ordinary-note rule. The original is
consulted under the issuing taxpayer's authenticated CUIT (FECompConsultar,
pages 190-191). Service dates are preserved for concepts 2 and 3; the due date
is raised to the note date when needed by 10036.

FECompConsultar returns FECAEDetRequest fields (page 193). Its abbreviated
XML example omits newer fields; the official homologation WSDL confirms
FECompConsResponse inherits FECAEDetRequest/FEDetRequest, including receiver
VAT condition, associations and extensions.
