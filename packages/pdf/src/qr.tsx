import { Link, Path, Svg } from "@react-pdf/renderer";
import QRCode from "qrcode";
import { QR_SIZE } from "./theme";

/** The dark modules of a QR as one SVG path, one unit per module. */
export function qrPath(text: string): { size: number; d: string } {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: "M" });
  const { size, data } = modules;
  let d = "";
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      if (data[row * size + column]) {
        d += `M${column} ${row}h1v1h-1z`;
      }
    }
  }
  return { size, d };
}

/**
 * Q1 and Q2: the ARCA QR, drawn as vectors so it stays sharp when printed,
 * inside a link to the same URL so it can also be opened from the PDF.
 */
export function ArcaQr({ url }: { url: string }) {
  const { size, d } = qrPath(url);
  const quiet = 2;
  const box = size + quiet * 2;
  return (
    <Link src={url}>
      <Svg height={QR_SIZE} viewBox={`0 0 ${box} ${box}`} width={QR_SIZE}>
        <Path d={d} fill="#000000" transform={`translate(${quiet} ${quiet})`} />
      </Svg>
    </Link>
  );
}
