import { StyleSheet } from "@react-pdf/renderer";

/**
 * What a voucher may restyle: fonts and colours. Sizes and placement are
 * fixed, because the norms set them (the CAE due date at 12 pt or more, the
 * Apartado B zones), so a theme cannot shrink or move a fiscal datum.
 */
export type VoucherTheme = {
  /** A family registered with `Font.register`, or a standard PDF font. */
  fontFamily?: string;
  /** The bold face of `fontFamily`. */
  boldFontFamily?: string;
  /** Titles, the letter and the total. */
  accentColor?: string;
  /** Body text. */
  textColor?: string;
  /** The labels before a value, such as "CUIT:". */
  mutedColor?: string;
  /** The separators between table rows and totals. */
  borderColor?: string;
};

export type ResolvedTheme = Required<VoucherTheme>;

const DEFAULT_THEME: ResolvedTheme = {
  fontFamily: "Helvetica",
  boldFontFamily: "Helvetica-Bold",
  accentColor: "#000000",
  textColor: "#000000",
  mutedColor: "#000000",
  borderColor: "#EBEBEB",
};

export function resolveTheme(theme: VoucherTheme = {}): ResolvedTheme {
  const resolved = { ...DEFAULT_THEME };
  for (const key of Object.keys(DEFAULT_THEME) as (keyof ResolvedTheme)[]) {
    const value = theme[key];
    if (typeof value === "string" && value.trim() !== "") {
      resolved[key] = value;
    }
  }
  return resolved;
}

/** RG 1415, Anexo II, B, after b): the issuer data box is at least 7 × 3 cm. */
const CM = 72 / 2.54;
export const ISSUER_BOX_MIN_HEIGHT = 3 * CM;
/** L9: the CAE due date is printed at 12 pt. */
export const CAE_DUE_DATE_FONT_SIZE = 12;
export const QR_SIZE = 76;
const OUTLINE_COLOR = "#999999";

const A4_WIDTH = 595.28;
const PAGE_MARGIN = 40;
const BOX_PADDING = 14;
const LETTER_COLUMN_WIDTH = 84;
/**
 * The right column of the issuer box. The receiver section's second column
 * takes the same width, so all the text on the right starts on one vertical.
 */
const RIGHT_COLUMN_WIDTH =
  (A4_WIDTH - 2 * PAGE_MARGIN - LETTER_COLUMN_WIDTH) / 2;

