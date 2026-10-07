# Printed voucher sources and rules

The SDK does not render vouchers yet. This note fixes, before any code, which
norms decide what a printed or PDF representation of an authorized electronic
voucher must show, and where. Each rule has an id so the document model, the
renderer and the compliance check can cite it.

`ARCA_SOURCES.md` covers what the SDK sends to ARCA. This file covers what the
printed voucher shows. This is a technical reading of the norms, not tax advice.

## How the sources are pinned

The norms are read from the consolidated texts on argentina.gob.ar. That site
re-renders its pages on every request, so a checksum of the page changes while
the norm does not. Each source is pinned instead by the SHA-256 of one section
of its text, between two markers, as printed by:

```bash
node scripts/normative-text.mjs <file.html> "<start marker>" "<end marker>"
```

The script drops scripts, styles and tags, collapses whitespace on every line,
prints the section and writes its checksum to stderr. A different checksum
means the consolidated text changed and the rules below need a new read. The
QR specification is a PDF and is pinned by the checksum of the file.

Retrieved: 2026-10-06. The texts were first read on 2026-09-30 and the
sections below were unchanged.

| Source | Section (start marker → end marker) | SHA-256 |
| --- | --- | --- |
| [RG 1415, texto actualizado](https://www.argentina.gob.ar/normativa/nacional/resoluci%C3%B3n-1415-2003-81316/actualizacion) | `Art. 15. —` → `Art. 16. —` | `362749084ab96f4e78aa6bb7fcf1c97be91e6f326a80b1549167ba3e22ea8f0b` |
| RG 1415, same page | `Art. 18. —` → `Art. 20. —` | `66d8df037e78a76863cfaf3e58ecc437e40cb07f6f70f72b709a6118b933aa3d` |
| RG 1415, same page | `ANEXO II – RESOLUCION GENERAL N° 1415` → `ANEXO III – RESOLUCION GENERAL N° 1415` | `9022ba77ffecb3a9c9e986ec59c10afcba89f4c67ce5dc481757384889c167b3` |
| [RG 4291, texto actualizado](https://www.argentina.gob.ar/normativa/nacional/resoluci%C3%B3n-4291-2018-313088/actualizacion) | `ARTÍCULO 14.-` → `ARTÍCULO 16.-` | `ac9e870239f4d9de9110d67f158b606659ffedd693a8a03f0ff64d7a99046eb2` |
| RG 4291, same page | `ARTÍCULO 12.-` → `ARTÍCULO 13.-` | `7f3616526c03fdfbebd7e43581bb4689433259d582c3cb1a00585b8634c900d6` |
| [RG 4892](https://www.argentina.gob.ar/normativa/nacional/resoluci%C3%B3n-4892-2020-345661/texto) | `ARTÍCULO 1°.-` → `ARTÍCULO 4°.-` | `d441a4fcf9e6bd67c6361ade92355ded3be673108626603db0e6bb916e9974b4` |
| [RG 5614](https://www.argentina.gob.ar/normativa/nacional/resoluci%C3%B3n-5614-2024-407183/texto) | `ARTÍCULO 1°.-` → `ARTÍCULO 7°.-` | `6058936967b2d8e331a0290d5b1ff476e4bcdd8a684e117e8732620654d558da` |
| [RG 5003, texto actualizado](https://www.argentina.gob.ar/normativa/nacional/norma-350574/actualizacion) | `ARTÍCULO 20.-` → `ARTÍCULO 21.-` | `cf622bef91aa84c82a0fa81de95017657515878afd45ed7e60b33f3048e311d0` |
| [RG 5762, texto original](https://www.argentina.gob.ar/normativa/nacional/resoluci%C3%B3n-5762-2025-417981/texto) | `ARTÍCULO 10.-` → `ARTÍCULO 12.-` | `b7a8eb79236a64d179b760b35a899b94270741f16a9f24a8db10a5aead538111` |
| RG 5762, same page | `ARTÍCULO 20.-` → `ARTÍCULO 22.-` | `d257242900b3ec4c8976bdaeacab1ce836f4236d7b940adf8877bf89973ee1b3` |
| RG 5762, same page | `ARTÍCULO 30.-` → `ARTÍCULO 33.-` | `3f2da035e44f4cdaa8ec5e747ab7670dd240ce87eac3a3f2db16613c92d79bfe` |
| [Ley 27.440, texto actualizado](https://www.argentina.gob.ar/normativa/nacional/ley-27440-310084/actualizacion) | `Art. 5°- Los requisitos mínimos` → `Art. 6°-` | `6655c0f6f0a683096c7102f8e0d7170e104fc4cb7cba6869fffd876c0a5ea6a1` |
| [QR specification](https://www.afip.gob.ar/fe/qr/documentos/QRespecificaciones.pdf) | Whole file | `a6d0f71e14f282836f07834af76a975dd885386bf972d860878d4b44278deaac` |

RG 1415 is the general invoicing regime. Article 18 sends the content of a
class A, B, C or E voucher to Anexo II, Apartado A. Article 19 sets a minimum
size of 15 × 20 cm and sends the placement of some data to Apartado B. RG 4291
applies RG 1415 to electronic vouchers. RG 4892 adds the QR. RG 5614 adds the
Ley 27.743 consumer transparency block. RG 5003 article 20 wrote the class A
to monotributo legend into RG 1415 article 15. RG 5762 replaced RG 1575 and
class M from 2025-12-01 with class A vouchers that carry a legend next to the
letter. Its consolidated text was not published at retrieval, so the original
is pinned. Ley 27.440 article 5 lists what an FCE must show.

The RG 5762 retrieval was 2026-10-07.

## How RG 4291 article 15 is read

Article 15 has two paragraphs that pull apart. The first says the size and
placement requirements of RG 1415 article 19 "se considerarán cumplidos" for
electronic vouchers. The second says that when the voucher is shown as an image
or printed, the representation "deberá observar los modelos de comprobantes
previstos para cada tipo de documento", and that it may instead follow the
ticket models of RG 3561 with the CAE at the foot. A last paragraph, added by
RG 5614, requires the Apartado B transparency block in any image or print.

The first paragraph is explicit, so a layout that departs from Apartado B is
not, by itself, a breach. The second asks the representation to follow "los
modelos", and the only models the norms describe are Apartado B and the RG 3561
tickets. The SDK reads both together:

- The default template follows the Apartado B placement, so nobody has to
  argue about it.
- The compliance check reports a failed layout rule (L1 to L4, L6, L7 and L9)
  as a warning, and a failed content rule as an error. A custom template can
  move a block and still pass, but it cannot drop a datum.
- L8 is the exception: RG 4291 article 15, last paragraph, requires the
  transparency data in every image or print, so a missing block is an error.

## Content rules

RG 4291 article 14 requires on every electronic voucher the CAE, the voucher
type code, the code of the non-computable-credit legend when it applies, and
every datum of RG 1415 Anexo II, Apartado A except Título I inciso a) punto 9
and Título I inciso c). Unless noted, the source is Anexo II, Apartado A.

### Issuer and voucher

| Id | Rule | Source | Applies to |
| --- | --- | --- | --- |
| C1 | Legal name: "Apellido y nombres, denominación o razón social" | I a) 1 | All |
| C2 | Business address: the establishment where the voucher is issued, or the fiscal address for travelling and door-to-door sellers | I a) 2, V 3 | All |
| C3 | Issuer CUIT | I a) 3 | All |
| C4 | Ingresos brutos number, or the non-contributor condition | I a) 4 | All |
| C5 | VAT condition legend: `IVA RESPONSABLE INSCRITO`, `IVA EXENTO`, `NO RESPONSABLE IVA`, `RESPONSABLE MONOTRIBUTO`, `MONOTRIBUTO TRABAJADOR INDEPENDIENTE PROMOVIDO` or `MONOTRIBUTISTA SOCIAL` | I a) 5 | All |
| C6 | Number of 13 digits: 5 for the sales point and 8 for the voucher, consecutive per sales point, class and type | I a) 6, V 4 | All |
| C7 | Start of activities, preceded by `INICIO DE ACTIVIDADES`. Omitted by university professionals billing their fees and by service providers without premises | I a) 7, V 6 | All, with those exceptions |
| C8 | CAE, preceded by `C.A.E. N°` (`C.A.E.A. N°` for CAEA) | I a) 10, RG 4291 art. 14 a) | All |
| C9 | Due date, preceded by `Fecha de Vto.` | I a) 11 | All, see D8 |
| C10 | Class letter and the voucher type code | I b), RG 4291 art. 14 b) | All |
| C11 | Issue date | I d) | All |
| C12 | Numbers of the remitos issued and linked to the operation | I e) | When there are any |

