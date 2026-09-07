import { createPainter } from "./output";
import { readCliVersion } from "./version";

/** One help page: the root one, or one per command. */
export type CliHelpTopic = "root" | "init" | "check" | "issue";

type HelpRow = { name: string; description?: string };

type HelpSection = {
  title: string;
  rows: HelpRow[];
  /** Names in bold. Only the command list uses it; flags stay plain. */
  bold?: boolean;
};

type HelpPage = {
  /** One line saying what the command does. The root page has none. */
  summary?: string;
  usage: string;
  sections: HelpSection[];
  examples: string[];
  /** What the command writes, caches or touches. Short, never a paragraph. */
  notes?: string[];
};

const INDENT = "  ";
/** Spaces between the widest name of a section and its description column. */
const COLUMN_GAP = 3;

/** What each command does, in the words the root page and the docs use. */
export const CLI_COMMAND_SUMMARIES = {
  init: "clave privada y CSR, más los pasos exactos en ARCA",
  check: "prueba cada capa en orden y nombra la que falla",
  issue: "una factura de ARS 1 en homologación, solo a pedido",
} as const;

const HELP_PAGES: Record<CliHelpTopic, HelpPage> = {
  root: {
    usage: "npx facturas <comando> [opciones]",
    sections: [
      {
        title: "Comandos:",
        bold: true,
        rows: [
          { name: "init", description: CLI_COMMAND_SUMMARIES.init },
          { name: "check", description: CLI_COMMAND_SUMMARIES.check },
          { name: "issue", description: CLI_COMMAND_SUMMARIES.issue },
        ],
      },
      {
        title: "Opciones globales:",
        rows: [
          { name: "--json", description: "salida JSON (check e issue)" },
          { name: "--no-color", description: "sin colores" },
          {
            name: "-h, --help",
            description: "ayuda de un comando: npx facturas check --help",
          },
          { name: "-v, --version" },
        ],
      },
    ],
    examples: [
      "npx facturas init --cuit 20123456786 --env test",
      "npx facturas check",
      "npx facturas issue --sales-point 3 --issuer monotributo",
    ],
  },
  init: {
    summary: CLI_COMMAND_SUMMARIES.init,
    usage: "npx facturas init [opciones]",
    sections: [
      {
        title: "Opciones:",
        rows: [
          {
            name: "--cuit <cuit>",
            description: "CUIT de 11 dígitos, con o sin guiones",
          },
          {
            name: "--env <test|production>",
            description: "entorno de destino",
          },
          {
            name: "--name <alias>",
            description: "common name del CSR (por defecto: facturas)",
          },
          {
            name: "--org <razón social>",
            description: "organización del CSR (por defecto: el CUIT)",
          },
          {
            name: "--dir <directorio>",
            description: "dónde escribir los archivos (por defecto: el actual)",
          },
          {
            name: "--force",
            description: "sobrescribe los archivos existentes",
          },
          { name: "--no-color", description: "sin colores" },
          { name: "-h, --help", description: "esta ayuda" },
        ],
      },
    ],
    examples: [
      "npx facturas init --cuit 20123456786 --env test",
      "npx facturas init --cuit 20-12345678-6 --env production --name mi-sistema",
    ],
    notes: [
      "Escribe arca-<entorno>.key con permisos 0600 y arca-<entorno>.csr, y",
      "nunca escribe en ARCA. Guardá el certificado que te dé ARCA en el mismo",
      "directorio, como arca-<entorno>.crt, y check lo encuentra solo. En una",
      "terminal pregunta el CUIT y el entorno; sin terminal, --cuit y --env",
      "son obligatorios.",
    ],
  },
  check: {
    summary: CLI_COMMAND_SUMMARIES.check,
    usage: "npx facturas check [opciones]",
    sections: [
      {
        title: "Opciones:",
        rows: [
          {
            name: "--cert <archivo>",
            description: "certificado PEM desde un archivo",
          },
          {
            name: "--key <archivo>",
            description: "clave privada PEM desde un archivo",
          },
          {
            name: "--tax-id <cuit>",
            description: "CUIT, en lugar de ARCA_TAX_ID",
          },
          {
            name: "--env <test|production>",
            description: "entorno, en lugar de ARCA_ENVIRONMENT",
          },
          {
            name: "--dir <directorio>",
            description: "dónde buscar los archivos (por defecto: el actual)",
          },
          {
            name: "--sales-point <n>",
            description: "punto de venta a verificar",
          },
          {
            name: "--no-cache",
            description: "no reusa ni guarda el ticket WSAA",
          },
          { name: "--json", description: "salida JSON" },
          { name: "--no-color", description: "sin colores" },
          { name: "-h, --help", description: "esta ayuda" },
        ],
      },
    ],
    examples: [
      "npx facturas check",
      "npx facturas check --sales-point 3",
      "npx facturas check --cert arca-test.crt --key arca-test.key",
    ],
    notes: [
      "Busca cada valor en este orden: los flags, las variables de entorno y,",
      "por último, arca-<entorno>.crt y arca-<entorno>.key en el directorio; de",
      "ahí sale también el CUIT y el entorno. Nunca escribe en ARCA: solo lee.",
      "Guarda el ticket WSAA en el directorio temporal del sistema para poder",
      "repetirse, porque ARCA rechaza un segundo login mientras hay uno",
      "vigente; --no-cache no lo lee ni lo escribe.",
    ],
  },
  issue: {
    summary: CLI_COMMAND_SUMMARIES.issue,
    usage: "npx facturas issue [opciones]",
    sections: [
      {
        title: "Opciones:",
        rows: [
          { name: "--sales-point <n>", description: "punto de venta a usar" },
          { name: "--issuer <condición>", description: "condición del emisor" },
          {
            name: "--cert <archivo>",
            description: "certificado PEM desde un archivo",
          },
          {
            name: "--key <archivo>",
            description: "clave privada PEM desde un archivo",
          },
          {
            name: "--tax-id <cuit>",
            description: "CUIT, en lugar de ARCA_TAX_ID",
          },
          {
            name: "--env <test|production>",
            description: "entorno, en lugar de ARCA_ENVIRONMENT",
          },
          {
            name: "--dir <directorio>",
            description: "dónde buscar los archivos (por defecto: el actual)",
          },
          {
            name: "--no-cache",
            description: "no reusa ni guarda el ticket WSAA",
          },
          { name: "--json", description: "salida JSON" },
          { name: "--no-color", description: "sin colores" },
          { name: "-h, --help", description: "esta ayuda" },
        ],
      },
    ],
    examples: [
      "npx facturas issue --sales-point 3 --issuer monotributo",
      "npx facturas issue --sales-point 3 --issuer responsable_inscripto --json",
    ],
    notes: [
      "Las condiciones de emisor son monotributo, responsable_inscripto,",
      "exento y no_alcanzado. Emite un comprobante real de homologación y se",
      "niega fuera de test: corre antes las capas de check, con la misma",
      "búsqueda de configuración, y no sigue si alguna falla. En una terminal",
      "pregunta el punto de venta y el emisor.",
    ],
  },
};

