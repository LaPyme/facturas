import type { IssuedVoucher, IssueOutcome } from "../services/vouchers-types";
import type { IssueInput } from "../services/wsfe-derive";
import {
  type CheckFlags,
  type CliCheckReport,
  parseSalesPoint,
  resolveCheckEnvironment,
  runCheckLayers,
  writeCheckReport,
} from "./check";
import { describeUnknownError } from "./diagnose";
import { CLI_EXIT, type CliIo, type CliWriter } from "./output";
import { ask, isInteractive } from "./prompt";

/** One peso, in minor units. The smoke test never issues more than this. */
const SMOKE_TEST_MINOR_UNITS = 100;
const SMOKE_TEST_VAT_RATE = 21;
const SALES_POINT_DIGITS = 4;
const VOUCHER_NUMBER_DIGITS = 8;

const ISSUER_CONDITIONS = [
  "monotributo",
  "responsable_inscripto",
  "exento",
  "no_alcanzado",
] as const;

type IssuerCondition = (typeof ISSUER_CONDITIONS)[number];

/**
 * The smoke test always builds an items input, never the reviewed-amounts one,
 * so `items` is present and the printed call can read it without a guard.
 */
type SmokeTestItem = { gross: number; vat: number } | { amount: number };
type SmokeTestInput = IssueInput & { items: readonly SmokeTestItem[] };

export type IssueFlags = CheckFlags & {
  issuer?: string;
};

/** Issues exactly one ARS 1 invoice in homologación. Refuses anywhere else. */
export async function runIssue(
  io: CliIo,
  flags: IssueFlags,
  writer: CliWriter,
  json: boolean
): Promise<number> {
  // Refuse before anything else when the environment is already known to be
  // the wrong one. When nothing says which it is, the check layers run and
  // name the real problem, and the guard below runs again on what they found.
  const environment = resolveCheckEnvironment(io, flags);
  if (environment !== undefined && environment !== "test") {
    return refuse(io);
  }

  const parameters = await resolveIssueInput(io, flags);
  if (parameters === undefined) {
    return CLI_EXIT.usage;
  }

  const { report, client } = await runCheckLayers(io, flags);
  if (!(report.ok && client)) {
    if (json) {
      writer.json(report);
    } else {
      writeCheckReport(writer, report);
    }
    return CLI_EXIT.failed;
  }
  if (report.environment !== "test") {
    return refuse(io);
  }

  const input = buildSmokeTestInput(parameters.issuer, parameters.salesPoint);
  // The layers passed, so ARCA answered a moment ago; it can still fail on the
  // next number or the authorization. That is a diagnosis like any other, not
  // a stack trace, and with --json it still has to be one JSON object.
  let outcome: IssueOutcome;
  try {
    outcome = await client.issue(input);
  } catch (error) {
    return writeIssueError(writer, report, error, json);
  }
  if (json) {
    writer.json(outcome);
    return outcome.kind === "authorized" ? CLI_EXIT.ok : CLI_EXIT.failed;
  }
  return writeOutcome(writer, outcome, input);
}

/** The same safe message and code the check layers print, in both shapes. */
function writeIssueError(
  writer: CliWriter,
  report: CliCheckReport,
  error: unknown,
  json: boolean
): number {
  const unknown = describeUnknownError(error);
  if (json) {
    writer.json({
      ok: false,
      ...(report.environment === undefined
        ? {}
        : { environment: report.environment }),
      ...(report.taxId === undefined ? {} : { taxId: report.taxId }),
      error: {
        ...(unknown.code === undefined ? {} : { code: unknown.code }),
        message: unknown.diagnosis,
      },
    });
    return CLI_EXIT.failed;
  }
  writer.fail("emisión");
  writer.note(unknown.diagnosis);
  writer.note(
    "No sabemos si ARCA llegó a autorizar; consultá el punto de venta antes de repetir."
  );
  return CLI_EXIT.failed;
}

function refuse(io: CliIo): number {
  io.stderr.write(
    "issue solo emite en homologación. Cambiá ARCA_ENVIRONMENT=test.\n"
  );
  return CLI_EXIT.failed;
}

async function resolveIssueInput(
  io: CliIo,
  flags: IssueFlags
): Promise<{ issuer: IssuerCondition; salesPoint: number } | undefined> {
  const interactive = isInteractive(io);
  const salesPoint = await resolveSalesPoint(io, flags, interactive);
  if (salesPoint === undefined) {
    io.stderr.write("Falta el punto de venta. Pasá --sales-point 3.\n");
    return undefined;
  }

  const issuer = await resolveIssuer(io, flags, interactive);
  if (issuer === undefined) {
    io.stderr.write(
      `Falta la condición del emisor. Pasá --issuer ${ISSUER_CONDITIONS.join("|")}.\n`
    );
    return undefined;
  }

  return { issuer, salesPoint };
}

