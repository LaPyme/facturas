import { spawn as spawnProcess } from "node:child_process";

/**
 * The system clipboard, through the tool each platform already ships. There is
 * no dependency and no shell: the text goes to the process' stdin, so nothing
 * a CSR contains can ever be read as a command. Every failure —no binary, no
 * display, a non-zero exit, a hang— is the same answer, `false`, and the CLI
 * prints the CSR instead.
 */

/** How long a clipboard tool has to take the text before the CLI moves on. */
const TIMEOUT_MS = 2000;

type ClipboardStdin = {
  write(chunk: string): unknown;
  end(): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
};

/** The little of a child process this module uses. Tests pass a fake. */
export type ClipboardProcess = {
  stdin: ClipboardStdin | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
  kill(): unknown;
};

/** `child_process.spawn`, narrowed to what the clipboard needs. */
export type ClipboardSpawn = (
  command: string,
  args: readonly string[]
) => ClipboardProcess;

export type ClipboardOptions = {
  spawn?: ClipboardSpawn;
  platform?: string;
  env?: Record<string, string | undefined>;
  /** Only tests pass this. */
  timeoutMs?: number;
};

type ClipboardCommand = { command: string; args: string[] };

/**
 * The tools worth trying, in order, for one platform. Empty means "no
 * clipboard here": a headless Linux box, an SSH session —where the tool would
 * write to the clipboard of the wrong machine— or an unknown platform.
 */
export function clipboardCommands(
  platform: string,
  env: Record<string, string | undefined>
): ClipboardCommand[] {
  if (env.SSH_CONNECTION !== undefined || env.SSH_TTY !== undefined) {
    return [];
  }
  if (platform === "darwin") {
    return [{ command: "pbcopy", args: [] }];
  }
  if (platform === "win32") {
    return [{ command: "clip", args: [] }];
  }
  const commands: ClipboardCommand[] = [];
  if (env.WAYLAND_DISPLAY !== undefined) {
    commands.push({ command: "wl-copy", args: [] });
  }
  if (env.DISPLAY !== undefined) {
    commands.push(
      { command: "xclip", args: ["-selection", "clipboard"] },
      { command: "xsel", args: ["--clipboard", "--input"] }
    );
  }
  return commands;
}

/**
 * Puts `text` in the system clipboard. Never throws and never writes anything
 * to the terminal: the caller decides what to say about `false`.
 */
export async function copyToClipboard(
  text: string,
  options: ClipboardOptions = {}
): Promise<boolean> {
  const spawn =
    options.spawn ??
    ((command, args) =>
      spawnProcess(command, [...args], {
        stdio: ["pipe", "ignore", "ignore"],
      }) as ClipboardProcess);
  const commands = clipboardCommands(
    options.platform ?? process.platform,
    options.env ?? process.env
  );

  for (const candidate of commands) {
    // Sequential on purpose: the second tool is the fallback of the first,
    // and running both would put the text in the clipboard twice.
    const copied = await feed(
      spawn,
      candidate,
      text,
      options.timeoutMs ?? TIMEOUT_MS
    );
    if (copied) {
      return true;
    }
  }
  return false;
}

/** Runs one tool and answers whether it took the text. */
function feed(
  spawn: ClipboardSpawn,
  candidate: ClipboardCommand,
  text: string,
  timeoutMs: number
): Promise<boolean> {
  return new Promise<boolean>((done) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (copied: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      done(copied);
    };

    let child: ClipboardProcess;
    try {
      child = spawn(candidate.command, candidate.args);
    } catch {
      finish(false);
      return;
    }

    timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, timeoutMs);
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));

    const stdin = child.stdin;
    if (stdin === null) {
      finish(false);
      return;
    }
    stdin.on("error", () => finish(false));
    try {
      stdin.write(text);
      stdin.end();
    } catch {
      finish(false);
    }
  });
}
