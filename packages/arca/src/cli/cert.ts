import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ArcaEnvironment } from "../internal/types";
import {
  type CertificateFacts,
  privateKeyMatchesCertificate,
  readCertificateFacts,
  readCsrTaxId,
} from "./csr";
import {
  certificateFileName,
  DISCOVERY_ORDER,
  privateKeyFileName,
  toEnvironment,
} from "./discover";
import { CLI_EXIT, type CliIo, type CliWriter } from "./output";
import { askBlock, isInteractive } from "./prompt";

/**
 * The certificate ARCA gives back, taken by paste. In homologación there is no
 * download —the PEM only exists in the browser— so the alternative to this is
 * the user opening an editor for a file they do not have yet.
 */

const BEGIN = "-----BEGIN CERTIFICATE-----";
const END = "-----END CERTIFICATE-----";
const PROMPT = "> ";
/** Three pastes before the CLI stops asking and says how to do it by hand. */
const PASTE_ATTEMPTS = 3;
const NOT_A_CERTIFICATE = [
  "Eso no parece un certificado PEM. Tiene que ir de",
  `${BEGIN} a ${END}.`,
];

export type CertFlags = {
  env?: string;
  dir?: string;
  force?: boolean;
};

/** How a paste ended. Only `saved` wrote a file. */
export type PasteOutcome = "saved" | "cancelled" | "exhausted" | "refused";

export type PasteRequest = {
  /** What to say before the first prompt. Empty when there is no terminal. */
  intro: string[];
  certificatePath: string;
  certificateName: string;
  keyName: string;
  privateKeyPem: string;
  /** The CUIT the certificate has to be for, when the CLI knows it. */
  taxId?: string;
};

/**
 * Asks for the certificate, checks it against the key that is already on disk
 * and writes it. Refuses without writing when the certificate belongs to
 * another CUIT or to another key: both mean the paste came from the wrong tab,
 * and a saved file would fail later, in WSAA, with a worse message.
 */
export async function pasteCertificate(
  io: CliIo,
  writer: CliWriter,
  request: PasteRequest
): Promise<PasteOutcome> {
  const interactive = isInteractive(io);
  if (request.intro.length > 0) {
    writer.blank();
    for (const line of request.intro) {
      writer.line(line);
    }
    writer.blank();
  }

  for (let attempt = 1; attempt <= PASTE_ATTEMPTS; attempt += 1) {
    // Sequential by nature: each try is an answer to the previous one.
    const lines = await askBlock(
      io,
      interactive ? PROMPT : "",
      (line) => line === END
    );
    if (lines === undefined) {
      return "cancelled";
    }

    const pem = toCertificatePem(lines);
    const facts = readFacts(pem);
    if (facts === undefined) {
      for (const line of NOT_A_CERTIFICATE) {
        io.stderr.write(`${line}\n`);
      }
      if (interactive && attempt < PASTE_ATTEMPTS) {
        writer.blank();
      }
      continue;
    }

    const refusal = refuse(pem, facts, request);
    if (refusal !== undefined) {
      io.stderr.write(`${refusal}\n`);
      return "refused";
    }

    writeFileSync(request.certificatePath, pem);
    writer.ok(
      request.certificateName,
      `certificado guardado, vence ${isoDate(facts.notAfter)}`
    );
    return "saved";
  }
  return "exhausted";
}

/** The line `init` and `cert` both print when nobody pasted anything. */
export function writeManualHint(
  writer: CliWriter,
  certificateName: string
): void {
  writer.blank();
  writer.line(
    `Cuando tengas el certificado, guardalo acá como ${certificateName},`
  );
  writer.line("o pegalo con npx facturas cert, y corré:");
  writer.blank();
  writer.command("npx facturas check");
}

