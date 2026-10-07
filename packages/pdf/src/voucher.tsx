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
  IssuerHeader,
  LegendsBlock,
  LinesTable,
  ReceiverBlock,
  TotalsBlock,
} from "./blocks";
import { useVoucher, VoucherContext } from "./context";
import { formatTitle } from "./format";
import { createStyles, resolveTheme, type VoucherTheme } from "./theme";

export type VoucherProps = {
  /** What `buildVoucherDocument()` returned. */
  doc: VoucherDocument;
  theme?: VoucherTheme;
  /** Only `<VoucherBrand>` and `<VoucherNotes>`. */
  children?: ReactNode;
};

/** Top left, above the issuer's name: a logo or a brand mark. */
export function VoucherBrand({ children }: { children?: ReactNode }) {
  useVoucher("VoucherBrand");
  return <View style={{ marginBottom: 4 }}>{children}</View>;
}

/**
 * After the totals and legends: anything else the voucher should say, such as
 * warranty, returns or contact. It cannot sit in a fiscal zone.
 */
export function VoucherNotes({ children }: { children?: ReactNode }) {
  const { styles } = useVoucher("VoucherNotes");
  return <View style={styles.notes}>{children}</View>;
}

const SLOTS = new Map<unknown, "brand" | "notes">([
  [VoucherBrand, "brand"],
  [VoucherNotes, "notes"],
]);

/** @internal Also used by `renderVoucherPdf` to refuse a wrong tree before rendering. */
export function collectSlots(children: ReactNode) {
  const slots: { brand?: ReactElement; notes?: ReactElement } = {};
  for (const child of Children.toArray(children)) {
    const slot = isValidElement(child) ? SLOTS.get(child.type) : undefined;
    if (slot === undefined) {
      throw new Error(
        "<Voucher> only takes <VoucherBrand> and <VoucherNotes> as children: the fiscal blocks are placed by <Voucher> itself."
      );
    }
    if (slots[slot] !== undefined) {
      throw new Error(
        `<Voucher> takes one <${slot === "brand" ? "VoucherBrand" : "VoucherNotes"}>.`
      );
    }
    slots[slot] = child as ReactElement;
  }
  return slots;
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
  return (
    <VoucherContext.Provider value={{ doc, theme: resolved, styles }}>
      <Document
        author={doc.issuer.legalName}
        creator="facturas"
        producer="@facturas/pdf"
        title={`${formatTitle(doc.title)} ${doc.voucherClass} ${doc.number}`}
      >
        <Page size="A4" style={styles.page}>
          <IssuerHeader brand={slots.brand} />
          <ReceiverBlock />
          <LinesTable />
          <TotalsBlock />
          <LegendsBlock />
          {slots.notes}
          <FiscalFooter />
          <Text fixed render={sheetNumber} style={styles.pageNumber} />
        </Page>
      </Document>
    </VoucherContext.Provider>
  );
}
