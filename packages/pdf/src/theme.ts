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
  /** Box and table lines. */
  borderColor?: string;
};

export type ResolvedTheme = Required<VoucherTheme>;

const DEFAULT_THEME: ResolvedTheme = {
  fontFamily: "Helvetica",
  boldFontFamily: "Helvetica-Bold",
  accentColor: "#111111",
  textColor: "#1F1F1F",
  mutedColor: "#5C5C5C",
  borderColor: "#8C8C8C",
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

export function createStyles(theme: ResolvedTheme) {
  const bold = { fontFamily: theme.boldFontFamily };
  return StyleSheet.create({
    page: {
      paddingTop: 28,
      paddingBottom: 36,
      paddingHorizontal: 28,
      fontFamily: theme.fontFamily,
      fontSize: 9,
      color: theme.textColor,
      flexDirection: "column",
    },
    bold,
    muted: { color: theme.mutedColor },
    header: {
      flexDirection: "row",
      minHeight: ISSUER_BOX_MIN_HEIGHT,
      borderWidth: 1,
      borderColor: theme.borderColor,
    },
    headerSide: { flex: 1, padding: 10, gap: 2 },
    headerRight: { flex: 1, padding: 10, gap: 2, alignItems: "flex-start" },
    headerCenter: {
      width: 78,
      alignItems: "center",
      paddingTop: 6,
      gap: 3,
    },
    letterBox: {
      width: 50,
      height: 50,
      borderWidth: 1.5,
      borderColor: theme.accentColor,
      alignItems: "center",
      justifyContent: "center",
    },
    letter: { ...bold, fontSize: 30, color: theme.accentColor },
    code: { fontSize: 7 },
    letterLegend: { ...bold, fontSize: 6.5, textAlign: "center" },
    issuerName: { ...bold, fontSize: 11, color: theme.accentColor },
    title: { ...bold, fontSize: 14, color: theme.accentColor },
    number: { ...bold, fontSize: 11, marginBottom: 4 },
    section: {
      marginTop: 8,
      borderWidth: 1,
      borderColor: theme.borderColor,
      padding: 8,
      gap: 2,
    },
    row: { flexDirection: "row", gap: 12 },
    half: { flex: 1, gap: 2 },
    table: { marginTop: 8 },
    tableHead: {
      flexDirection: "row",
      borderBottomWidth: 1,
      borderBottomColor: theme.accentColor,
      paddingBottom: 3,
      ...bold,
    },
    tableRow: {
      flexDirection: "row",
      borderBottomWidth: 0.5,
      borderBottomColor: theme.borderColor,
      paddingVertical: 3,
    },
    cellCode: { width: 56, paddingRight: 4 },
    cellDescription: { flex: 1, paddingRight: 4 },
    cellNumber: { width: 58, textAlign: "right" },
    cellNarrow: { width: 40, textAlign: "right" },
    totals: { marginTop: 8, marginLeft: "auto", width: 230, gap: 2 },
    totalRow: { flexDirection: "row", justifyContent: "space-between" },
    grandTotal: {
      ...bold,
      fontSize: 11,
      color: theme.accentColor,
      borderTopWidth: 1,
      borderTopColor: theme.accentColor,
      paddingTop: 3,
      marginTop: 2,
    },
    legends: { marginTop: 8, gap: 2, fontSize: 8 },
    notes: { marginTop: 8 },
    footer: {
      marginTop: "auto",
      paddingTop: 10,
      flexDirection: "row",
      gap: 12,
      borderTopWidth: 1,
      borderTopColor: theme.borderColor,
    },
    footerLeft: { flex: 1, gap: 2, justifyContent: "flex-end" },
    footerRight: {
      flex: 1,
      flexDirection: "row",
      gap: 10,
      justifyContent: "flex-end",
      alignItems: "center",
    },
    transparencyTitle: { ...bold, fontSize: 8 },
    cae: { ...bold, fontSize: 10 },
    caeDueDate: { ...bold, fontSize: CAE_DUE_DATE_FONT_SIZE },
    pageNumber: {
      position: "absolute",
      bottom: 14,
      right: 28,
      fontSize: 7,
      color: theme.mutedColor,
    },
  });
}

export type VoucherStyles = ReturnType<typeof createStyles>;
