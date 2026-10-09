import { renderToBuffer, Text } from "@react-pdf/renderer";
import { MONOTRIBUTO_CREDIT_LEGEND, type VoucherDocument } from "facturas";
import { describe, expect, it } from "vitest";
import {
  classADocument,
  classBDocument,
  classCDocument,
  longDocument,
} from "./fixtures.test-helper";
import { formatConditionLegend } from "./format";
import {
  find,
  findExact,
  hasText,
  type PdfPage,
  readPdf,
} from "./pdf-reader.test-helper";
import { renderVoucherPdf } from "./render";
import {
  Voucher,
  VoucherAside,
  VoucherBrand,
  VoucherIssuerDetails,
  VoucherNotes,
  VoucherReceiverDetails,
} from "./voucher";

/**
 * Each rendered voucher is read back and checked rule by rule, with the ids of
 * `.github/PRINTED_VOUCHER_SOURCES.md`. Positions are in points from the top
 * left corner of an A4 page (595 × 842).
 */

async function render(doc: VoucherDocument): Promise<PdfPage[]> {
  return await readPdf(
    await renderVoucherPdf(doc, { notes: "Garantía de 6 meses." })
  );
}

/** The issuer box spans the top of the page: the first 3 cm plus the page margin. */
const TOP_ZONE = 140;

function expectApartadoB(page: PdfPage, doc: VoucherDocument) {
  const middle = page.width / 2;
  // L4: the letter, highlighted, at the top centre, with its code below.
  const letter = findExact(page, doc.voucherClass);
  expect(letter.top).toBeLessThan(TOP_ZONE);
  expect(Math.abs(letter.x + letter.fontSize * 0.36 - middle)).toBeLessThan(10);
  expect(letter.fontSize).toBeGreaterThanOrEqual(24);
  const code = find(page, `Código Nº ${doc.code}`);
  expect(code.top).toBeGreaterThan(letter.top);
  expect(Math.abs(code.x + 23 - middle)).toBeLessThan(15);
  // L1: issuer name, address and VAT legend, top left.
  for (const fragment of [
    doc.issuer.legalName,
    doc.issuer.address,
    formatConditionLegend(doc.issuer.conditionLegend),
  ]) {
    const text = find(page, fragment);
    expect(text.x).toBeLessThan(middle - 40);
    expect(text.top).toBeLessThan(TOP_ZONE);
  }
  // L2: number, date, CUIT, ingresos brutos and start of activities, top right.
  for (const fragment of [
    `Nº ${doc.number}`,
    "Fecha de emisión:",
    "CUIT: 20-12345678-9",
    `Ingresos Brutos: ${doc.issuer.grossIncome}`,
    ...(doc.issuer.activitiesStartDate ? ["Inicio de actividades:"] : []),
  ]) {
    const text = find(page, fragment);
    expect(text.x).toBeGreaterThan(middle + 30);
    expect(text.top).toBeLessThan(TOP_ZONE);
  }
}

function expectFiscalFooter(page: PdfPage, doc: VoucherDocument) {
  const middle = page.width / 2;
  const bottom = page.height * 0.82;
  // L9 and C8: the CAE, bottom right.
  const cae = find(page, `C.A.E. N° ${doc.authorization.code}`);
  expect(cae.x).toBeGreaterThan(middle);
  expect(cae.top).toBeGreaterThan(bottom);
  // L9 and C9: its due date, bottom right, at 12 pt or more.
  const dueDate = find(page, "Fecha Vto.: 15/09/2026");
  expect(dueDate.x).toBeGreaterThan(middle);
  expect(dueDate.fontSize).toBeGreaterThanOrEqual(12);
  // Q1 and Q2: the QR, bottom right, carrying the voucher's ARCA URL.
  expect(page.links).toEqual([expect.objectContaining({ url: doc.qr })]);
  const [link] = page.links;
  expect(link?.x).toBeGreaterThan(middle);
  expect(link?.top).toBeGreaterThan(bottom - 60);
}

