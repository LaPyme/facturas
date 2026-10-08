import { Text, View } from "@react-pdf/renderer";
import { PRINTED_VOUCHER_TEXT, type VoucherDocument } from "facturas";
import type { ReactNode } from "react";
import { useVoucher } from "./context";
import {
  formatAmount,
  formatDate,
  formatDecimal,
  formatMoney,
  formatQuantity,
  formatTaxId,
  formatTitle,
  formatVatRate,
} from "./format";
import { ArcaQr } from "./qr";

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
export function IssuerHeader({ brand }: { brand?: ReactNode }) {
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
        <Text style={styles.conditionLegend}>{issuer.conditionLegend}</Text>
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
export function ReceiverBlock() {
  const { doc, styles } = useVoucher("ReceiverBlock");
  const { receiver } = doc;
  return (
    <View style={styles.section}>
      <View style={styles.row}>
        <View style={styles.columnLeft}>
          <Text style={styles.sectionTitle}>Receptor</Text>
          {receiver.name ? (
            <Labeled label="Razón social:">{receiver.name}</Labeled>
          ) : null}
          {receiver.document ? (
            <Labeled label={`${receiver.document.label ?? "Documento"}:`}>
              {formatTaxId(receiver.document.number)}
            </Labeled>
          ) : null}
          {receiver.address ? (
            <Labeled label="Domicilio:">{receiver.address}</Labeled>
          ) : null}
          <Text style={styles.bold}>{receiver.conditionLegend}</Text>
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

/** Descriptions wrap between words, never as "Col-or". */
function wholeWord(word: string): string[] {
  return [word];
}

/** C19 to C21: the lines, without VAT on class A and with VAT on class B. */
export function LinesTable() {
  const { doc, styles } = useVoucher("LinesTable");
  const showCode = doc.lines.some((line) => line.code !== undefined);
  const showDiscount = doc.lines.some((line) => line.discount !== undefined);
  const showRate = doc.voucherClass === "A";
  return (
    <View style={styles.table}>
      <View fixed style={styles.tableHead}>
        {showCode ? <Text style={styles.cellCode}>Código</Text> : null}
        <Text style={styles.cellDescription}>Descripción</Text>
        <Text style={styles.cellNarrow}>Cant.</Text>
        <Text style={styles.cellNumber}>P. unitario</Text>
        {showDiscount ? <Text style={styles.cellNumber}>Bonif.</Text> : null}
        {showRate ? <Text style={styles.cellNarrow}>IVA</Text> : null}
        <Text style={styles.cellNumber}>Subtotal</Text>
      </View>
      {doc.lines.map((line, index) => (
        <View
          key={`${index}-${line.description}`}
          style={styles.tableRow}
          wrap={false}
        >
          {showCode ? (
            <Text style={styles.cellCode}>{line.code ?? ""}</Text>
          ) : null}
          <Text hyphenationCallback={wholeWord} style={styles.cellDescription}>
            {line.description}
          </Text>
          <Text style={styles.cellNarrow}>{formatQuantity(line.quantity)}</Text>
          <Text style={styles.cellNumber}>{formatDecimal(line.unitPrice)}</Text>
          {showDiscount ? (
            <Text style={styles.cellNumber}>
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
    <View style={styles.totalRow}>
      <Text style={styles.muted}>{label}</Text>
      <Text>{formatMoney(amount, doc.currency.id)}</Text>
    </View>
  );
}

/** C23, C25, L7: totals, with one VAT row per rate right after the lines on class A. */
export function TotalsBlock() {
  const { doc, styles } = useVoucher("TotalsBlock");
  const { totals } = doc;
  const classA = doc.voucherClass === "A";
  return (
    <View style={styles.totals} wrap={false}>
      <TotalRow
        amount={totals.subtotal}
        label={classA ? "Importe neto gravado" : "Subtotal"}
      />
      {classA && totals.exempt > 0 ? (
        <TotalRow amount={totals.exempt} label="Importe exento" />
      ) : null}
      {classA && totals.untaxed > 0 ? (
        <TotalRow amount={totals.untaxed} label="Importe no gravado" />
      ) : null}
      {totals.vatRates.map((row) => (
        <TotalRow
          amount={row.amount}
          key={row.id}
          label={`IVA ${row.rate === undefined ? `(${row.id})` : formatVatRate(row.rate)}`}
        />
      ))}
      {totals.otherTaxes.map((tax, index) => (
        <TotalRow
          amount={tax.amount}
          // Two provinces' IIBB perceptions share the tribute id.
          key={`${index}-${tax.id}`}
          label={tax.description}
        />
      ))}
      {totals.adjustment === 0 ? null : (
        <TotalRow amount={totals.adjustment} label="Ajuste" />
      )}
      <View style={[styles.totalRow, styles.grandTotal]}>
        <Text>Importe total</Text>
        <Text>{formatMoney(totals.total, doc.currency.id)}</Text>
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
export function FiscalFooter() {
  const { doc, styles } = useVoucher("FiscalFooter");
  return (
    <View style={styles.footer} wrap={false}>
      <View style={styles.footerLeft}>
        {doc.transparency ? <Transparency doc={doc} /> : null}
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

function Transparency({ doc }: { doc: VoucherDocument }) {
  const { styles } = useVoucher("Transparency");
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
