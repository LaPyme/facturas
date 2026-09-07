import type { ArcaEnvironment } from "../internal/types";
import type { CliPainter } from "./output";

/**
 * ARCA page, menu, field and button names, in one table so a rename is one
 * edit here and one in `docs/cli.md`. Verified against the official references
 * linked from `docs/habilitacion-arca.md`: the WSASS user manual
 * (`ws/WSASS/html/`), `WSASS_como_adherirse.pdf`, `WSAA.ObtenerCertificado.pdf`
 * and `ADMINREL.DelegarWS.pdf`.
 */
export const ARCA_PAGES = {
  login: "https://auth.afip.gob.ar/contribuyente_/login.xhtml",
  wsassService: "WSASS - Autogestión Certificados Homologación",
  wsassNewCertificate: "Nuevo Certificado",
  wsassNewCertificateButton: "Crear DN y Obtener Certificado",
  wsassAuthorizeService: "Crear autorización a servicio",
  wsassAuthorizeButton: "Crear Autorización de Acceso",
  wsassDnField: "Nombre simbólico del DN",
  wsassCsrField: "Solicitud de certificado",
  wsassAuthorizeDnField: "Nombre simbólico del DN a autorizar",
  wsassRepresentedField: "CUIT representado",
  wsassServiceField: "Servicio al que desea acceder",
  wsfeService: "wsfe - Facturación Electrónica",
  certificates: "Administración de Certificados Digitales",
  certificatesAddAlias: "Agregar alias",
  relationships: "Administrador de Relaciones",
  relationshipsNew: "Nueva Relación",
  relationshipsAdhere: "Adherir Servicio",
  relationshipsPath: "Nueva Relación → Webservices → Facturación Electrónica",
  salesPoints: "Administración de Puntos de Venta y Domicilios",
  salesPointsSystem: "RECE para aplicativo y Web Services",
  salesPointsSystemMonotributo:
    "Factura Electrónica – Monotributo – Web Services",
} as const;

/** One printed line of the plan. Every one of them is an instruction. */
export type ArcaPlanLine = { text: string };

/** The whole block `init` prints after the files: a heading and its steps. */
export type ArcaPlan = { heading: string; lines: ArcaPlanLine[] };

/** What the plan needs from the run: the alias and the file names in play. */
export type ArcaPlanContext = {
  alias: string;
  taxId: string;
  csrName: string;
  certificateName: string;
  /** True when the CSR is already in the clipboard and step 3 is one paste. */
  clipboard: boolean;
  /** The CSR itself, printed in step 3 when there is no clipboard. */
  csrPem: string;
  /** True when the CLI is about to ask for the certificate right below. */
  paste: boolean;
};

const STEP_INDENT = "  ";
/** Where a wrapped step line starts: under the step text, not under its number. */
const WRAP_INDENT = "     ";
const FIELD_INDENT = "       ";
/** Spaces between the widest label of a step and its value column. */
const COLUMN_GAP = 3;

/** One `label   value` row, plus the block that hangs under it, if any. */
type Field = { label: string; value: string; lines?: string[] };

/**
 * The ARCA steps for one environment, as a single linear list. `init` already
 * knows the environment, so the other one is noise: nothing here mentions it.
 */
export function buildArcaPlan(
  environment: ArcaEnvironment,
  context: ArcaPlanContext,
  painter: CliPainter
): ArcaPlan {
  return environment === "test"
    ? buildTestPlan(context, painter)
    : buildProductionPlan(context, painter);
}

function buildTestPlan(
  context: ArcaPlanContext,
  painter: CliPainter
): ArcaPlan {
  const name = (text: string) => painter.bold(`"${text}"`);
  return {
    heading: "Listo. Ahora en ARCA, para homologación:",
    lines: [
      ...step(1, ["Entrá con clave fiscal en", ARCA_PAGES.login]),
      ...step(2, [
        `Abrí ${name(ARCA_PAGES.wsassService)} en Mis Servicios.`,
        `Si no está, agregalo en ${ARCA_PAGES.relationships} → ${ARCA_PAGES.relationshipsAdhere}`,
        "→ ARCA → Servicios Interactivos → WSASS, y volvé a entrar. Va con tu",
        "clave fiscal de persona física, nivel 2 o superior: no es delegable.",
      ]),
      ...step(
        3,
        [`En el menú, ${name(ARCA_PAGES.wsassNewCertificate)}:`],
        [
          { label: ARCA_PAGES.wsassDnField, value: context.alias },
          csrField(context),
        ],
        [`Apretá ${name(ARCA_PAGES.wsassNewCertificateButton)}.`]
      ),
      ...step(4, [
        "El certificado sale en el cuadro de resultado, de",
        "-----BEGIN CERTIFICATE----- a -----END CERTIFICATE-----.",
        context.paste
          ? "Copialo entero y pegalo acá abajo."
          : `Copialo entero y guardalo acá como ${context.certificateName}.`,
      ]),
      ...step(
        5,
        [`En el menú, ${name(ARCA_PAGES.wsassAuthorizeService)}:`],
        [
          { label: ARCA_PAGES.wsassAuthorizeDnField, value: context.alias },
          { label: ARCA_PAGES.wsassRepresentedField, value: context.taxId },
          {
            label: ARCA_PAGES.wsassServiceField,
            value: ARCA_PAGES.wsfeService,
          },
        ],
        [`Apretá ${name(ARCA_PAGES.wsassAuthorizeButton)}.`]
      ),
    ],
  };
}

