import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { CliIo, CliOutputStream } from "./output";
import { ask, askBlock, isInteractive } from "./prompt";

describe("isInteractive", () => {
  it("is true only when stdin is a TTY", () => {
    expect(isInteractive(createIo().io)).toBe(false);
    expect(isInteractive(createIo(true).io)).toBe(true);
  });
});

describe("ask", () => {
  it("reads one trimmed line", async () => {
    const { io, stdin, prompts } = createIo(true);

    const answer = ask(io, "CUIT: ");
    stdin.write("  20123456786  \n");

    expect(await answer).toBe("20123456786");
    expect(prompts()).toContain("CUIT: ");
  });
});

describe("askBlock", () => {
  const isEnd = (line: string) => line === "-----END CERTIFICATE-----";

  it("reads from the first non-blank line to the end line, trimmed", async () => {
    const { io, stdin, prompts } = createIo(true);

    const reading = askBlock(io, "> ", isEnd);
    stdin.write("\n\n  -----BEGIN CERTIFICATE-----  \nMIIC\n");
    stdin.write("-----END CERTIFICATE-----\nlo que venga después\n");

    expect(await reading).toEqual([
      "-----BEGIN CERTIFICATE-----",
      "MIIC",
      "-----END CERTIFICATE-----",
    ]);
    expect(prompts()).toContain("> ");
  });

  it("is undefined when the input ends before the end line", async () => {
    const { io, stdin } = createIo(true);

    const reading = askBlock(io, "> ", isEnd);
    stdin.write("-----BEGIN CERTIFICATE-----\n");
    stdin.end();

    expect(await reading).toBeUndefined();
  });

  it("is undefined on Ctrl-C, without killing anything", async () => {
    const { io, stdin } = createIo(true, true);

    const reading = askBlock(io, "> ", isEnd);
    stdin.write("\u0003");

    expect(await reading).toBeUndefined();
  });
});

function createIo(tty = false, terminalOutput = false) {
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  if (tty) {
    stdin.isTTY = true;
  }
  const written: string[] = [];
  const stdout = new PassThrough() as PassThrough & { isTTY?: boolean };
  if (terminalOutput) {
    stdout.isTTY = true;
  }
  stdout.on("data", (chunk: Buffer) => written.push(chunk.toString()));
  const io: CliIo = {
    stdout: stdout as unknown as CliOutputStream,
    stderr: { write: () => undefined },
    stdin,
    env: {},
    cwd: tmpdir(),
    cacheDir: tmpdir(),
    now: () => new Date(),
    copyToClipboard: () => Promise.resolve(false),
    createClient: () => {
      throw new Error("no client");
    },
    createAuth: () => {
      throw new Error("no auth");
    },
  };
  return { io, stdin, prompts: () => written.join("") };
}
