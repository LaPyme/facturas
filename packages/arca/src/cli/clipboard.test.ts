import { describe, expect, it } from "vitest";
import {
  type ClipboardProcess,
  type ClipboardSpawn,
  clipboardCommands,
  copyToClipboard,
} from "./clipboard";

type Listener = (value: never) => void;

/** A clipboard tool that does exactly what a test tells it to do. */
class FakeChild {
  readonly written: string[] = [];
  ended = false;
  killed = false;
  throwsOnWrite = false;
  private readonly listeners = new Map<string, Listener>();

  stdin: {
    write(chunk: string): void;
    end(): void;
    on(event: "error", listener: Listener): void;
  } | null = {
    write: (chunk: string) => {
      if (this.throwsOnWrite) {
        throw new Error("EPIPE");
      }
      this.written.push(chunk);
    },
    end: () => {
      this.ended = true;
    },
    on: (event: "error", listener: Listener) => {
      this.listeners.set(`stdin:${event}`, listener);
    },
  };

  on(event: string, listener: Listener) {
    this.listeners.set(event, listener);
    return this;
  }

  kill() {
    this.killed = true;
  }

  emit(event: string, value?: unknown) {
    (this.listeners.get(event) as ((argument: unknown) => void) | undefined)?.(
      value
    );
  }
}

type Call = { command: string; args: readonly string[] };

/** Builds a spawn that answers each tool the way `answers` says. */
function fakeSpawn(
  answers: Record<
    string,
    "ok" | "fails" | "hangs" | "throws" | "no-stdin" | "write-throws"
  >
) {
  const calls: Call[] = [];
  const children: FakeChild[] = [];
  const spawn: ClipboardSpawn = (command, args) => {
    calls.push({ command, args });
    const answer = answers[command] ?? "hangs";
    if (answer === "throws") {
      throw new Error("spawn EACCES");
    }
    const child = new FakeChild();
    children.push(child);
    if (answer === "ok") {
      queueMicrotask(() => child.emit("close", 0));
    }
    if (answer === "fails") {
      queueMicrotask(() => child.emit("error", new Error("spawn ENOENT")));
    }
    if (answer === "no-stdin") {
      child.stdin = null;
    }
    if (answer === "write-throws") {
      child.throwsOnWrite = true;
    }
    return child as unknown as ClipboardProcess;
  };
  return { spawn, calls, children };
}

const CSR = "-----BEGIN CERTIFICATE REQUEST-----\nMIIC\n";

describe("clipboardCommands", () => {
  it("uses pbcopy on macOS and clip on Windows", () => {
    expect(clipboardCommands("darwin", {})).toEqual([
      { command: "pbcopy", args: [] },
    ]);
    expect(clipboardCommands("win32", {})).toEqual([
      { command: "clip", args: [] },
    ]);
  });

  it("prefers wl-copy under Wayland and falls back to xclip and xsel", () => {
    expect(
      clipboardCommands("linux", {
        WAYLAND_DISPLAY: "wayland-0",
        DISPLAY: ":0",
      })
    ).toEqual([
      { command: "wl-copy", args: [] },
      { command: "xclip", args: ["-selection", "clipboard"] },
      { command: "xsel", args: ["--clipboard", "--input"] },
    ]);
    expect(clipboardCommands("linux", { DISPLAY: ":0" })).toEqual([
      { command: "xclip", args: ["-selection", "clipboard"] },
      { command: "xsel", args: ["--clipboard", "--input"] },
    ]);
  });

  it("has nothing to offer without a display or over SSH", () => {
    expect(clipboardCommands("linux", {})).toEqual([]);
    expect(clipboardCommands("darwin", { SSH_CONNECTION: "10.0.0.1" })).toEqual(
      []
    );
    expect(clipboardCommands("darwin", { SSH_TTY: "/dev/ttys000" })).toEqual(
      []
    );
    expect(clipboardCommands("aix", {})).toEqual([]);
  });
});

describe("copyToClipboard", () => {
  it("feeds the text to the tool through stdin and reports success", async () => {
    const { spawn, calls, children } = fakeSpawn({ pbcopy: "ok" });

    const copied = await copyToClipboard(CSR, {
      spawn,
      platform: "darwin",
      env: {},
    });

    expect(copied).toBe(true);
    expect(calls).toEqual([{ command: "pbcopy", args: [] }]);
    expect(children[0]?.written).toEqual([CSR]);
    expect(children[0]?.ended).toBe(true);
  });

  it("is false when the tool is not installed", async () => {
    const { spawn } = fakeSpawn({ clip: "fails" });

    expect(
      await copyToClipboard(CSR, { spawn, platform: "win32", env: {} })
    ).toBe(false);
  });

  it("is false when the tool exits with an error", async () => {
    const { spawn, children } = fakeSpawn({});
    const running = copyToClipboard(CSR, {
      spawn,
      platform: "darwin",
      env: {},
    });
    await Promise.resolve();
    children[0]?.emit("close", 1);

    expect(await running).toBe(false);
  });

  it("is false, and kills the tool, when it hangs", async () => {
    const { spawn, children } = fakeSpawn({ pbcopy: "hangs" });

    const copied = await copyToClipboard(CSR, {
      spawn,
      platform: "darwin",
      env: {},
      timeoutMs: 5,
    });

    expect(copied).toBe(false);
    expect(children[0]?.killed).toBe(true);
  });

  it("is false when spawn itself throws", async () => {
    const { spawn } = fakeSpawn({ pbcopy: "throws" });

    expect(
      await copyToClipboard(CSR, { spawn, platform: "darwin", env: {} })
    ).toBe(false);
  });

  it("tries the next tool when the first one is missing", async () => {
    const { spawn, calls } = fakeSpawn({ xclip: "fails", xsel: "ok" });

    const copied = await copyToClipboard(CSR, {
      spawn,
      platform: "linux",
      env: { DISPLAY: ":0" },
    });

    expect(copied).toBe(true);
    expect(calls.map((call) => call.command)).toEqual(["xclip", "xsel"]);
  });

  it("is false when the tool has no stdin to write to", async () => {
    const { spawn } = fakeSpawn({ pbcopy: "no-stdin" });

    expect(
      await copyToClipboard(CSR, { spawn, platform: "darwin", env: {} })
    ).toBe(false);
  });

  it("is false when the pipe breaks mid-write", async () => {
    const { spawn } = fakeSpawn({ pbcopy: "write-throws" });

    expect(
      await copyToClipboard(CSR, { spawn, platform: "darwin", env: {} })
    ).toBe(false);
  });

  it("keeps the first answer when the tool also closes afterwards", async () => {
    const { spawn, children } = fakeSpawn({ pbcopy: "fails" });

    const copied = await copyToClipboard(CSR, {
      spawn,
      platform: "darwin",
      env: {},
    });
    children[0]?.emit("close", 0);

    expect(copied).toBe(false);
  });

  it("does not spawn anything when the platform has no clipboard", async () => {
    const { spawn, calls } = fakeSpawn({});

    expect(
      await copyToClipboard(CSR, { spawn, platform: "linux", env: {} })
    ).toBe(false);
    expect(calls).toEqual([]);
  });
});