function buildProductionPlan(
  context: ArcaPlanContext,
  painter: CliPainter
): ArcaPlan {
  const name = (text: string) => painter.bold(`"${text}"`);
  return {
    heading: "Listo. Ahora en ARCA, para producción:",
    lines: [
      ...step(1, ["Entrá con clave fiscal en", ARCA_PAGES.login]),
      ...step(2, [
        `Abrí ${name(ARCA_PAGES.certificates)} en Mis Servicios.`,
        `Si no está, agregalo en ${ARCA_PAGES.relationships} → ${ARCA_PAGES.relationshipsNew}`,
        "→ BUSCAR → Servicios Interactivos → Administración de Certificados",
        "Digitales → Confirmar, y volvé a entrar.",
      ]),
      ...step(
        3,
        [`Apretá ${name(ARCA_PAGES.certificatesAddAlias)}:`],
        [
          { label: "Alias", value: context.alias },
          { label: "Seleccionar archivo", value: context.csrName },
        ],
        [`Apretá ${name(ARCA_PAGES.certificatesAddAlias)} para subirlo.`]
      ),
      ...step(4, [
        `En la lista, entrá con ${name("Ver")} y usá el icono ${name("Descargar")}`,
        "para bajar el certificado (archivo CRT).",
        context.paste
          ? `Guardalo acá como ${context.certificateName}, o abrilo y pegalo abajo.`
          : `Guardalo acá como ${context.certificateName}.`,
      ]),
      ...step(
        5,
        [
          `Volvé a ${ARCA_PAGES.relationships}, ${name(ARCA_PAGES.relationshipsNew)}:`,
        ],
        [
          {
            label: "Servicio",
            value: "BUSCAR → Webservices → Facturación Electrónica",
          },
          {
            label: "Representante",
            value: `BUSCAR → el computador fiscal ${context.alias}`,
          },
        ],
        [
          `Apretá ${name("Confirmar")}, revisá y volvé a apretar ${name("Confirmar")}.`,
        ]
      ),
    ],
  };
}

/**
 * One numbered step: its text, an optional aligned `label   value` block and
 * the lines that come after it.
 */
function step(
  number: number,
  text: string[],
  fields: Field[] = [],
  after: string[] = []
): ArcaPlanLine[] {
  const [first, ...rest] = text;
  const lines: ArcaPlanLine[] = [{ text: `${STEP_INDENT}${number}. ${first}` }];
  for (const line of rest) {
    lines.push({ text: `${WRAP_INDENT}${line}` });
  }
  const width = columnWidth(fields);
  for (const field of fields) {
    const padding = " ".repeat(width - field.label.length);
    lines.push({
      text: `${FIELD_INDENT}${field.label}:${padding}${field.value}`,
    });
    for (const line of field.lines ?? []) {
      lines.push({ text: `${FIELD_INDENT}${line}` });
    }
  }
  for (const line of after) {
    lines.push({ text: `${WRAP_INDENT}${line}` });
  }
  return lines;
}

/**
 * The CSR row of step 3. With the clipboard it is one word; without it the
 * whole request goes under the field, because a terminal is the only place
 * the user can copy it from without opening an editor.
 */
function csrField(context: ArcaPlanContext): Field {
  if (context.clipboard) {
    return {
      label: ARCA_PAGES.wsassCsrField,
      value: "pegá (ya está en tu portapapeles)",
    };
  }
  return {
    label: ARCA_PAGES.wsassCsrField,
    value: "copiá esto entero:",
    lines: context.csrPem
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  };
}

/** Where the values start, counting the colon the labels get when printed. */
function columnWidth(fields: Field[]): number {
  const widest = fields.reduce(
    (longest, field) => Math.max(longest, field.label.length),
    0
  );
  return widest + COLUMN_GAP;
}
