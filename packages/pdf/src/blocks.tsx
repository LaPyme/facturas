import { Text, View } from "@react-pdf/renderer";
import { PRINTED_VOUCHER_TEXT, type VoucherDocument } from "facturas";
import type { ReactNode } from "react";
import { useVoucher } from "./context";
import {
  formatAmount,
  formatConditionLegend,
  formatDate,
  formatDecimal,
  formatMoney,
  formatQuantity,
  formatTaxId,
  formatTitle,
  formatVatRate,
} from "./format";
import { ArcaQr } from "./qr";
import type { VoucherStyles } from "./theme";

/**
 * The fiscal blocks. They are internal on purpose: `<Voucher>` places each
 * one in its Apartado B zone, so no template can move or drop them. Rule ids
 * refer to `.github/PRINTED_VOUCHER_SOURCES.md`.
 */

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  const { styles } = useVoucher("Labeled");
  return (
    <Text>
      <Text style={styles.muted}>{label} </Text>
      {children}
    </Text>
  );
}

/** L1, L2, L3 and L4: the issuer box with the letter at its top centre. */
export function IssuerHeader({
  brand,
  details,
}: {
  brand?: ReactNode;
  details?: ReactNode;
}) {
  const { doc, styles } = useVoucher("IssuerHeader");
  const { issuer } = doc;
  // Fixed: every sheet of a long voucher says whose voucher it is.
  return (
    <View fixed style={styles.header}>
      <View style={styles.headerSide}>
        {brand}
        {issuer.tradeName ? (
          <Text style={styles.issuerName}>{issuer.tradeName}</Text>
        ) : null}
        <Text style={issuer.tradeName ? styles.bold : styles.issuerName}>
          {issuer.legalName}
        </Text>
        <Text>{issuer.address}</Text>
        <Text style={styles.conditionLegend}>
          {formatConditionLegend(issuer.conditionLegend)}
        </Text>
        {details}
      </View>
      <LetterBox />
      <View style={styles.headerRight}>
        <Text style={styles.title}>{formatTitle(doc.title)}</Text>
        <Text style={styles.number}>Nº {doc.number}</Text>
        <Labeled label="Fecha de emisión:">{formatDate(doc.issueDate)}</Labeled>
        <Labeled label="CUIT:">{formatTaxId(issuer.taxId)}</Labeled>
        <Labeled label="Ingresos Brutos:">{issuer.grossIncome}</Labeled>
        {issuer.activitiesStartDate ? (
          // D9: the norm's INICIO DE ACTIVIDADES, in the case of the other labels.
          <Labeled label="Inicio de actividades:">
            {formatDate(issuer.activitiesStartDate)}
          </Labeled>
        ) : null}
      </View>
    </View>
  );
}

/** L4, G4 and G5: the letter, its code and the legend next to the letter A. */
function LetterBox() {
  const { doc, styles } = useVoucher("LetterBox");
  return (
    <View style={styles.headerCenter}>
      <View style={styles.letterBox}>
        <Text style={styles.letter}>{doc.voucherClass}</Text>
      </View>
      <Text style={styles.code}>
        {PRINTED_VOUCHER_TEXT.code} {doc.code}
      </Text>
      {doc.letterLegend ? (
        <Text style={styles.letterLegend}>{doc.letterLegend}</Text>
      ) : null}
    </View>
  );
}

/** C13 to C17, L5 and L6, C12, C22 and the service period. */
export function ReceiverBlock({ details }: { details?: ReactNode }) {
  const { doc, styles } = useVoucher("ReceiverBlock");
  const { receiver } = doc;
  return (
    <View style={styles.section}>
      <View style={styles.row}>
        <View style={styles.columnLeft}>
          <Text style={styles.sectionTitle}>Receptor</Text>
          {/* Who, their fiscal identity, then where and how to reach them. */}
          {receiver.name ? (
            <Text style={styles.bold}>{receiver.name}</Text>
          ) : null}
          {receiver.document ? (
            <Labeled label={`${receiver.document.label ?? "Documento"}:`}>
              {formatTaxId(receiver.document.number)} ·{" "}
              {formatConditionLegend(receiver.conditionLegend)}
            </Labeled>
          ) : (
            <Text>{formatConditionLegend(receiver.conditionLegend)}</Text>
          )}
          {receiver.address ? <Text>{receiver.address}</Text> : null}
          {details}
        </View>
        <View style={styles.columnRight}>
          <Text style={styles.sectionTitle}>Operación</Text>
          <Labeled label="Condición de venta:">{doc.saleConditions}</Labeled>
          {doc.servicePeriod ? (
            <Labeled label="Período facturado:">
              {formatDate(doc.servicePeriod.from)} al{" "}
              {formatDate(doc.servicePeriod.to)}
            </Labeled>
          ) : null}
          {doc.paymentDueDate ? (
            <Labeled label="Vencimiento para el pago:">
              {formatDate(doc.paymentDueDate)}
            </Labeled>
          ) : null}
          {doc.remitos.length > 0 ? (
            <Labeled label="Remitos:">{doc.remitos.join(", ")}</Labeled>
          ) : null}
          {doc.currency.exchangeRate ? (
            <Labeled label="Moneda:">
              {doc.currency.id} · Tipo de cambio{" "}
              {formatDecimal(doc.currency.exchangeRate)}
            </Labeled>
          ) : null}
        </View>
      </View>
    </View>
  );
}