Apartado A writes `IVA RESPONSABLE INSCRITO`. The SDK prints `IVA RESPONSABLE
INSCRIPTO`, the wording of the later RG 5003 texts and of the vouchers ARCA
renders, for both the issuer and the receiver.

Not required on electronic vouchers by RG 4291 article 14 d): the first and
last number of the print run and the printer licence (I a) 9), and the words
`ORIGINAL` and `DUPLICADO` (I c)). See R2 for the printer identity of I a) 8.

### Receiver

| Id | Receiver | Data | Source |
| --- | --- | --- | --- |
| C13 | Responsable inscripto | Name, business address, CUIT, `IVA RESPONSABLE INSCRITO` | II a) |
| C14 | Exento or no alcanzado | Name, business address, CUIT, `NO RESPONSABLE IVA` or `IVA EXENTO` | II c) |
| C15 | Consumidor final | `A CONSUMIDOR FINAL`. From ARS 10,000,000, the DNI, CUIL or CDI, or the foreign document or passport. The CUIT, regardless of amount, when the buyer asks for it to deduct income tax. Name and address may be `NR` or zeros | II d), as replaced by RG 5866/2026 from 2026-07-01 |
| C16 | Monotributo | Name, business address, CUIT, `RESPONSABLE MONOTRIBUTO`, `MONOTRIBUTO TRABAJADOR INDEPENDIENTE PROMOVIDO` or `MONOTRIBUTISTA SOCIAL` | II e) |
| C17 | Not categorized | Name, business address, CUIT, `SUJETO NO CATEGORIZADO` | II f) |
| C18 | Export | Importer name, address and foreign tax id or CUIT, `IVA EXENTO OPERACION DE EXPORTACION` | II g), see D4 |

