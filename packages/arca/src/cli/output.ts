import type { ArcaClient } from "../client";
import type { ArcaClientConfig, ArcaClientOptions } from "../internal/types";
import type { WsaaAuthModule } from "../wsaa";

/** Minimal writable surface the CLI needs. Tests pass a string collector. */
export type CliOutputStream = {
  write(chunk: string): void;
  isTTY?: boolean;
};

/** Minimal readable surface the CLI needs for interactive prompts. */
export type CliInputStream = NodeJS.ReadableStream & { isTTY?: boolean };

/** Everything the CLI touches outside itself. Injected so tests stay offline. */
export type CliIo = {
  stdout: CliOutputStream;
  stderr: CliOutputStream;
  stdin: CliInputStream;
  env: Record<string, string | undefined>;
  cwd: string;
  /** Where the WSAA ticket is cached between runs. Never holds anything else. */
  cacheDir: string;
  now(): Date;
  createClient(options: ArcaClientOptions): ArcaClient;
  createAuth(config: ArcaClientConfig): WsaaAuthModule;
};

/** 0 all good, 1 something ARCA-side is wrong, 2 the command was wrong. */
export const CLI_EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
} as const;

const GREEN = "\u001B[32m";
const RED = "\u001B[31m";
const YELLOW = "\u001B[33m";
const CYAN = "\u001B[36m";
const BOLD = "\u001B[1m";
const DIM = "\u001B[2m";
const RESET = "\u001B[0m";

/** Column where a layer detail starts, so the marks line up like a shell. */
const LABEL_WIDTH = 22;
const INDENT = "  ";

/**
 * Wraps text in one ANSI sequence, or returns it untouched when color is off.
 * The whole CLI paints through this, so `--no-color` output is the same text
 * minus the escapes and nothing else.
 */
export type CliPainter = {
  green(text: string): string;
  red(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
  bold(text: string): string;
  dim(text: string): string;
};

/** The painter for a stream whose color was already decided. */
export function createPainter(color: boolean): CliPainter {
  const paint = (code: string) => (text: string) =>
    color ? `${code}${text}${RESET}` : text;
  return {
    green: paint(GREEN),
    red: paint(RED),
    yellow: paint(YELLOW),
    cyan: paint(CYAN),
    bold: paint(BOLD),
    dim: paint(DIM),
  };
}

/** One line per fact. Colors land on the mark and nowhere else. */
export type CliWriter = {
  /** The painter this writer prints with, for text painted before it gets here. */
  painter: CliPainter;
  ok(label: string, detail?: string): void;
  fail(label: string, detail?: string): void;
  warn(label: string, detail?: string): void;
  /** An indented continuation line: a diagnosis, a fix or one sales point. */
  note(text: string): void;
  line(text: string): void;
  /** A whole line in dim: an aside the reader can skip without losing the plot. */
  dim(text: string): void;
  /** An indented shell line: a dim `$` and the command in cyan. */
  command(text: string): void;
  blank(): void;
  json(value: unknown): void;
};

/**
 * ANSI is on only for a TTY without `NO_COLOR` and without `--no-color`.
 * Either of those two turns it off, whatever else says. `FORCE_COLOR` turns it
 * on without a TTY, for CI logs that do render escapes; `FORCE_COLOR=0` is the
 * conventional way of saying no.
 */
export function shouldUseColor(
  stream: CliOutputStream,
  env: Record<string, string | undefined>,
  noColorFlag = false
): boolean {
  if (noColorFlag || env.NO_COLOR !== undefined) {
    return false;
  }
  if (env.FORCE_COLOR !== undefined) {
    return env.FORCE_COLOR !== "0";
  }
  return stream.isTTY === true;
}

export function createWriter(
  stream: CliOutputStream,
  options: { color: boolean }
): CliWriter {
  const painter = createPainter(options.color);

  const mark = (symbol: string, label: string, detail?: string) => {
    const body =
      detail === undefined ? label : `${label.padEnd(LABEL_WIDTH)} ${detail}`;
    stream.write(`${symbol} ${body}\n`);
  };

  return {
    painter,
    ok(label, detail) {
      mark(painter.green("✓"), label, detail);
    },
    fail(label, detail) {
      mark(painter.red("✗"), label, detail);
    },
    warn(label, detail) {
      mark(painter.yellow("!"), label, detail);
    },
    note(text) {
      stream.write(`${INDENT}${text}\n`);
    },
    line(text) {
      stream.write(`${text}\n`);
    },
    dim(text) {
      stream.write(`${painter.dim(text)}\n`);
    },
    command(text) {
      stream.write(`${INDENT}${painter.dim("$")} ${painter.cyan(text)}\n`);
    },
    blank() {
      stream.write("\n");
    },
    json(value) {
      stream.write(`${JSON.stringify(value, null, 2)}\n`);
    },
  };
}
