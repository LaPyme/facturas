/** es-AR formatting of the model's minor units, ISO dates and identifiers. */

const CURRENCY_PREFIX: Record<string, string> = { PES: "$", DOL: "USD" };

/** Minor units as `1.234,56`, with no floating point on the way. */
export function formatAmount(minor: number): string {
  const negative = minor < 0;
  const digits = String(Math.abs(Math.trunc(minor))).padStart(3, "0");
  const units = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "-" : ""}${units},${digits.slice(-2)}`;
}

/** Minor units with the voucher currency: `$ 1.234,56` or `USD 1.234,56`. */
export function formatMoney(minor: number, currencyId: string): string {
  return `${CURRENCY_PREFIX[currencyId] ?? currencyId} ${formatAmount(minor)}`;
}

/** A major-unit decimal string such as `605.5` as `605,50`, keeping extra decimals. */
export function formatDecimal(value: string): string {
  const [units = "0", decimals = ""] = value.split(".");
  return `${units.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${decimals.padEnd(2, "0")}`;
}

export function formatQuantity(quantity: number): string {
  return String(quantity).replace(".", ",");
}

/** `YYYY-MM-DD` as `DD/MM/YYYY`. */
export function formatDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year}`;
}

/** An 11-digit CUIT as `20-12345678-9`; anything else is left as is. */
export function formatTaxId(value: string): string {
  return /^\d{11}$/.test(value)
    ? `${value.slice(0, 2)}-${value.slice(2, 10)}-${value.slice(10)}`
    : value;
}

/** A VAT rate as `21%` or `10,5%`, or the word for exempt and untaxed lines. */
export function formatVatRate(rate: number | "exempt" | "untaxed"): string {
  if (rate === "exempt") {
    return "Exento";
  }
  if (rate === "untaxed") {
    return "No gravado";
  }
  return `${String(rate).replace(".", ",")}%`;
}