### Operation

| Id | Rule | Source |
| --- | --- | --- |
| C19 | A description that identifies the good or service. Codes are allowed when a signed catalog is available on request | III a) |
| C20 | Quantity of the goods | III b) |
| C21 | Unit and total prices | III c) |
| C22 | For foreign currency, the exchange rate used | III d) |
| C23 | Every other concept that changes the total | III e) |
| C24 | For Ley 27.743 article 99 operations, the amount of "Otros Impuestos Nacionales Indirectos" | III f) |

### VAT

| Id | Rule | Source | Applies to |
| --- | --- | --- | --- |
| C25 | Break out the rate, the resulting tax, the other taxes outside the net taxed price and any perception. One rate line per rate, from the VAT rows ARCA authorized | IV a) 1 | Responsable inscripto issuer, taxed operation with a responsable inscripto or monotributo |
| C26 | Break out the VAT contained in the price | IV a) 2 | Responsable inscripto issuer, taxed operation with an exento, no alcanzado or consumidor final |
| C27 | Never break out VAT | IV b) | Monotributo issuer |

## Layout rules

Apartado B, read as described above. Data that Apartado B does not place may
go anywhere, as long as it is legible (RG 1415 article 19, second paragraph).

| Id | Rule | Source |
| --- | --- | --- |
| L1 | Top left: trade name when there is one, legal name, business address, VAT condition legend | B a) |
| L2 | Top right: the number centred in that space, issue date, CUIT, ingresos brutos, start of activities | B b) |
| L3 | The data of L1 and L2 inside a box of at least 7 × 3 cm | B, after b) |
| L4 | Top centre, highlighted: the class letter, and below it the voucher type code preceded by `Código Nº` | B c) |
| L5 | Receiver data as in C13 to C18 | B d) |
| L6 | Sale conditions: contado, cuenta corriente and so on | B e) |
| L7 | The VAT data of C25 right after the item detail, laid out vertically or horizontally | B f) |
| L8 | Bottom left: the title `Régimen de Transparencia Fiscal al Consumidor (Ley 27.743)`, below it `IVA Contenido` with the C26 amount, and below that `Otros Impuestos Nacionales Indirectos` with the C24 amount | B g) 1, RG 4291 art. 15 last paragraph |
| L9 | Bottom right: the CAE preceded by `C.A.E. N°`, and the due date preceded by `Fecha Vto.:` in type no smaller than 12 pt | B h) |
| L10 | Minimum size of 15 × 20 cm. Deemed met for electronic vouchers by RG 4291 article 15, and met by A4 anyway | RG 1415 art. 19 |

## QR

| Id | Rule | Source |
| --- | --- | --- |
| Q1 | The QR is on the voucher and does not hide any required datum. No size or position is set | RG 4892 art. 1 |
| Q2 | It encodes `https://www.arca.gob.ar/fe/qr/?p=` followed by the base64 of the version 1 JSON. `arcaQrUrl()` already builds it | QR specification |

## Conditional legends

| Id | Legend | When | Source |
| --- | --- | --- | --- |
| G1 | `El crédito fiscal discriminado en el presente comprobante, sólo podrá ser computado a efectos del Régimen de Sostenimiento e Inclusión Fiscal para Pequeños Contribuyentes de la Ley Nº 27.618` | Class A to a monotributo receiver | RG 1415 art. 15 a), as replaced by RG 5003 art. 20 from 2021-07-01 |
| G2 | The L8 transparency block | Where C26 applies: responsable inscripto issuer, receiver exento, no alcanzado or consumidor final. Not on class C, see R3 | RG 1415 An. II B g) 1, RG 4291 art. 15, RG 5614 art. 6 |
| G3 | `Observaciones de ARCA:` followed by the codes ARCA returned with the CAE | Class A authorized with observations, see R4 | RG 4291 art. 12 and 14 c) |
| G4 | `OPERACIÓN SUJETA A RETENCIÓN`, next to the letter A | Types 51 to 53, issued from 2025-12-01 | RG 5762 art. 10, 11 and 31 |
| G5 | `PAGO EN CBU INFORMADA`, next to the letter A | Class A, when the issuer opted for that regime | RG 5762 art. 20 and 21 |

