import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ParseArgsConfig, parseArgs } from "node:util";
import { createArcaClient } from "../client";
import type { ArcaClientConfig } from "../internal/types";
import { createWsaaAuthModule } from "../wsaa";
import { type CertFlags, runCert } from "./cert";
import {
  type CheckFlags,
  describeSalesPointProblem,
  parseSalesPoint,
  runCheck,
} from "./check";
import { copyToClipboard } from "./clipboard";
import { describeUnknownError } from "./diagnose";
import { type CliHelpTopic, renderHelp } from "./help";
import { type InitFlags, runInit } from "./init";
import { type IssueFlags, runIssue } from "./issue";
import {
  CLI_EXIT,
  type CliIo,
  type CliOutputStream,
  createWriter,
  shouldUseColor,
} from "./output";
import { readCliVersion } from "./version";

const COMMANDS = ["init", "cert", "check", "issue"] as const;
type Command = (typeof COMMANDS)[number];

type OptionConfig = NonNullable<ParseArgsConfig["options"]>;

const GLOBAL_OPTIONS: OptionConfig = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  json: { type: "boolean" },
  "no-color": { type: "boolean" },
};

const COMMAND_OPTIONS: Record<Command, OptionConfig> = {
  init: {
    ...GLOBAL_OPTIONS,
    cuit: { type: "string" },
    env: { type: "string" },
    name: { type: "string" },
    org: { type: "string" },
    dir: { type: "string" },
    force: { type: "boolean" },
    "no-clipboard": { type: "boolean" },
    "no-paste": { type: "boolean" },
  },
  cert: {
    ...GLOBAL_OPTIONS,
    env: { type: "string" },
    dir: { type: "string" },
    force: { type: "boolean" },
  },
  check: {
    ...GLOBAL_OPTIONS,
    cert: { type: "string" },
    key: { type: "string" },
    "tax-id": { type: "string" },
    env: { type: "string" },
    dir: { type: "string" },
    "sales-point": { type: "string" },
    "no-cache": { type: "boolean" },
  },
  issue: {
    ...GLOBAL_OPTIONS,
    cert: { type: "string" },
    key: { type: "string" },
    "tax-id": { type: "string" },
    env: { type: "string" },
    dir: { type: "string" },
    "sales-point": { type: "string" },
    "no-cache": { type: "boolean" },
    issuer: { type: "string" },
  },
};

/** Runs one CLI invocation and returns its exit code. Never calls `exit`. */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  const command = argv.find((token) => !token.startsWith("-"));
  const wantsHelp = argv.includes("--help") || argv.includes("-h");
  const wantsVersion = argv.includes("--version") || argv.includes("-v");
  const noColor = argv.includes("--no-color");
  const help = (stream: CliOutputStream, topic: CliHelpTopic) =>
    renderHelp(topic, {
      color: shouldUseColor(stream, io.env, noColor),
    });

  if (wantsVersion) {
    io.stdout.write(`${readCliVersion()}\n`);
    return CLI_EXIT.ok;
  }
  // `--help` never reaches ARCA, the filesystem or a prompt: it is the one
  // command that always works, even with the rest of the line malformed.
  if (wantsHelp) {
    io.stdout.write(help(io.stdout, isCommand(command) ? command : "root"));
    return CLI_EXIT.ok;
  }
  if (command === undefined) {
    io.stderr.write(help(io.stderr, "root"));
    return CLI_EXIT.usage;
  }
  if (!isCommand(command)) {
    io.stderr.write(
      `Comando desconocido: ${command}\n\n${help(io.stderr, "root")}`
    );
    return CLI_EXIT.usage;
  }

  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: COMMAND_OPTIONS[command],
      allowPositionals: true,
      strict: true,
    }) as { values: Record<string, string | boolean | undefined> });
  } catch (error) {
    io.stderr.write(
      `${describeParseError(error)}\n\n${help(io.stderr, command)}`
    );
    return CLI_EXIT.usage;
  }

  const json = values.json === true;
  const writer = createWriter(io.stdout, {
    color: shouldUseColor(io.stdout, io.env, noColor),
  });

  if (command === "init") {
    return await runInit(io, toInitFlags(values), writer);
  }
  if (command === "cert") {
    return await runCert(io, toCertFlags(values), writer);
  }

  const given = values["sales-point"];
  const salesPoint =
    typeof given === "string" ? parseSalesPoint(given) : undefined;
  if (typeof given === "string" && salesPoint === undefined) {
    io.stderr.write(`${describeSalesPointProblem(given)}\n`);
    return CLI_EXIT.usage;
  }

  const shared = toCheckFlags(values, salesPoint);
  if (command === "check") {
    return await runCheck(io, shared, writer, json);
  }
  return await runIssue(io, toIssueFlags(values, shared), writer, json);
}

