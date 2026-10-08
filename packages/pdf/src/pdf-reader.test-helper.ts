import { createRequire } from "node:module";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/** Reads back what a rendered PDF shows: text runs with position and size, and links. */

export type PdfText = {
  page: number;
  text: string;
  /** Points from the left edge. */
  x: number;
  /** Points from the top edge, so "top" reads as on paper. */
  top: number;
  fontSize: number;
};

export type PdfPage = {
  width: number;
  height: number;
  texts: PdfText[];
  links: { url: string; x: number; top: number }[];
};

const STANDARD_FONTS = createRequire(import.meta.url)
  .resolve("pdfjs-dist/package.json")
  .replace("package.json", "standard_fonts/");

export async function readPdf(bytes: Uint8Array): Promise<PdfPage[]> {
  const pdf = await getDocument({
    data: bytes.slice(),
    standardFontDataUrl: STANDARD_FONTS,
  }).promise;
  const pages: PdfPage[] = [];
  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number);
    const { width, height } = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const texts = content.items.flatMap((item) => {
      if (!("str" in item) || item.str.trim() === "") {
        return [];
      }
      const [scaleX, , , scaleY, x, y] = item.transform as number[];
      return [
        {
          page: number,
          text: item.str,
          x,
          top: height - y,
          fontSize:
            Math.round(Math.max(Math.abs(scaleX), Math.abs(scaleY)) * 10) / 10,
        },
      ];
    });
    const annotations = await page.getAnnotations();
    const links = annotations
      .filter((annotation) => typeof annotation.url === "string")
      .map((annotation) => {
        const [x1, , , y2] = annotation.rect as number[];
        return { url: annotation.url as string, x: x1, top: height - y2 };
      });
    pages.push({ width, height, texts, links });
  }
  return pages;
}

/** The first run on the page whose text contains `fragment`. */
export function find(page: PdfPage, fragment: string): PdfText {
  const found = page.texts.find((text) => text.text.includes(fragment));
  if (found === undefined) {
    throw new Error(
      `"${fragment}" is not on the page. Runs: ${page.texts.map((text) => text.text).join(" | ")}`
    );
  }
  return found;
}

/** The first run on the page whose whole text is `text`. */
export function findExact(page: PdfPage, text: string): PdfText {
  const found = page.texts.find((run) => run.text.trim() === text);
  if (found === undefined) {
    throw new Error(`"${text}" is not a run on the page.`);
  }
  return found;
}

export function hasText(page: PdfPage, fragment: string): boolean {
  return page.texts.some((text) => text.text.includes(fragment));
}