/**
 * Renders one help page. Pure: the same text with and without ANSI, so
 * `--no-color` output is the colored one minus the escapes.
 */
export function renderHelp(
  topic: CliHelpTopic,
  options: { color: boolean }
): string {
  const painter = createPainter(options.color);
  const page = HELP_PAGES[topic];
  const lines = [`facturas ${readCliVersion()}`, ""];

  if (page.summary !== undefined) {
    lines.push(`${INDENT}${page.summary}`, "");
  }
  lines.push(`${INDENT}${page.usage}`, "");

  for (const section of page.sections) {
    lines.push(painter.dim(section.title), "");
    const width = columnWidth(section.rows);
    for (const row of section.rows) {
      const name = section.bold === true ? painter.bold(row.name) : row.name;
      lines.push(
        row.description === undefined
          ? `${INDENT}${name}`
          : `${INDENT}${name}${" ".repeat(width - row.name.length)}${row.description}`
      );
    }
    lines.push("");
  }

  lines.push(painter.dim("Ejemplos:"), "");
  for (const example of page.examples) {
    lines.push(`${INDENT}${painter.dim("$")} ${painter.cyan(example)}`);
  }

  if (page.notes !== undefined) {
    lines.push("", painter.dim("Notas:"), "");
    for (const note of page.notes) {
      lines.push(`${INDENT}${note}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

/** Where the descriptions start. Rows without one never widen the column. */
function columnWidth(rows: HelpRow[]): number {
  const widest = rows
    .filter((row) => row.description !== undefined)
    .reduce((longest, row) => Math.max(longest, row.name.length), 0);
  return widest + COLUMN_GAP;
}
