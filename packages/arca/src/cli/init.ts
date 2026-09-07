import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { ARCA_ENVIRONMENTS } from "../config";
import type { ArcaEnvironment } from "../internal/types";
import { buildArcaPlan } from "./arca-steps";
import { createArcaCsrMaterial } from "./csr";
import { describeTaxIdProblem, normalizeTaxId } from "./cuit";
import { CLI_EXIT, type CliIo, type CliWriter } from "./output";
import { ask, isInteractive } from "./prompt";

const KEY_FILE_MODE = 0o600;
/** Three tries at the prompt before the CLI gives up and says why. */
const TAX_ID_ATTEMPTS = 3;
const MISSING_TAX_ID =
  "Falta el CUIT. Pasá --cuit 20123456786 o ejecutá init en una terminal.";
const MISSING_ENVIRONMENT =
  "Falta el entorno. Pasá --env test o --env production.";
const GITIGNORE_PATTERNS = ["arca-*.key", "arca-*.crt"] as const;

export type InitFlags = {
  cuit?: string;
  env?: string;
  name?: string;
  dir?: string;
  force?: boolean;
  org?: string;
};

/** Generates the key and the CSR, then prints the exact ARCA steps. */
export async function runInit(
  io: CliIo,
  flags: InitFlags,
  writer: CliWriter
): Promise<number> {
  const resolved = await resolveInitInput(io, flags);
  if (resolved === undefined) {
    return CLI_EXIT.usage;
  }

  const { taxId, environment } = resolved;
  const directory = isAbsolute(flags.dir ?? "")
    ? (flags.dir as string)
    : resolve(io.cwd, flags.dir ?? ".");
  const commonName = flags.name?.trim() || "facturas";
  const alias = `${commonName}-${environment}`;
  const keyName = `arca-${environment}.key`;
  const csrName = `arca-${environment}.csr`;
  const certificateName = `arca-${environment}.crt`;
  const keyPath = resolve(directory, keyName);
  const csrPath = resolve(directory, csrName);

  const existing = [keyPath, csrPath].filter((path) => existsSync(path));
  if (existing.length > 0 && flags.force !== true) {
    io.stderr.write(
      `Ya existe ${existing.map((path) => path).join(" y ")}. Usá --force para sobrescribir.\n`
    );
    return CLI_EXIT.failed;
  }

  const material = createArcaCsrMaterial({
    taxId,
    commonName,
    organization: flags.org?.trim() || taxId,
  });
  mkdirSync(directory, { recursive: true });
  writeFileSync(keyPath, material.privateKeyPem, { mode: KEY_FILE_MODE });
  chmodSync(keyPath, KEY_FILE_MODE);
  writeFileSync(csrPath, material.csrPem);

  writer.ok(keyName, "clave privada RSA 2048, permisos 0600");
  writer.ok(csrName, `CSR para ARCA, CN=${commonName}`);

  const ignored = appendToGitignore(directory);
  if (ignored.length > 0) {
    writer.ok(".gitignore", `agregué ${ignored.join(" y ")}`);
  }

  writePlan(writer, {
    alias,
    certificateName,
    csrName,
    environment,
    taxId,
  });
  return CLI_EXIT.ok;
}

async function resolveInitInput(
  io: CliIo,
  flags: InitFlags
): Promise<{ taxId: string; environment: ArcaEnvironment } | undefined> {
  const interactive = isInteractive(io);
  const taxId = await resolveTaxId(io, flags, interactive);
  if ("error" in taxId) {
    io.stderr.write(`${taxId.error}\n`);
    return undefined;
  }

  const environment = await resolveEnvironment(io, flags, interactive);
  if (environment === undefined) {
    io.stderr.write(`${MISSING_ENVIRONMENT}\n`);
    return undefined;
  }

  return { taxId: taxId.taxId, environment };
}

/**
 * A CUIT that is absent and one that is wrong are different problems, and the
 * message has to say which. On a terminal a wrong answer is worth another try:
 * the reason goes back to the user and the question is asked again.
 */
async function resolveTaxId(
  io: CliIo,
  flags: InitFlags,
  interactive: boolean
): Promise<{ taxId: string } | { error: string }> {
  const fromFlag = flags.cuit?.trim();
  if (fromFlag !== undefined && fromFlag !== "") {
    const problem = describeTaxIdProblem(fromFlag);
    return problem === undefined
      ? { taxId: normalizeTaxId(fromFlag) }
      : { error: problem };
  }
  if (!interactive) {
    return { error: MISSING_TAX_ID };
  }

  let problem = MISSING_TAX_ID;
  for (let attempt = 1; attempt <= TAX_ID_ATTEMPTS; attempt += 1) {
    const answer = await ask(io, "CUIT: ");
    if (answer === "") {
      problem = MISSING_TAX_ID;
    } else {
      const invalid = describeTaxIdProblem(answer);
      if (invalid === undefined) {
        return { taxId: normalizeTaxId(answer) };
      }
      problem = invalid;
    }
    if (attempt < TAX_ID_ATTEMPTS) {
      io.stderr.write(`${problem}\n`);
    }
  }
  return { error: problem };
}

async function resolveEnvironment(
  io: CliIo,
  flags: InitFlags,
  interactive: boolean
): Promise<ArcaEnvironment | undefined> {
  const fromFlag = flags.env?.trim().toLowerCase();
  if (fromFlag !== undefined && fromFlag !== "") {
    return toEnvironment(fromFlag);
  }
  if (!interactive) {
    return undefined;
  }
  const answer = await ask(io, "Entorno [test/production]: ");
  return toEnvironment(answer.trim().toLowerCase());
}

function toEnvironment(value: string): ArcaEnvironment | undefined {
  return ARCA_ENVIRONMENTS.includes(value as ArcaEnvironment)
    ? (value as ArcaEnvironment)
    : undefined;
}

/** Appends the credential patterns to an existing `.gitignore`. Idempotent. */
function appendToGitignore(directory: string): string[] {
  const path = resolve(directory, ".gitignore");
  if (!existsSync(path)) {
    return [];
  }

  const current = readFileSync(path, "utf8");
  const lines = new Set(current.split("\n").map((line) => line.trim()));
  const missing = GITIGNORE_PATTERNS.filter((pattern) => !lines.has(pattern));
  if (missing.length === 0) {
    return [];
  }

  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  writeFileSync(path, `${current}${prefix}${missing.join("\n")}\n`);
  return [...missing];
}

function writePlan(
  writer: CliWriter,
  context: {
    environment: ArcaEnvironment;
    alias: string;
    taxId: string;
    csrName: string;
    certificateName: string;
  }
): void {
  const plan = buildArcaPlan(context.environment, context, writer.painter);
  writer.blank();
  writer.line(plan.heading);
  writer.blank();
  for (const line of plan.lines) {
    if (line.dim === true) {
      writer.dim(line.text);
    } else {
      writer.line(line.text);
    }
  }
  writer.blank();
  writer.dim("Después:");
  writer.blank();
  writer.command("npx facturas check");
  writer.blank();
  writer.dim("Para tu app las variables son ARCA_TAX_ID, ARCA_ENVIRONMENT,");
  writer.dim(
    "ARCA_CERTIFICATE_PEM y ARCA_PRIVATE_KEY_PEM; ver docs/inicio-rapido.md."
  );
}