async function resolveSalesPoint(
  io: CliIo,
  flags: IssueFlags,
  interactive: boolean
): Promise<number | undefined> {
  if (flags.salesPoint !== undefined) {
    return flags.salesPoint;
  }
  if (!interactive) {
    return undefined;
  }
  // The same reading as `--sales-point`: a typo is a typo at the prompt too.
  return parseSalesPoint((await ask(io, "Punto de venta: ")).trim());
}

async function resolveIssuer(
  io: CliIo,
  flags: IssueFlags,
  interactive: boolean
): Promise<IssuerCondition | undefined> {
  const fromFlag = flags.issuer?.trim();
  if (fromFlag) {
    return toIssuerCondition(fromFlag);
  }
  if (!interactive) {
    return undefined;
  }
  const answer = await ask(io, `Emisor [${ISSUER_CONDITIONS.join("/")}]: `);
  return toIssuerCondition(answer.trim());
}

function toIssuerCondition(value: string): IssuerCondition | undefined {
  return ISSUER_CONDITIONS.includes(value as IssuerCondition)
    ? (value as IssuerCondition)
    : undefined;
}

/** ARS 1: a VAT item for class B, a plain amount for class C. */
export function buildSmokeTestInput(
  issuer: IssuerCondition,
  salesPoint: number
): SmokeTestInput {
  if (issuer === "responsable_inscripto") {
    return {
      issuer,
      salesPoint,
      to: { condition: "consumidor_final" },
      items: [{ gross: SMOKE_TEST_MINOR_UNITS, vat: SMOKE_TEST_VAT_RATE }],
    };
  }
  return {
    issuer,
    salesPoint,
    to: { condition: "consumidor_final" },
    items: [{ amount: SMOKE_TEST_MINOR_UNITS }],
  };
}

function writeOutcome(
  writer: CliWriter,
  outcome: IssueOutcome,
  input: SmokeTestInput
): number {
  if (outcome.kind === "authorized") {
    writer.ok(describeVoucher(outcome.voucher));
    writeIssueCall(writer, input);
    return CLI_EXIT.ok;
  }

  if (outcome.kind === "rejected") {
    writer.fail(`factura rechazada ${describeCoordinates(outcome.attempted)}`);
    for (const issue of outcome.issues) {
      writer.note(
        issue.code === undefined
          ? issue.message
          : `${issue.code} ${issue.message}`
      );
    }
    return CLI_EXIT.failed;
  }

  if (outcome.kind === "conflict") {
    writer.fail(`conflicto en ${describeCoordinates(outcome.attempted)}`);
    writer.note(outcome.reason);
    writer.note(
      "Hay otro comprobante en ese número; detené el flujo e investigá."
    );
    return CLI_EXIT.failed;
  }

  writer.fail(`indeterminado ${describeCoordinates(outcome.attempted)}`);
  writer.note(`${outcome.attempt.reason}, consulta ${outcome.lookup.kind}`);
  writer.note(
    "Conservá el número y la evidencia; conciliá o repetí el mismo input con su clave."
  );
  return CLI_EXIT.failed;
}

function describeVoucher(voucher: IssuedVoucher): string {
  return [
    `factura ${voucher.voucherClass} ${describeCoordinates(voucher)}`,
    `CAE ${voucher.cae}`,
    `vence ${formatArcaDate(voucher.caeExpiry)}`,
    `ARS ${formatMinorUnits(voucher.amounts.sentTotal)}`,
  ].join("   ");
}

function describeCoordinates(coordinates: {
  salesPoint: number;
  number: number;
}): string {
  return `${String(coordinates.salesPoint).padStart(SALES_POINT_DIGITS, "0")}-${String(
    coordinates.number
  ).padStart(VOUCHER_NUMBER_DIGITS, "0")}`;
}

/** `20260916` as ARCA sends it becomes `2026-09-16`. */
function formatArcaDate(value: string): string {
  return /^\d{8}$/.test(value)
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
    : value;
}

/** Minor units to the castellano form: thousands with `.`, decimals with `,`. */
export function formatMinorUnits(minorUnits: number): string {
  const negative = minorUnits < 0;
  const digits = String(Math.abs(minorUnits)).padStart(3, "0");
  const whole = digits.slice(0, -2);
  const cents = digits.slice(-2);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "-" : ""}${grouped},${cents}`;
}

/** Prints the exact call, so the smoke test doubles as the first snippet. */
function writeIssueCall(writer: CliWriter, input: SmokeTestInput): void {
  writer.blank();
  writer.line("Esta es la llamada que hizo el CLI. Pegala en tu aplicación:");
  writer.blank();
  writer.line("  const factura = await arca.issue({");
  writer.line(`    issuer: "${input.issuer}",`);
  writer.line(`    salesPoint: ${input.salesPoint},`);
  writer.line('    to: { condition: "consumidor_final" },');
  writer.line(`    items: [${input.items.map(formatItem).join(", ")}],`);
  writer.line("  });");
}

function formatItem(item: SmokeTestItem): string {
  const fields = Object.entries(item)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${String(value)}`);
  return `{ ${fields.join(", ")} }`;
}