WSFE observation 10217 words the G1 legend differently ("Procedimiento
permanente de transición al Régimen General"). The printed legend follows the
norm, not the observation text.

Types 51 to 53 were class M until 2025-11-30. RG 5762 article 28 keeps their
numbering, so a voucher of those types dated before 2025-12-01 is a class M
voucher, which the SDK does not render.

## Decisions for the first release

| Id | Decision |
| --- | --- |
| D1 | Apartado B placement in the default template. Layout findings are warnings and content findings are errors, see "How RG 4291 article 15 is read". |
| D2 | A4 only. A thermal template follows the RG 3561 Tique-Factura model with the CAE at the foot (RG 4291 art. 15), and pins RG 3561 when it is built. |
| D3 | FCE vouchers (201 to 203, 206 to 208, 211 to 213) are not rendered yet. The model refuses them with an explicit error. R6 lists what rendering them needs. |
| D4 | Export vouchers (class E) are not rendered in the first release. |
| D5 | The printer identity and print-run data are not printed, see R2. |
| D6 | `ORIGINAL` and `DUPLICADO` are not required. A copy label is optional and off by default. |
| D7 | No ARCA logo and no "Comprobante Autorizado" mark. No norm requires them, and they would present a third-party document as rendered by ARCA. |
| D8 | On an electronic voucher, the due date of C9 and L9 is read as the CAE due date. A payment due date is a separate, optional field. |

## Resolved questions

These had no single answer in the texts. Each resolution states its reading.

| Id | Question | Resolution |
| --- | --- | --- |
| R1 | Is the Apartado B layout required for an electronic voucher? | Not by itself: RG 4291 article 15 deems it met. The default template follows it anyway and the check warns on it, see D1. |
| R2 | RG 4291 article 14 d) excludes I a) 9 but not I a) 8, the printer identity. | Omitted. I a) 8 identifies "quien efectuó la impresión", and V 1 and V 2 define that as printing by a graphic-arts establishment, which an electronic voucher never has. V 7 also spares self-printers those data, and ARCA's own vouchers omit them. |
| R3 | Does a class C voucher to a consumidor final carry the transparency block? | No. B g) 1 asks for the VAT contained "con la discriminación indicada en el Apartado A, Título IV, inciso a), punto 2", which only applies to a responsable inscripto issuer, and IV b) forbids a monotributo issuer from breaking out VAT. RG 5614 replaced IV a) and left IV b) as it was. |
| R4 | Which observation codes does RG 4291 article 14 c) ask for? | Every observation ARCA returns with the CAE of a class A voucher. RG 4291 article 12, as replaced by RG 5003 article 25, authorizes such a voucher "junto con los códigos representativos de las irregularidades observadas", and the tax it breaks out cannot be computed as credit. The caller passes `authorization.observations`. A voucher recovered by match carries none, so it prints none. |
| R5 | Where does `Operación sujeta a retención` come from? | RG 5762 article 10, in force from 2025-12-01, see G4. RG 5762 article 21 adds G5. |
| R6 | What does an FCE need on paper? | Ley 27.440 article 5: payment due date, CBU or alias, both CUITs, the amount in figures and words, the remito, and a text saying it is accepted after the legal term without rejection, that it is then an executive title, and that acceptance allows transferring its data. The term is 15 days, and 21 from 2025-11-01 to 2026-10-31 by Resolución 219/2025, so the text depends on the date. FCE stays out until those fields are modelled, see D3. |
| R7 | Which model does a thermal ticket follow? | The RG 3561 Tique-Factura, see D2. |
| R8 | Which ARCA tributos are "Otros Impuestos Nacionales Indirectos" (C24, L8)? | Tributo 1 (Impuestos nacionales) and 4 (Impuestos internos). Ley 27.743 article 99 names the national indirect taxes that shape the price. Perceptions are payments on account of another tax, not a tax in the price, and provincial and municipal taxes are not national. |

## Status

1. Done: `buildVoucherDocument()` derives the fields above from the
   authorized voucher, the items and the issuer profile, and
   `IssuedVoucher.totals` carries the VAT breakdown by rate (C25).
2. Next: a separate PDF package with the fiscal components, an A4 template that
   follows L1 to L9, and a compliance check that reports each failed rule by
   id.
