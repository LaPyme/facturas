import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { CliIo, CliOutputStream } from "./output";
import { ask, isInteractive } from "./prompt";

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

function createIo(tty = false) {
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  if (tty) {
    stdin.isTTY = true;
  }
  const written: string[] = [];
  const stdout = new PassThrough();
  stdout.on("data", (chunk: Buffer) => written.push(chunk.toString()));
  const io: CliIo = {
    stdout: stdout as unknown as CliOutputStream,
    stderr: { write: () => undefined },
    stdin,
    env: {},
    cwd: tmpdir(),
    cacheDir: tmpdir(),
    now: () => new Date(),
    createClient: () => {
      throw new Error("no client");
    },
    createAuth: () => {
      throw new Error("no auth");
    },
  };
  return { io, stdin, prompts: () => written.join("") };
}
