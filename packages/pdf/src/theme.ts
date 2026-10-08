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
  /** Labels and secondary text. */
  mutedColor?: string;
  /** The hairlines: the issuer box, the table rows and the totals. */
  borderColor?: string;
};

export type ResolvedTheme = Required<VoucherTheme>;

const DEFAULT_THEME: ResolvedTheme = {
  fontFamily: "Helvetica",
  boldFontFamily: "Helvetica-Bold",
  accentColor: "#1A1F36",
  textColor: "#30313D",
  mutedColor: "#687385",
  borderColor: "#E3E8EE",
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
  const hairline = {
    borderColor: theme.borderColor,
    borderStyle: "solid",
  } as const;
  return StyleSheet.create({
    page: {
      paddingTop: 32,
      paddingBottom: 44,
      paddingHorizontal: PAGE_MARGIN,
      fontFamily: theme.fontFamily,
      fontSize: 9,
      color: theme.textColor,
      flexDirection: "column",
    },
    bold,
    muted: { color: theme.mutedColor },
    // L3: the "recuadro" is a hairline rounded rectangle.
    header: {
      ...hairline,
      flexDirection: "row",
      minHeight: ISSUER_BOX_MIN_HEIGHT,
      borderWidth: 0.75,
      borderRadius: 12,
    },
    headerSide: { flex: 1, padding: BOX_PADDING, gap: 2.5 },
    headerRight: {
      flex: 1,
      padding: BOX_PADDING,
      gap: 2.5,
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
      ...hairline,
      width: 40,
      height: 40,
      borderWidth: 0.75,
      borderRadius: 8,
      alignItems: "center",
      justifyContent: "center",
    },
    letter: { ...bold, fontSize: 24, lineHeight: 1, color: theme.accentColor },
    code: { fontSize: 7, color: theme.mutedColor },
    letterLegend: { ...bold, fontSize: 6.5, textAlign: "center" },
    issuerName: {
      ...bold,
      fontSize: 11,
      color: theme.accentColor,
      marginBottom: 2,
    },
    details: { marginTop: 4, gap: 2.5, color: theme.mutedColor },
    conditionLegend: { fontSize: 7.5, color: theme.mutedColor, marginTop: 2 },
    title: { ...bold, fontSize: 18, lineHeight: 1.1, color: theme.accentColor },
    number: { ...bold, fontSize: 10, marginBottom: 6 },
    section: { marginTop: 24 },
    sectionTitle: {
      ...bold,
      fontSize: 7.5,
      color: theme.mutedColor,
      marginBottom: 3,
    },
    row: { flexDirection: "row" },
    columnLeft: { flex: 1, gap: 2.5, paddingRight: BOX_PADDING },
    columnRight: {
      width: RIGHT_COLUMN_WIDTH,
      paddingLeft: BOX_PADDING,
      gap: 2.5,
    },
    table: { marginTop: 6 },
    // Fixed, so on later sheets its top padding separates it from the box.
    tableHead: {
      flexDirection: "row",
      paddingTop: 18,
      paddingBottom: 5,
      borderBottomWidth: 1,
      borderBottomColor: theme.accentColor,
      borderBottomStyle: "solid",
      fontSize: 7.5,
      color: theme.mutedColor,
    },
    tableRow: {
      flexDirection: "row",
      paddingVertical: 6,
      borderBottomWidth: 0.5,
      borderBottomColor: theme.borderColor,
      borderBottomStyle: "solid",
    },
    cellCode: { width: 72, paddingRight: 8 },
    cellDescription: { flex: 1, paddingRight: 6 },
    cellNumber: { width: 64, textAlign: "right" },
    cellDiscount: { width: 52, textAlign: "right" },
    cellNarrow: { width: 40, textAlign: "right" },
    closing: { flexGrow: 1 },
    totalsRow: { flexDirection: "row", marginTop: 14, gap: 32 },
    aside: { flex: 1, paddingTop: 5 },
    totals: { width: 260 },
    totalRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      paddingVertical: 5,
      borderBottomWidth: 0.5,
      borderBottomColor: theme.borderColor,
      borderBottomStyle: "solid",
    },
    grandTotal: {
      ...bold,
      fontSize: 11,
      color: theme.accentColor,
      borderBottomWidth: 0,
      paddingTop: 7,
    },
    legends: {
      marginTop: 20,
      gap: 2,
      fontSize: 7.5,
      lineHeight: 1.4,
      color: theme.mutedColor,
    },
    notes: { marginTop: 20, color: theme.mutedColor },
    footer: {
      marginTop: "auto",
      paddingTop: 16,
      borderTopWidth: 0.5,
      borderTopColor: theme.borderColor,
      borderTopStyle: "solid",
      flexDirection: "row",
      gap: 16,
    },
    footerLeft: { flex: 1, gap: 2, justifyContent: "flex-end" },
    footerRight: {
      flex: 1,
      flexDirection: "row",
      gap: 12,
      justifyContent: "flex-end",
      alignItems: "center",
    },
    transparencyTitle: { ...bold, fontSize: 7.5, marginBottom: 2 },
    transparency: { fontSize: 8, color: theme.mutedColor },
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
      fontSize: 7,
      color: theme.mutedColor,
    },
  });
}

export type VoucherStyles = ReturnType<typeof createStyles>;