/** Longer than a description column holds: such a token may break anywhere. */
const LONG_TOKEN = 20;

/**
 * Descriptions wrap between words, never as "Col-or". Only a token too long
 * for the column, such as a URL, breaks inside so it cannot overrun the
 * quantity and price columns.
 */
function wrapDescription(word: string): string[] {
  return word.length > LONG_TOKEN ? [...word] : [word];
}

/**
 * A row stays on one sheet unless its description could outgrow one: an
 * unbreakable row taller than the sheet would be clipped.
 */
const UNBREAKABLE_DESCRIPTION = 600;

/** C19 to C21: the lines, without VAT on class A and with VAT on class B. */
export function LinesTable() {
  const { doc, styles } = useVoucher("LinesTable");
  const showCode = doc.lines.some((line) => line.code !== undefined);
  const showDiscount = doc.lines.some((line) => line.discount !== undefined);
  // The rate per line only tells something apart when the lines differ: with
  // one rate, the VAT row of the totals already names it.
  const showRate =
    doc.voucherClass === "A" &&
    new Set(doc.lines.map((line) => line.vatRate)).size > 1;
  return (
    <View style={styles.table}>
      <View fixed style={styles.tableHead}>
        {showCode ? <Text style={styles.cellCode}>Código</Text> : null}
        <Text style={styles.cellDescription}>Descripción</Text>
        <Text style={styles.cellNarrow}>Cant.</Text>
        <Text style={styles.cellNumber}>P. unitario</Text>
        {showDiscount ? <Text style={styles.cellDiscount}>Bonif.</Text> : null}
        {showRate ? <Text style={styles.cellNarrow}>IVA</Text> : null}
        <Text style={styles.cellNumber}>Subtotal</Text>
      </View>
      {doc.lines.map((line, index) => (
        <View
          key={`${index}-${line.description}`}
          style={styles.tableRow}
          wrap={line.description.length > UNBREAKABLE_DESCRIPTION}
        >
          {showCode ? (
            <Text style={styles.cellCode}>{line.code ?? ""}</Text>
          ) : null}
          <Text
            hyphenationCallback={wrapDescription}
            style={styles.cellDescription}
          >
            {line.description}
          </Text>
          <Text style={styles.cellNarrow}>{formatQuantity(line.quantity)}</Text>
          <Text style={styles.cellNumber}>{formatDecimal(line.unitPrice)}</Text>
          {showDiscount ? (
            <Text style={styles.cellDiscount}>
              {line.discount ? formatAmount(line.discount) : ""}
            </Text>
          ) : null}
          {showRate ? (
            <Text style={styles.cellNarrow}>
              {line.vatRate === undefined ? "" : formatVatRate(line.vatRate)}
            </Text>
          ) : null}
          <Text style={styles.cellNumber}>{formatAmount(line.amount)}</Text>
        </View>
      ))}
    </View>
  );
}

function TotalRow({ label, amount }: { label: string; amount: number }) {
  const { doc, styles } = useVoucher("TotalRow");
  return (
    <View style={styles.totalRow} wrap={false}>
      <Text style={[styles.totalLabel, styles.muted]}>{label}</Text>
      <Text style={styles.totalAmount}>
        {formatMoney(amount, doc.currency.id)}
      </Text>
    </View>
  );
}

/** Totals rows taller than this may break across sheets; see `TotalsBlock`. */
const UNBREAKABLE_TOTALS_HEIGHT = 250;
/** A conservative fit for a totals label beside its amount, at 9 pt. */
const TOTALS_LABEL_CHARS_PER_LINE = 28;
const TOTALS_LINE_HEIGHT = 12.15;
const TOTALS_ROW_CHROME = 2.5;

type TotalsRowData = { key: string; label: string; amount: number };

