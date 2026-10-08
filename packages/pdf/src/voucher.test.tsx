import { renderToBuffer, Text } from "@react-pdf/renderer";
import { MONOTRIBUTO_CREDIT_LEGEND, type VoucherDocument } from "facturas";
import { describe, expect, it } from "vitest";
import {
  classADocument,
  classBDocument,
  classCDocument,
  longDocument,
} from "./fixtures.test-helper";
import {
  find,
  findExact,
  hasText,
  type PdfPage,
  readPdf,
} from "./pdf-reader.test-helper";
import { renderVoucherPdf } from "./render";
import { Voucher, VoucherBrand, VoucherNotes } from "./voucher";

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
    doc.issuer.conditionLegend,
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
    // C15: the receiver legend; L6 and C12: sale conditions and remitos.
    expect(hasText(page, "A CONSUMIDOR FINAL")).toBe(true);
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
      "Razón social: Juan Pérez",
      "CUIT: 20-11111111-2",
      "Domicilio: Calle 1, Rosario",
      "RESPONSABLE MONOTRIBUTO",
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

  it("renders class C without VAT, transparency block or an exempt start of activities", async () => {
    const doc = classCDocument();
    const [page] = await render(doc);
    if (page === undefined) {
      throw new Error("no page");
    }
    expectApartadoB(page, doc);
    expectFiscalFooter(page, doc);
    expect(hasText(page, "RESPONSABLE MONOTRIBUTO")).toBe(true);
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

  it("takes a brand and notes, but never in a fiscal zone", async () => {
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
    const brand = find(page, "TELMO");
    expect(brand.x).toBeLessThan(page.width / 2);
    expect(brand.top).toBeLessThan(find(page, doc.issuer.legalName).top);
    const notes = find(page, "Cambios dentro de los 10 días.");
    expect(notes.top).toBeGreaterThan(find(page, "Importe total").top);
    expect(notes.top).toBeLessThan(find(page, "C.A.E.").top);
  });

  describe("refuses a wrong composition", () => {
    it("before rendering, through renderVoucherPdf()", async () => {
      await expect(
        renderVoucherPdf(
          <Voucher doc={classBDocument()}>
            <Text>C.A.E. N° 00000000000000</Text>
          </Voucher>
        )
      ).rejects.toThrow("only takes <VoucherBrand> and <VoucherNotes>");
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
