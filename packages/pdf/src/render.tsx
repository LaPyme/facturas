import {
  type DocumentProps,
  Image,
  renderToBuffer,
  Text,
} from "@react-pdf/renderer";
import type { VoucherDocument } from "facturas";
import { isValidElement, type ReactElement } from "react";
import type { VoucherTheme } from "./theme";
import {
  collectSlots,
  Voucher,
  VoucherBrand,
  VoucherNotes,
  type VoucherProps,
} from "./voucher";

export type RenderVoucherPdfOptions = {
  theme?: VoucherTheme;
  /** A PNG or JPEG for the brand slot: a URL, a data URI or its bytes. */
  logo?: string | Uint8Array;
  /** Free text for the notes slot, such as warranty or returns. */
  notes?: string;
};

/**
 * The A4 PDF of a voucher. Pass the document, with the options for a logo and
 * notes, or a `<Voucher>` element you composed. A wrong composition throws
 * here, before anything renders, with the error that names the mistake.
 */
export async function renderVoucherPdf(
  input: VoucherDocument | ReactElement<VoucherProps>,
  options: RenderVoucherPdfOptions = {}
): Promise<Uint8Array> {
  const element = isValidElement(input)
    ? input
    : defaultVoucher(input, options);
  if (element.type !== Voucher) {
    throw new Error(
      "renderVoucherPdf() renders a <Voucher> element or a voucher document."
    );
  }
  collectSlots((element.props as VoucherProps).children);
  // <Voucher> renders a <Document> at its root, which is what react-pdf expects.
  const document = element as unknown as ReactElement<DocumentProps>;
  return new Uint8Array(await renderToBuffer(document));
}

function defaultVoucher(
  doc: VoucherDocument,
  options: RenderVoucherPdfOptions
): ReactElement<VoucherProps> {
  const logo =
    options.logo instanceof Uint8Array
      ? Buffer.from(options.logo)
      : options.logo;
  return (
    <Voucher doc={doc} theme={options.theme}>
      {logo === undefined ? null : (
        <VoucherBrand>
          <Image
            src={logo}
            style={{ maxHeight: 40, maxWidth: 140, objectFit: "contain" }}
          />
        </VoucherBrand>
      )}
      {options.notes ? (
        <VoucherNotes>
          <Text>{options.notes}</Text>
        </VoucherNotes>
      ) : null}
    </Voucher>
  );
}
