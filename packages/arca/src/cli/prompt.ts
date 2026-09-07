import { createInterface } from "node:readline/promises";
import type { CliIo } from "./output";

/**
 * True when the CLI may ask a question. Without a TTY on stdin every missing
 * value has to arrive as a flag, so scripts and CI fail fast instead of hanging.
 */
export function isInteractive(io: CliIo): boolean {
  return io.stdin.isTTY === true;
}

/** Asks one question and returns the trimmed answer. Only call on a TTY. */
export async function ask(io: CliIo, question: string): Promise<string> {
  const rl = createInterface({
    input: io.stdin,
    output: io.stdout as NodeJS.WritableStream,
  });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

/**
 * Reads a pasted block: every line from the first non-blank one up to the one
 * `endsAt` recognizes, trimmed. `undefined` means the user backed out —Ctrl-C
 * on a terminal, or the end of the input anywhere else— and never a half block
 * the caller could mistake for a complete one.
 */
export async function askBlock(
  io: CliIo,
  prompt: string,
  endsAt: (line: string) => boolean
): Promise<string[] | undefined> {
  io.stdout.write(prompt);
  const rl = createInterface({
    input: io.stdin,
    output: io.stdout as NodeJS.WritableStream,
  });
  const lines: string[] = [];
  let complete = false;
  // Without this listener readline lets Ctrl-C kill the process; with it, the
  // paste the user gave up on is just an empty answer.
  rl.on("SIGINT", () => rl.close());
  try {
    for await (const raw of rl) {
      const line = raw.trim();
      if (lines.length === 0 && line === "") {
        continue;
      }
      lines.push(line);
      if (endsAt(line)) {
        complete = true;
        break;
      }
    }
  } finally {
    rl.close();
  }
  return complete ? lines : undefined;
}