describe("<Voucher>", () => {
  it("lays out a class B consumer invoice as Apartado B places it", async () => {
    const doc = classBDocument();
    const [page] = await render(doc);
    if (page === undefined) {
      throw new Error("no page");
    }
    expectApartadoB(page, doc);
    expectFiscalFooter(page, doc);
    // The receiver's second column starts where the issuer box's right column does.
    expect(find(page, "Condición de venta:").x).toBeCloseTo(
      find(page, "Fecha de emisión:").x,
      0
    );
    // C15: the receiver legend; L6 and C12: sale conditions and remitos.
    expect(hasText(page, "A Consumidor Final")).toBe(true);
    expect(hasText(page, "Condición de venta: Contado")).toBe(true);
    expect(hasText(page, "Remitos: 0003-00000012")).toBe(true);
    // C19 to C21: description, quantity, unit and total prices with VAT.
    expect(hasText(page, "Taladro percutor 13 mm")).toBe(true);
    expect(hasText(page, "605,00")).toBe(true);
    expect(hasText(page, "1.210,00")).toBe(true);
    // L8 and G2: the transparency block, bottom left, with both amounts.
    const title = find(
      page,
      "Régimen de Transparencia Fiscal al Consumidor (Ley 27.743)"
    );
    expect(title.x).toBeLessThan(page.width / 2);
    expect(title.top).toBeGreaterThan(page.height * 0.82);
    expect(hasText(page, "IVA Contenido: $ 212,30")).toBe(true);
    expect(hasText(page, "Otros Impuestos Nacionales Indirectos: $ 0,00")).toBe(
      true
    );
    // Class B never breaks out VAT by rate.
    expect(hasText(page, "IVA 21%")).toBe(false);
    expect(hasText(page, "Importe total")).toBe(true);
    // The title, in sentence case, top right.
    expect(findExact(page, "Factura").x).toBeGreaterThan(page.width / 2);
    expect(hasText(page, "FACTURA")).toBe(false);
  });

  it("breaks VAT out by rate on class A, with its legends and no transparency block", async () => {
    const doc = classADocument();
    const [page] = await render(doc);
    if (page === undefined) {
      throw new Error("no page");
    }
    expectApartadoB(page, doc);
    expectFiscalFooter(page, doc);
    // C13, C16: the receiver's name, document, address and legend.
    for (const fragment of [
      "Juan Pérez",
      "CUIT: 20-11111111-2 · Responsable Monotributo",
      "Calle 1, Rosario",
    ]) {
      expect(hasText(page, fragment)).toBe(true);
    }
    // C25 and L7: rate and tax per rate, after the lines.
    const rate = find(page, "IVA 21%");
    expect(rate.top).toBeGreaterThan(find(page, "Repuestos").top);
    expect(hasText(page, "IVA 10,5%")).toBe(true);
    expect(hasText(page, "Importe neto gravado")).toBe(true);
    expect(hasText(page, "IIBB")).toBe(true);
    // G1 and G3.
    expect(page.texts.map((text) => text.text).join(" ")).toContain(
      MONOTRIBUTO_CREDIT_LEGEND
    );
    expect(hasText(page, "Observaciones de ARCA: 10217")).toBe(true);
    expect(hasText(page, "Régimen de Transparencia Fiscal")).toBe(false);
  });

  it("drops the line rate column on class A when every line has the same rate", async () => {
    const doc = classADocument();
    const single = {
      ...doc,
      lines: doc.lines.map((line) => ({ ...line, vatRate: 21 as const })),
    };
    const [page] = await render(single);
    if (page === undefined) {
      throw new Error("no page");
    }
    expect(page.texts.some((text) => text.text.trim() === "IVA")).toBe(false);
    const [mixed] = await render(doc);
    expect(mixed?.texts.some((text) => text.text.trim() === "IVA")).toBe(true);
  });

  it("renders class C without VAT, transparency block or an exempt start of activities", async () => {
    const doc = classCDocument();
    const [page] = await render(doc);
    if (page === undefined) {
      throw new Error("no page");
    }
    expectApartadoB(page, doc);
    expectFiscalFooter(page, doc);
    expect(hasText(page, "Responsable Monotributo")).toBe(true);
    expect(hasText(page, "DNI: 30111222")).toBe(true);
    expect(hasText(page, "Inicio de actividades")).toBe(false);
    expect(hasText(page, "IVA ")).toBe(false);
    expect(hasText(page, "Régimen de Transparencia Fiscal")).toBe(false);
  });

  it("repeats the issuer box on every sheet and keeps the CAE on the last one", async () => {
    const doc = longDocument();
    const pages = await render(doc);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expectApartadoB(page, doc);
    }
    const last = pages.at(-1) as PdfPage;
    expectFiscalFooter(last, doc);
    expect(hasText(last, `Hoja ${pages.length} de ${pages.length}`)).toBe(true);
    for (const page of pages.slice(0, -1)) {
      expect(hasText(page, "C.A.E.")).toBe(false);
    }
    const lines = pages.flatMap((page) =>
      page.texts.filter((text) => text.text.startsWith("Artículo "))
    );
    expect(lines).toHaveLength(60);
  });

  it("takes its slots, but never in a fiscal zone", async () => {
    const doc = classBDocument();
    const [page] = await readPdf(
      new Uint8Array(
        await renderToBuffer(
          <Voucher
            doc={doc}
            theme={{ accentColor: "#C00000", fontFamily: "Times-Roman" }}
          >
            <VoucherBrand>
              <Text>TELMO</Text>
            </VoucherBrand>
            <VoucherIssuerDetails>
              <Text>Tel. 11 4321-5678</Text>
            </VoucherIssuerDetails>
            <VoucherReceiverDetails>
              <Text>Cliente Nº 1042</Text>
            </VoucherReceiverDetails>
            <VoucherAside>
              <Text>Saldo actual $ 196.773,50</Text>
            </VoucherAside>
            <VoucherNotes>
              <Text>Cambios dentro de los 10 días.</Text>
            </VoucherNotes>
          </Voucher>
        )
      )
    );
    if (page === undefined) {
      throw new Error("no page");
    }
    expectApartadoB(page, doc);
    expectFiscalFooter(page, doc);
    const middle = page.width / 2;
    // Brand and issuer details: in the issuer box, around the issuer's data.
    const brand = find(page, "TELMO");
    expect(brand.x).toBeLessThan(middle);
    expect(brand.top).toBeLessThan(find(page, doc.issuer.legalName).top);
    const issuerDetails = find(page, "Tel. 11 4321-5678");
    expect(issuerDetails.x).toBeLessThan(middle);
    expect(issuerDetails.top).toBeGreaterThan(
      find(page, formatConditionLegend(doc.issuer.conditionLegend)).top
    );
    expect(issuerDetails.top).toBeLessThan(find(page, "Receptor").top);
    // Receiver details: after the receiver's data, in its column.
    const receiverDetails = find(page, "Cliente Nº 1042");
    expect(receiverDetails.x).toBeLessThan(middle);
    expect(receiverDetails.top).toBeGreaterThan(
      find(page, "A Consumidor Final").top
    );
    // Aside: left of the totals, never in their column.
    const aside = find(page, "Saldo actual $ 196.773,50");
    const total = find(page, "Importe total");
    expect(aside.x + 150).toBeLessThan(total.x);
    expect(aside.top).toBeGreaterThan(find(page, "Mechas para metal").top);
    expect(aside.top).toBeLessThan(total.top);
    // Notes: after the receiver, before the lines, as Stripe's memo.
    const notes = find(page, "Cambios dentro de los 10 días.");
    expect(notes.top).toBeGreaterThan(find(page, "A Consumidor Final").top);
    expect(notes.top).toBeLessThan(find(page, "Descripción").top);
  });

  it("keeps the totals with the CAE wherever the sheet breaks", async () => {
    const doc = longDocument();
    // Line counts around the first sheet's edge: the closing block fits, then
    // must move, then the lines themselves overflow.
    for (const count of [20, 22, 24, 26, 28, 30, 32]) {
      const pages = await readPdf(
        await renderVoucherPdf({ ...doc, lines: doc.lines.slice(0, count) })
      );
      const last = pages.at(-1) as PdfPage;
      expect(hasText(last, "Importe total"), `${count} lines`).toBe(true);
      expectFiscalFooter(last, doc);
      for (const page of pages.slice(0, -1)) {
        expect(hasText(page, "C.A.E."), `${count} lines`).toBe(false);
      }
    }
  });

  it("lets long notes break across sheets, all of them, clear of the CAE", async () => {
    const doc = classBDocument();
    const clauses = Array.from(
      { length: 70 },
      (_, index) => `Cláusula ${index + 1}: condiciones generales de venta.`
    );
    const pages = await readPdf(
      await renderVoucherPdf(doc, { notes: clauses.join("\n") })
    );
    expect(pages.length).toBeGreaterThan(1);
    const printed = pages.flatMap((page) =>
      page.texts.filter((text) => text.text.startsWith("Cláusula "))
    );
    expect(printed).toHaveLength(70);
    const last = pages.at(-1) as PdfPage;
    expectFiscalFooter(last, doc);
    for (const text of last.texts.filter((t) =>
      t.text.startsWith("Cláusula ")
    )) {
      expect(text.top).toBeLessThan(find(last, "Importe total").top);
    }
  });

  it("breaks a token wider than the description column", async () => {
    const doc = classBDocument();
    const token = `https://example.com/${"x".repeat(78)}`;
    const [page] = await render({
      ...doc,
      lines: doc.lines.map((line, index) =>
        index === 0 ? { ...line, description: token } : line
      ),
    });
    const runs = (page as PdfPage).texts.filter((text) =>
      text.text.includes("xxxx")
    );
    expect(new Set(runs.map((run) => run.top)).size).toBeGreaterThan(1);
  });

  it("wraps a long tax name instead of running it into its amount", async () => {
    const doc = classADocument();
    const name = "Percepción de Ingresos Brutos Provincia de Buenos Aires";
    const [page] = await render({
      ...doc,
      totals: {
        ...doc.totals,
        otherTaxes: doc.totals.otherTaxes.map((tax) => ({
          ...tax,
          description: name,
        })),
      },
    });
    // The name breaks before it reaches the amount's column: its first line
    // does not hold the whole name.
    const first = find(page as PdfPage, "Percepción de Ingresos");
    expect(first.text).not.toContain("Aires");
    expect(first.top).toBe(find(page as PdfPage, "$ 3,00").top);
    expect(hasText(page as PdfPage, "Aires")).toBe(true);
  });

  it("lets a long tax breakdown continue, with the total kept by the CAE", async () => {
    const doc = classADocument();
    const [tax] = doc.totals.otherTaxes;
    if (tax === undefined) {
      throw new Error("no tax");
    }
    const otherTaxes = Array.from({ length: 15 }, (_, index) => ({
      ...tax,
      id: 100 + index,
      description: `Percepción de Ingresos Brutos Provincia de Buenos Aires Impuesto y contribución municipal por servicios generales ${index + 1}`,
    }));
    const pages = await readPdf(
      await renderVoucherPdf({ ...doc, totals: { ...doc.totals, otherTaxes } })
    );
    expect(pages.length).toBeGreaterThan(1);
    const names = pages.flatMap((page) =>
      page.texts.filter((text) =>
        text.text.startsWith("Percepción de Ingresos")
      )
    );
    expect(names).toHaveLength(15);
    // No sheet squeezes its lines: react-pdf compresses an unbreakable block
    // that outgrows the sheet, down to about 3.6 pt between baselines.
    for (const page of pages) {
      const tops = [
        ...new Set(
          page.texts
            .filter((text) => text.x > page.width / 2)
            .map((text) => Math.round(text.top * 10) / 10)
        ),
      ].sort((a, b) => a - b);
      const gaps = tops.slice(1).map((top, index) => top - (tops[index] ?? 0));
      expect(Math.min(...gaps)).toBeGreaterThan(8);
    }
    const last = pages.at(-1) as PdfPage;
    expect(hasText(last, "Importe total")).toBe(true);
    expectFiscalFooter(last, doc);
  });

  it("keeps a short aside with the total when the tax breakdown breaks", async () => {
    const doc = classADocument();
    const [tax] = doc.totals.otherTaxes;
    if (tax === undefined) {
      throw new Error("no tax");
    }
    const otherTaxes = Array.from({ length: 15 }, (_, index) => ({
      ...tax,
      id: 100 + index,
      description: `Percepción de Ingresos Brutos Provincia de Buenos Aires Impuesto y contribución municipal por servicios generales ${index + 1}`,
    }));
    const pages = await readPdf(
      await renderVoucherPdf(
        <Voucher doc={{ ...doc, totals: { ...doc.totals, otherTaxes } }}>
          <VoucherAside>
            <Text>Pagado: $ 100,00</Text>
            <Text>Saldo actual: $ 68,20</Text>
          </VoucherAside>
        </Voucher>
      )
    );
    expect(pages.length).toBeGreaterThan(1);
    const last = pages.at(-1) as PdfPage;
    expect(hasText(last, "Importe total")).toBe(true);
    expect(hasText(last, "Pagado: $ 100,00")).toBe(true);
    expect(hasText(last, "Saldo actual: $ 68,20")).toBe(true);
    expectFiscalFooter(last, doc);
    const aside = find(last, "Pagado: $ 100,00");
    const total = find(last, "Importe total");
    expect(aside.x).toBeLessThan(total.x);
    expect(Math.abs(aside.top - total.top)).toBeLessThan(15);
  });

  it("lets a row taller than a sheet continue on the next one", async () => {
    const doc = classADocument();
    const paragraph = `${"texto de la descripción ".repeat(30)}\n`;
    const description = `${paragraph.repeat(6)}FIN DE LA DESCRIPCIÓN`;
    const pages = await readPdf(
      await renderVoucherPdf({
        ...doc,
        lines: doc.lines.map((line, index) =>
          index === 0 ? { ...line, description } : line
        ),
      })
    );
    expect(pages.some((page) => hasText(page, "FIN DE LA DESCRIPCIÓN"))).toBe(
      true
    );
  });

  describe("refuses a wrong composition", () => {
    it("before rendering, through renderVoucherPdf()", async () => {
      await expect(
        renderVoucherPdf(
          <Voucher doc={classBDocument()}>
            <Text>C.A.E. N° 00000000000000</Text>
          </Voucher>
        )
      ).rejects.toThrow("only takes <VoucherBrand>, <VoucherIssuerDetails>");
      await expect(
        renderVoucherPdf(
          <Voucher doc={classBDocument()}>
            <VoucherNotes>
              <Text>Uno</Text>
            </VoucherNotes>
            <VoucherNotes>
              <Text>Dos</Text>
            </VoucherNotes>
          </Voucher>
        )
      ).rejects.toThrow("takes one <VoucherNotes>");
      await expect(
        renderVoucherPdf(
          <VoucherBrand>
            <Text>TELMO</Text>
          </VoucherBrand>
        )
      ).rejects.toThrow("renders a <Voucher> element");
    });
  });
});