export function createStyles(theme: ResolvedTheme) {
  const bold = { fontFamily: theme.boldFontFamily };
  // Leading for wrapped text, set per block: on the page it would reach the
  // sheet number, and react-pdf drops a `render` text that sets one. A block
  // resolves it against its own font size, so the size goes with it.
  const leading = { fontSize: 9, lineHeight: 1.35 };
  // The issuer box and the letter box: a mid grey, darker than the separators
  // so the box L3 requires shows on screen and in print.
  const outline = {
    borderColor: OUTLINE_COLOR,
    borderStyle: "solid",
    borderWidth: 0.6,
  } as const;
  return StyleSheet.create({
    page: {
      paddingTop: 32,
      paddingBottom: 36,
      paddingHorizontal: PAGE_MARGIN,
      fontFamily: theme.fontFamily,
      fontSize: 9,
      color: theme.textColor,
      flexDirection: "column",
    },
    bold,
    muted: { color: theme.mutedColor },
    // L3: the "recuadro" is a thin rounded rectangle.
    header: {
      ...outline,
      flexDirection: "row",
      minHeight: ISSUER_BOX_MIN_HEIGHT,
      borderRadius: 12,
    },
    headerSide: { ...leading, flex: 1, padding: BOX_PADDING, gap: 1 },
    headerRight: {
      ...leading,
      flex: 1,
      padding: BOX_PADDING,
      gap: 1,
      alignItems: "flex-start",
    },
    headerCenter: {
      width: LETTER_COLUMN_WIDTH,
      alignItems: "center",
      paddingTop: 14,
      gap: 5,
    },
    // L4: the letter stands out by its size and weight, in an outlined box.
    letterBox: {
      ...outline,
      width: 40,
      height: 40,
      borderRadius: 8,
      alignItems: "center",
      justifyContent: "center",
    },
    letter: { ...bold, fontSize: 24, lineHeight: 1, color: theme.accentColor },
    code: { fontSize: 7.5, color: theme.textColor },
    letterLegend: { ...bold, fontSize: 6.5, textAlign: "center" },
    issuerName: {
      ...bold,
      fontSize: 11,
      color: theme.accentColor,
      marginBottom: 2,
    },
    details: { marginTop: 4, gap: 1, color: theme.textColor },
    conditionLegend: { color: theme.textColor, marginTop: 2 },
    title: { ...bold, fontSize: 18, lineHeight: 1.1, color: theme.accentColor },
    number: { ...bold, fontSize: 10, marginBottom: 6 },
    section: { marginTop: 18 },
    sectionTitle: {
      ...bold,
      fontSize: 9,
      color: theme.textColor,
      marginBottom: 3,
    },
    row: { flexDirection: "row" },
    columnLeft: { ...leading, flex: 1, gap: 1, paddingRight: BOX_PADDING },
    columnRight: {
      ...leading,
      width: RIGHT_COLUMN_WIDTH,
      paddingLeft: BOX_PADDING,
      gap: 1,
    },
    table: { ...leading, marginTop: 6 },
    // Fixed, so on later sheets its top padding separates it from the box.
    tableHead: {
      flexDirection: "row",
      paddingTop: 18,
      paddingBottom: 5,
      borderBottomWidth: 1,
      borderBottomColor: theme.accentColor,
      borderBottomStyle: "solid",
      fontSize: 7.5,
      color: theme.textColor,
    },
    tableRow: {
      flexDirection: "row",
      paddingVertical: 3,
      borderBottomWidth: 0.5,
      borderBottomColor: theme.borderColor,
      borderBottomStyle: "solid",
    },
    cellCode: { width: 72, paddingRight: 8 },
    cellDescription: { flex: 1, paddingRight: 6 },
    cellNumber: { width: 64, textAlign: "right" },
    cellDiscount: { width: 52, textAlign: "right" },
    cellNarrow: { width: 40, textAlign: "right" },
    totalsRow: { flexDirection: "row", marginTop: 10, gap: 32 },
    aside: { flex: 1, paddingTop: 5 },
    totals: { ...leading, width: 240 },
    totalRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      // Stripe's pitch: 9 pt rows, 14.25 pt apart.
      paddingVertical: 1,
      borderBottomWidth: 0.5,
      borderBottomColor: theme.borderColor,
      borderBottomStyle: "solid",
    },
    // A long tax name wraps in its own column; the amount keeps its width.
    totalLabel: { flex: 1, paddingRight: 8 },
    totalAmount: { flexShrink: 0, textAlign: "right" },
    grandTotal: {
      ...bold,
      color: theme.accentColor,
      borderBottomWidth: 0,
    },
    legends: {
      marginTop: 20,
      gap: 2,
      fontSize: 7.5,
      lineHeight: 1.4,
      color: theme.textColor,
    },
    notes: { ...leading, marginTop: 14, color: theme.textColor },
    closing: { flexGrow: 1 },
    footer: {
      marginTop: "auto",
      paddingTop: 12,
      borderTopWidth: 0.5,
      borderTopColor: theme.borderColor,
      borderTopStyle: "solid",
      flexDirection: "row",
      gap: 16,
    },
    footerLeft: { ...leading, flex: 1, gap: 1, justifyContent: "flex-end" },
    footerRight: {
      flex: 1,
      flexDirection: "row",
      gap: 12,
      justifyContent: "flex-end",
      alignItems: "center",
    },
    transparencyTitle: { ...bold, fontSize: 7.5, marginBottom: 2 },
    transparency: { fontSize: 8, color: theme.textColor },
    cae: { ...bold, fontSize: 10, color: theme.accentColor },
    caeDueDate: {
      ...bold,
      fontSize: CAE_DUE_DATE_FONT_SIZE,
      color: theme.accentColor,
    },
    // No lineHeight here: react-pdf drops a `render` text that sets one.
    pageNumber: {
      position: "absolute",
      bottom: 20,
      right: 40,
      fontSize: 7.5,
      color: theme.textColor,
    },
  });
}

export type VoucherStyles = ReturnType<typeof createStyles>;