/**
 * Entry point used by `bin/facturas.mjs`. Sets the process exit code. Nothing
 * reaches node's unhandled rejection handler from here: whatever a command
 * failed to catch comes out as the SDK's safe message, never a stack or a PEM.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  io: CliIo = createDefaultIo()
) {
  try {
    process.exitCode = await run(argv, io);
  } catch (error) {
    io.stderr.write(`${describeUnknownError(error).diagnosis}\n`);
    process.exitCode = CLI_EXIT.failed;
  }
}

/** The real world: real streams, real env, the real SDK. */
export function createDefaultIo(): CliIo {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    env: process.env,
    cwd: process.cwd(),
    cacheDir: join(tmpdir(), "facturas-cli"),
    now: () => new Date(),
    copyToClipboard: (text) =>
      copyToClipboard(text, {
        env: process.env,
        platform: process.platform,
      }),
    createClient: (options) => createArcaClient(options),
    createAuth: (config: ArcaClientConfig) => createWsaaAuthModule({ config }),
  };
}

/** Node reports parse failures in English; the CLI only speaks castellano. */
function describeParseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const unknownOption = /Unknown option '([^']+)'/.exec(message)?.[1];
  if (unknownOption !== undefined) {
    return `Opción desconocida: ${unknownOption}`;
  }
  const missingValue = /Option '([^']+)' argument missing/.exec(message)?.[1];
  if (missingValue !== undefined) {
    return `Falta el valor de ${missingValue}`;
  }
  return "Argumentos inválidos.";
}

function isCommand(value: string | undefined): value is Command {
  return COMMANDS.includes(value as Command);
}

function toInitFlags(
  values: Record<string, string | boolean | undefined>
): InitFlags {
  return {
    ...text(values, "cuit", "cuit"),
    ...text(values, "env", "env"),
    ...text(values, "name", "name"),
    ...text(values, "org", "org"),
    ...text(values, "dir", "dir"),
    ...(values.force === true ? { force: true } : {}),
    ...(values["no-clipboard"] === true ? { noClipboard: true } : {}),
    ...(values["no-paste"] === true ? { noPaste: true } : {}),
  };
}

function toCertFlags(
  values: Record<string, string | boolean | undefined>
): CertFlags {
  return {
    ...text(values, "env", "env"),
    ...text(values, "dir", "dir"),
    ...(values.force === true ? { force: true } : {}),
  };
}

function toCheckFlags(
  values: Record<string, string | boolean | undefined>,
  salesPoint: number | undefined
): CheckFlags {
  return {
    ...text(values, "cert", "cert"),
    ...text(values, "key", "key"),
    ...text(values, "tax-id", "taxId"),
    ...text(values, "env", "env"),
    ...text(values, "dir", "dir"),
    ...(salesPoint === undefined ? {} : { salesPoint }),
    ...(values["no-cache"] === true ? { noCache: true } : {}),
  };
}

function toIssueFlags(
  values: Record<string, string | boolean | undefined>,
  shared: CheckFlags
): IssueFlags {
  return { ...shared, ...text(values, "issuer", "issuer") };
}

function text<TKey extends string>(
  values: Record<string, string | boolean | undefined>,
  from: string,
  to: TKey
): Partial<Record<TKey, string>> {
  const value = values[from];
  return typeof value === "string"
    ? ({ [to]: value } as Record<TKey, string>)
    : {};
}