/** Reads the certificate that pairs with a key already in the directory. */
export async function runCert(
  io: CliIo,
  flags: CertFlags,
  writer: CliWriter
): Promise<number> {
  const directory = isAbsolute(flags.dir ?? "")
    ? (flags.dir as string)
    : resolve(io.cwd, flags.dir ?? ".");

  const asked = flags.env?.trim().toLowerCase();
  const environment =
    asked === undefined || asked === "" ? undefined : toEnvironment(asked);
  if (asked !== undefined && asked !== "" && environment === undefined) {
    io.stderr.write("Falta el entorno. Pasá --env test o --env production.\n");
    return CLI_EXIT.usage;
  }

  const found = findKeys(directory, environment);
  if (found.length > 1) {
    io.stderr.write(
      `Están ${found.map((candidate) => candidate.keyName).join(" y ")} en este directorio\n`
    );
    io.stderr.write(
      "y no sé cuál querés. Elegí con --env test o --env production.\n"
    );
    return CLI_EXIT.failed;
  }

  const [target] = found;
  if (target === undefined) {
    const names = (environment === undefined ? DISCOVERY_ORDER : [environment])
      .map((candidate) => privateKeyFileName(candidate))
      .join(" ni ");
    io.stderr.write(`No encontré ${names} en este directorio.\n`);
    io.stderr.write("Generá la clave y el CSR con npx facturas init.\n");
    return CLI_EXIT.failed;
  }
  const certificatePath = resolve(directory, target.certificateName);
  if (existsSync(certificatePath) && flags.force !== true) {
    io.stderr.write(
      `Ya existe ${target.certificateName}. Usá --force para sobrescribir.\n`
    );
    return CLI_EXIT.failed;
  }

  const taxId = readCsrTaxIdOf(directory, target.environment);
  const outcome = await pasteCertificate(io, writer, {
    intro: isInteractive(io)
      ? [
          "Pegá el certificado que te dio ARCA. Termina solo al ver",
          `${END}. Ctrl-C para salir.`,
        ]
      : [],
    certificatePath,
    certificateName: target.certificateName,
    keyName: target.keyName,
    privateKeyPem: readFileSync(resolve(directory, target.keyName), "utf8"),
    ...(taxId === undefined ? {} : { taxId }),
  });

  if (outcome === "saved") {
    writer.blank();
    writer.dim("Después:");
    writer.blank();
    writer.command("npx facturas check");
    return CLI_EXIT.ok;
  }
  if (outcome === "cancelled") {
    writer.blank();
    writer.line("Cuando lo tengas, volvé a correr npx facturas cert, o");
    writer.line(`guardalo acá como ${target.certificateName}.`);
    return CLI_EXIT.ok;
  }
  if (outcome === "exhausted") {
    writeManualHint(writer, target.certificateName);
  }
  return CLI_EXIT.failed;
}

type KeyCandidate = {
  environment: ArcaEnvironment;
  keyName: string;
  certificateName: string;
};

/** The keys `init` left in the directory, in the order `check` looks for them. */
function findKeys(
  directory: string,
  environment: ArcaEnvironment | undefined
): KeyCandidate[] {
  return (environment === undefined ? DISCOVERY_ORDER : [environment])
    .map((candidate) => ({
      environment: candidate,
      keyName: privateKeyFileName(candidate),
      certificateName: certificateFileName(candidate),
    }))
    .filter((candidate) => existsSync(resolve(directory, candidate.keyName)));
}

/** The CUIT of the CSR next to the key, when it is still there and readable. */
function readCsrTaxIdOf(
  directory: string,
  environment: ArcaEnvironment
): string | undefined {
  const path = resolve(directory, `arca-${environment}.csr`);
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return readCsrTaxId(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** The pasted lines as a PEM file: nothing before BEGIN, one trailing newline. */
function toCertificatePem(lines: string[]): string {
  const start = lines.indexOf(BEGIN);
  const body = start === -1 ? lines : lines.slice(start);
  return `${body.join("\n")}\n`;
}

function readFacts(pem: string): CertificateFacts | undefined {
  try {
    return readCertificateFacts(pem);
  } catch {
    return undefined;
  }
}

/** Why this certificate cannot be saved next to this key, if it cannot. */
function refuse(
  pem: string,
  facts: CertificateFacts,
  request: PasteRequest
): string | undefined {
  if (
    request.taxId !== undefined &&
    facts.taxId !== undefined &&
    facts.taxId !== request.taxId
  ) {
    return `El certificado es de otro CUIT: ${facts.taxId}.`;
  }
  let matches: boolean;
  try {
    matches = privateKeyMatchesCertificate(pem, request.privateKeyPem);
  } catch {
    return `No pude leer ${request.keyName} como clave PEM.`;
  }
  return matches
    ? undefined
    : `El certificado no corresponde a ${request.keyName}. ¿Subiste otro CSR?`;
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}