/** C23, C25, L7: the rows above the total, VAT by rate right after the lines on class A. */
function totalsRows(doc: VoucherDocument): TotalsRowData[] {
  const { totals } = doc;
  const classA = doc.voucherClass === "A";
  return [
    {
      key: "subtotal",
      label: classA ? "Importe neto gravado" : "Subtotal",
      amount: totals.subtotal,
    },
    ...(classA && totals.exempt > 0
      ? [{ key: "exempt", label: "Importe exento", amount: totals.exempt }]
      : []),
    ...(classA && totals.untaxed > 0
      ? [
          {
            key: "untaxed",
            label: "Importe no gravado",
            amount: totals.untaxed,
          },
        ]
      : []),
    ...totals.vatRates.map((row) => ({
      key: `vat-${row.id}`,
      label: `IVA ${row.rate === undefined ? `(${row.id})` : formatVatRate(row.rate)}`,
      amount: row.amount,
    })),
    // Two provinces' IIBB perceptions share the tribute id.
    ...totals.otherTaxes.map((tax, index) => ({
      key: `tax-${index}-${tax.id}`,
      label: tax.description,
      amount: tax.amount,
    })),
    ...(totals.adjustment === 0
      ? []
      : [{ key: "adjustment", label: "Ajuste", amount: totals.adjustment }]),
  ];
}

/**
 * Whether the rows above the total may break across sheets. A usual breakdown
 * stays in one block with the total and the CAE. A long one, many wrapped tax
 * names, would not fit a sheet that way, so its rows flow and only the total
 * stays with the CAE.
 */
export function totalsBreak(doc: VoucherDocument): boolean {
  const height = totalsRows(doc).reduce(
    (sum, row) =>
      sum +
      Math.ceil(row.label.length / TOTALS_LABEL_CHARS_PER_LINE) *
        TOTALS_LINE_HEIGHT +
      TOTALS_ROW_CHROME,
    0
  );
  return height > UNBREAKABLE_TOTALS_HEIGHT;
}

export function GrandTotal() {
  const { doc, styles } = useVoucher("GrandTotal");
  return (
    <View style={[styles.totalRow, styles.grandTotal]}>
      <Text style={styles.totalLabel}>Importe total</Text>
      <Text style={styles.totalAmount}>
        {formatMoney(doc.totals.total, doc.currency.id)}
      </Text>
    </View>
  );
}

/**
 * The totals, with the aside slot on their left. With `breakable`, the rows
 * may continue on the next sheet and the total is left out: `<Voucher>` puts
 * it with the CAE.
 */
export function TotalsBlock({
  aside,
  breakable,
}: {
  aside?: ReactNode;
  breakable: boolean;
}) {
  const { doc, styles } = useVoucher("TotalsBlock");
  return (
    <View style={styles.totalsRow} wrap={breakable}>
      {aside ?? <View style={styles.aside} />}
      <View style={styles.totals}>
        {totalsRows(doc).map((row) => (
          <TotalRow amount={row.amount} key={row.key} label={row.label} />
        ))}
        {breakable ? null : <GrandTotal />}
      </View>
    </View>
  );
}

/** G1 and G3: the conditional legends. */
export function LegendsBlock() {
  const { doc, styles } = useVoucher("LegendsBlock");
  if (doc.legends.length === 0) {
    return null;
  }
  return (
    <View style={styles.legends} wrap={false}>
      {doc.legends.map((legend) => (
        <Text key={legend.rule}>{legend.text}</Text>
      ))}
    </View>
  );
}

/** L8, G2 and Ley 27.743: bottom left. L9, Q1: CAE, its due date and QR, bottom right. */
export function FiscalFooter({
  doc,
  styles,
}: {
  doc: VoucherDocument;
  styles: VoucherStyles;
}) {
  return (
    <View style={styles.footer}>
      <View style={styles.footerLeft}>
        {doc.transparency ? <Transparency doc={doc} styles={styles} /> : null}
      </View>
      <View style={styles.footerRight}>
        <ArcaQr url={doc.qr} />
        <View style={{ gap: 3 }}>
          <Text style={styles.cae}>
            {PRINTED_VOUCHER_TEXT.cae} {doc.authorization.code}
          </Text>
          <Text style={styles.caeDueDate}>
            {PRINTED_VOUCHER_TEXT.caeDueDate}{" "}
            {formatDate(doc.authorization.dueDate)}
          </Text>
        </View>
      </View>
    </View>
  );
}

function Transparency({
  doc,
  styles,
}: {
  doc: VoucherDocument;
  styles: VoucherStyles;
}) {
  const transparency = doc.transparency;
  if (transparency === undefined) {
    return null;
  }
  return (
    <>
      <Text style={styles.transparencyTitle}>
        {PRINTED_VOUCHER_TEXT.transparencyTitle}
      </Text>
      <Text style={styles.transparency}>
        {PRINTED_VOUCHER_TEXT.vatContained}:{" "}
        {formatMoney(transparency.vatContained, doc.currency.id)}
      </Text>
      <Text style={styles.transparency}>
        {PRINTED_VOUCHER_TEXT.otherNationalIndirectTaxes}:{" "}
        {formatMoney(transparency.otherNationalIndirectTaxes, doc.currency.id)}
      </Text>
    </>
  );
}
