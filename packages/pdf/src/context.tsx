import type { VoucherDocument } from "facturas";
import { createContext, useContext } from "react";
import type { ResolvedTheme, VoucherStyles } from "./theme";

export type VoucherContextValue = {
  doc: VoucherDocument;
  theme: ResolvedTheme;
  styles: VoucherStyles;
};

export const VoucherContext = createContext<VoucherContextValue | null>(null);

/** Every part reads the voucher from `<Voucher>`, and fails loudly outside it. */
export function useVoucher(part: string): VoucherContextValue {
  const context = useContext(VoucherContext);
  if (context === null) {
    throw new Error(`<${part}> must be used within <Voucher>.`);
  }
  return context;
}
