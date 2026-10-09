import { Document, Page, Text, View } from "@react-pdf/renderer";
import type { VoucherDocument } from "facturas";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  FiscalFooter,
  GrandTotal,
  IssuerHeader,
  LegendsBlock,
  LinesTable,
  ReceiverBlock,
  TotalsBlock,
  totalsBreak,
} from "./blocks";
import { useVoucher, VoucherContext } from "./context";
import { formatTitle } from "./format";
import { createStyles, resolveTheme, type VoucherTheme } from "./theme";

export type VoucherProps = {
  /** What `buildVoucherDocument()` returned. */
  doc: VoucherDocument;
  theme?: VoucherTheme;
  /** Only the slots: brand, issuer and receiver details, aside and notes. */
  children?: ReactNode;
};

/** Top left, above the issuer's name: a logo or a brand mark. */
export function VoucherBrand({ children }: { children?: ReactNode }) {
  useVoucher("VoucherBrand");
  return <View style={{ marginBottom: 10 }}>{children}</View>;
}

/**
 * In the issuer box, after the issuer's fiscal data: phone, email or website.
 */
export function VoucherIssuerDetails({ children }: { children?: ReactNode }) {
  const { styles } = useVoucher("VoucherIssuerDetails");
  return <View style={styles.details}>{children}</View>;
}

/** After the receiver's fiscal data: phone, email or a customer number. */
export function VoucherReceiverDetails({ children }: { children?: ReactNode }) {
  const { styles } = useVoucher("VoucherReceiverDetails");
  return <View style={styles.details}>{children}</View>;
}

/**
 * Beside the totals, on their left: payments received or the account
 * balance. It never takes the totals' column. It moves with the totals and
 * the CAE as one block, so keep it short.
 */
export function VoucherAside({ children }: { children?: ReactNode }) {
  const { styles } = useVoucher("VoucherAside");
  return <View style={styles.aside}>{children}</View>;
}

/**
 * After the receiver, before the lines, as Stripe's memo: anything else the
 * voucher should say, such as warranty, returns, a CBU or terms. It cannot sit
 * in a fiscal zone, and it may run long: it breaks across sheets.
 */
export function VoucherNotes({ children }: { children?: ReactNode }) {
  const { styles } = useVoucher("VoucherNotes");
  return <View style={styles.notes}>{children}</View>;
}

const SLOTS = new Map<unknown, keyof Slots>([
  [VoucherBrand, "brand"],
  [VoucherIssuerDetails, "issuerDetails"],
  [VoucherReceiverDetails, "receiverDetails"],
  [VoucherAside, "aside"],
  [VoucherNotes, "notes"],
]);

const SLOT_NAMES: Record<keyof Slots, string> = {
  brand: "VoucherBrand",
  issuerDetails: "VoucherIssuerDetails",
  receiverDetails: "VoucherReceiverDetails",
  aside: "VoucherAside",
  notes: "VoucherNotes",
};

type Slots = {
  brand?: ReactElement;
  issuerDetails?: ReactElement;
  receiverDetails?: ReactElement;
  aside?: ReactElement;
  notes?: ReactElement;
};

/** @internal Also used by `renderVoucherPdf` to refuse a wrong tree before rendering. */
export function collectSlots(children: ReactNode): Slots {
  const slots: Slots = {};
  for (const child of Children.toArray(children)) {
    const slot = isValidElement(child) ? SLOTS.get(child.type) : undefined;
    if (slot === undefined) {
      throw new Error(
        `<Voucher> only takes ${Object.values(SLOT_NAMES)
          .map((name) => `<${name}>`)
          .join(
            ", "
          )} as children: the fiscal blocks are placed by <Voucher> itself.`
      );
    }
    if (slots[slot] !== undefined) {
      throw new Error(`<Voucher> takes one <${SLOT_NAMES[slot]}>.`);
    }
    slots[slot] = child as ReactElement;
  }
  return slots;
}

function ClosingFooter() {
  const { doc, styles } = useVoucher("FiscalFooter");
  return <FiscalFooter doc={doc} styles={styles} />;
}

/** "Hoja n de m" on every sheet of a voucher that takes more than one. */
function sheetNumber({
  pageNumber,
  totalPages,
}: {
  pageNumber: number;
  totalPages: number;
}): string {
  return totalPages > 1 ? `Hoja ${pageNumber} de ${totalPages}` : "";
}

/**
 * An A4 printed voucher laid out as RG 1415, Anexo II, Apartado B places its
 * data. The fiscal blocks are fixed: a theme changes fonts and colours, and
 * the slots add a brand and notes, but nothing moves or drops a fiscal datum.
 */
export function Voucher({ doc, theme, children }: VoucherProps) {
  const slots = collectSlots(children);
  const resolved = resolveTheme(theme);
  const styles = createStyles(resolved);
  const breakTotals = totalsBreak(doc);
  return (
    <VoucherContext.Provider value={{ doc, theme: resolved, styles }}>
      <Document
        author={doc.issuer.legalName}
        creator="facturas"
        producer="@facturas/pdf"
        title={`${formatTitle(doc.title)} ${doc.voucherClass} ${doc.number}`}
      >
        <Page size="A4" style={styles.page}>
          <IssuerHeader brand={slots.brand} details={slots.issuerDetails} />
          <ReceiverBlock details={slots.receiverDetails} />
          {/* Free text goes before the lines, as Stripe's memo: it may run long and break across sheets. */}
          {slots.notes}
          <LinesTable />
          {/*
           * The total, legends and fiscal footer stay together: when they do
           * not fit, they move to the next sheet as one, so the CAE is never
           * alone. A long tax breakdown flows before them; see totalsBreak.
           */}
          {breakTotals ? <TotalsBlock breakable /> : null}
          <View style={styles.closing} wrap={false}>
            {breakTotals ? (
              // The aside stays beside the total, with the CAE.
              <View style={styles.grandTotalRow}>
                {slots.aside ?? <View style={styles.aside} />}
                <View style={styles.totals}>
                  <GrandTotal />
                </View>
              </View>
            ) : (
              <TotalsBlock aside={slots.aside} breakable={false} />
            )}
            <LegendsBlock />
            <ClosingFooter />
          </View>
          <Text fixed render={sheetNumber} style={styles.pageNumber} />
        </Page>
      </Document>
    </VoucherContext.Provider>
  );
}
