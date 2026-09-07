import { describe, expect, it } from "vitest";
import packageJson from "../../package.json" with { type: "json" };
import { type CliHelpTopic, renderHelp } from "./help";

const TOPICS: CliHelpTopic[] = ["root", "init", "check", "issue"];

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI is what it matches
const ANSI = /\u001B\[\d+m/g;
const MAX_COLUMNS = 80;

/** The version moves every release; the layout is what the snapshot is for. */
function page(topic: CliHelpTopic, color = false): string {
  return renderHelp(topic, { color }).replaceAll(
    packageJson.version,
    "<versión>"
  );
}

describe("renderHelp without color", () => {
  it("renders the root page", () => {
    expect(page("root")).toMatchInlineSnapshot(`
      "facturas <versión>

        npx facturas <comando> [opciones]

      Comandos:

        init    clave privada y CSR, más los pasos exactos en ARCA
        check   prueba cada capa en orden y nombra la que falla
        issue   una factura de ARS 1 en homologación, solo a pedido

      Opciones globales:

        --json       salida JSON (check e issue)
        --no-color   sin colores
        -h, --help   ayuda de un comando: npx facturas check --help
        -v, --version

      Ejemplos:

        $ npx facturas init --cuit 20123456786 --env test
        $ npx facturas check
        $ npx facturas issue --sales-point 3 --issuer monotributo
      "
    `);
  });

  it("renders init", () => {
    expect(page("init")).toMatchInlineSnapshot(`
      "facturas <versión>

        clave privada y CSR, más los pasos exactos en ARCA

        npx facturas init [opciones]

      Opciones:

        --cuit <cuit>             CUIT de 11 dígitos, con o sin guiones
        --env <test|production>   entorno de destino
        --name <alias>            common name del CSR (por defecto: facturas)
        --org <razón social>      organización del CSR (por defecto: el CUIT)
        --dir <directorio>        dónde escribir los archivos (por defecto: el actual)
        --force                   sobrescribe los archivos existentes
        --no-color                sin colores
        -h, --help                esta ayuda

      Ejemplos:

        $ npx facturas init --cuit 20123456786 --env test
        $ npx facturas init --cuit 20-12345678-6 --env production --name mi-sistema

      Notas:

        Escribe arca-<entorno>.key con permisos 0600 y arca-<entorno>.csr, y
        nunca escribe en ARCA. Guardá el certificado que te dé ARCA en el mismo
        directorio, como arca-<entorno>.crt, y check lo encuentra solo. En una
        terminal pregunta el CUIT y el entorno; sin terminal, --cuit y --env
        son obligatorios.
      "
    `);
  });

  it("renders check", () => {
    expect(page("check")).toMatchInlineSnapshot(`
      "facturas <versión>

        prueba cada capa en orden y nombra la que falla

        npx facturas check [opciones]

      Opciones:

        --cert <archivo>          certificado PEM desde un archivo
        --key <archivo>           clave privada PEM desde un archivo
        --tax-id <cuit>           CUIT, en lugar de ARCA_TAX_ID
        --env <test|production>   entorno, en lugar de ARCA_ENVIRONMENT
        --dir <directorio>        dónde buscar los archivos (por defecto: el actual)
        --sales-point <n>         punto de venta a verificar
        --no-cache                no reusa ni guarda el ticket WSAA
        --json                    salida JSON
        --no-color                sin colores
        -h, --help                esta ayuda

      Ejemplos:

        $ npx facturas check
        $ npx facturas check --sales-point 3
        $ npx facturas check --cert arca-test.crt --key arca-test.key

      Notas:

        Busca cada valor en este orden: los flags, las variables de entorno y,
        por último, arca-<entorno>.crt y arca-<entorno>.key en el directorio; de
        ahí sale también el CUIT y el entorno. Nunca escribe en ARCA: solo lee.
        Guarda el ticket WSAA en el directorio temporal del sistema para poder
        repetirse, porque ARCA rechaza un segundo login mientras hay uno
        vigente; --no-cache no lo lee ni lo escribe.
      "
    `);
  });

  it("renders issue", () => {
    expect(page("issue")).toMatchInlineSnapshot(`
      "facturas <versión>

        una factura de ARS 1 en homologación, solo a pedido

        npx facturas issue [opciones]

      Opciones:

        --sales-point <n>         punto de venta a usar
        --issuer <condición>      condición del emisor
        --cert <archivo>          certificado PEM desde un archivo
        --key <archivo>           clave privada PEM desde un archivo
        --tax-id <cuit>           CUIT, en lugar de ARCA_TAX_ID
        --env <test|production>   entorno, en lugar de ARCA_ENVIRONMENT
        --dir <directorio>        dónde buscar los archivos (por defecto: el actual)
        --no-cache                no reusa ni guarda el ticket WSAA
        --json                    salida JSON
        --no-color                sin colores
        -h, --help                esta ayuda

      Ejemplos:

        $ npx facturas issue --sales-point 3 --issuer monotributo
        $ npx facturas issue --sales-point 3 --issuer responsable_inscripto --json

      Notas:

        Las condiciones de emisor son monotributo, responsable_inscripto,
        exento y no_alcanzado. Emite un comprobante real de homologación y se
        niega fuera de test: corre antes las capas de check, con la misma
        búsqueda de configuración, y no sigue si alguna falla. En una terminal
        pregunta el punto de venta y el emisor.
      "
    `);
  });
});

describe("renderHelp with color", () => {
  it("paints the headers dim, the commands bold and the examples cyan", () => {
    const painted = page("root", true);

    expect(painted).toContain("\u001B[2mComandos:\u001B[0m");
    expect(painted).toContain("\u001B[2mOpciones globales:\u001B[0m");
    expect(painted).toContain("\u001B[2mEjemplos:\u001B[0m");
    expect(painted).toContain("\u001B[1minit\u001B[0m");
    expect(painted).toContain(
      "\u001B[2m$\u001B[0m \u001B[36mnpx facturas check\u001B[0m"
    );
  });

  it("is the same text as the plain page, minus the escapes", () => {
    for (const topic of TOPICS) {
      expect(page(topic, true).replace(ANSI, "")).toBe(page(topic));
    }
  });

  it("keeps the description column aligned under the escapes", () => {
    const line = page("root", true)
      .split("\n")
      .find((candidate) => candidate.includes("prueba cada capa"));

    expect(line).toBe(
      "  \u001B[1mcheck\u001B[0m   prueba cada capa en orden y nombra la que falla"
    );
  });
});

describe("every page", () => {
  it("names the version, the usage and at least two examples", () => {
    for (const topic of TOPICS) {
      const text = page(topic);

      expect(text.startsWith("facturas <versión>\n\n")).toBe(true);
      expect(text).toContain("  npx facturas ");
      expect(
        text.split("\n").filter((line) => line.startsWith("  $ ")).length
      ).toBeGreaterThanOrEqual(2);
      expect(text.endsWith("\n")).toBe(true);
    }
  });

  it("stays inside eighty columns", () => {
    for (const topic of TOPICS) {
      for (const line of page(topic).split("\n")) {
        expect(line.length).toBeLessThanOrEqual(MAX_COLUMNS);
      }
    }
  });

  it("speaks only castellano", () => {
    for (const topic of TOPICS) {
      expect(page(topic)).not.toMatch(/Usage|Options|Commands|Examples/);
    }
  });
});
