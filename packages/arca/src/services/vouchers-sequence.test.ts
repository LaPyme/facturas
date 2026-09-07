import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileStore } from "../store/file";
import { createMemoryStore } from "../store/memory";
import {
  type ArcaSequenceRecord,
  type ArcaStore,
  attemptKey,
  sequenceKey,
  sequenceLockKey,
} from "../store/types";
import { createVouchersService } from "./vouchers";
import {
  normalizeWsfeVoucherInput,
  type WsfeAuthorizationOutcome,
  type WsfeAuthorizeVoucherInput,
  type WsfeVoucherInput,
  type WsfeVoucherLookupResult,
} from "./wsfe";
import type { IssueInput } from "./wsfe-derive";

const input: IssueInput = {
  issuer: "monotributo",
  salesPoint: 1,
  to: { condition: "consumidor_final" },
  items: [{ amount: 100 }],
  date: "20260904",
};
const base = {
  service: "wsfe" as const,
  operation: "FECAESolicitar",
  results: {},
  errors: [],
  observations: [],
};
const rejected10016: WsfeAuthorizationOutcome = {
  ...base,
  kind: "rejected",
  result: "R",
  resultLevel: "detail",
  errors: [
    {
      service: "wsfe",
      operation: "FECAESolicitar",
      source: "error",
      category: "business",
      code: "10016",
      message: "number used",
    },
  ],
};
const absent: WsfeVoucherLookupResult = {
  kind: "not_found",
  service: "wsfe",
  operation: "FECompConsultar",
  errors: [],
  observations: [],
  raw: {},
};
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

/** One ARCA sequence: it authorizes only the number that follows the last one. */
function provider() {
  const issued = new Map<number, WsfeVoucherInput>();
  let last = 76;
  const found = (number: number): WsfeVoucherLookupResult => {
    const data = issued.get(number) as WsfeVoucherInput;
    return {
      kind: "found",
      service: "wsfe",
      operation: "FECompConsultar",
      observations: [],
      raw: {},
      voucher: {
        ...data,
        exchangeRate: Number(data.exchangeRate),
        documentNumber: String(data.documentNumber),
        voucherNumber: number,
        result: "A",
        cae: `cae-${number}`,
        caeExpiry: "20260914",
        raw: {},
      },
    };
  };
  const wsfe = {
    getNextVoucherNumber: vi.fn(() => Promise.resolve(last + 1)),
    issue: vi.fn(({ data, voucherNumber }: WsfeAuthorizeVoucherInput) => {
      normalizeWsfeVoucherInput(data);
      if (voucherNumber !== last + 1) {
        return Promise.resolve(rejected10016);
      }
      issued.set(voucherNumber, structuredClone(data));
      last = voucherNumber;
      const outcome: WsfeAuthorizationOutcome = {
        ...base,
        kind: "authorized",
        result: "A",
        resultLevel: "detail",
        cae: `cae-${voucherNumber}`,
        caeExpiry: "20260914",
        voucherNumber,
      };
      return Promise.resolve(outcome);
    }),
    lookupVoucher: vi.fn(({ number }: { number: number }) =>
      Promise.resolve(issued.has(number) ? found(number) : absent)
    ),
  };
  /** The write reached ARCA even though this call never saw its answer. */
  const land = (number: number, data: WsfeVoucherInput) => {
    issued.set(number, structuredClone(data));
    last = number;
  };
  return { wsfe, land };
}
function service(store: ArcaStore, wsfe: ReturnType<typeof provider>["wsfe"]) {
  return createVouchersService(wsfe, {
    store,
    environment: "test",
    taxId: "20123456789",
  });
}
/** A custom store without withLock: no sequence lock, no barrier, no claim. */
function withoutLock(store: ArcaStore): ArcaStore {
  return {
    get: (key) => store.get(key),
    set: (key, value) => store.set(key, value),
    add: (key, value) => store.add(key, value),
    delete: (key) => store.delete?.(key) ?? Promise.resolve(),
  };
}
async function fileStore() {
  const path = await mkdtemp(join(tmpdir(), "arca-sequence-"));
  directories.push(path);
  return path;
}

describe("sequence coordination", () => {
  it("gives two keys consecutive numbers and one ARCA write each", async () => {
    const { wsfe } = provider();
    const arca = service(createMemoryStore(), wsfe);
    const outcomes = await Promise.all([
      arca.issue(input, { idempotencyKey: "a" }),
      arca.issue(input, { idempotencyKey: "b" }),
    ]);
    expect(outcomes.map((outcome) => outcome.kind)).toEqual([
      "authorized",
      "authorized",
    ]);
    expect(
      outcomes
        .map((outcome) =>
          outcome.kind === "authorized" ? outcome.voucher.number : 0
        )
        .sort()
    ).toEqual([77, 78]);
    expect(wsfe.issue).toHaveBeenCalledTimes(2);
  });
  it("keeps a store without withLock on today's uncoordinated behavior", async () => {
    const { wsfe } = provider();
    const arca = service(withoutLock(createMemoryStore()), wsfe);
    const outcomes = await Promise.all([
      arca.issue(input, { idempotencyKey: "a" }),
      arca.issue(input, { idempotencyKey: "b" }),
    ]);
    expect(wsfe.issue.mock.calls.map(([call]) => call.voucherNumber)).toEqual([
      77, 77,
    ]);
    expect(outcomes.map((outcome) => outcome.kind)).toEqual([
      "authorized",
      "conflict",
    ]);
  });
  it("blocks the next claim on an unresolved one until recover settles it", async () => {
    const { wsfe, land } = provider();
    const store = createMemoryStore();
    const arca = service(store, wsfe);
    // The response is lost and the consultation cannot answer either.
    wsfe.issue.mockImplementationOnce(({ data, voucherNumber }) => {
      land(voucherNumber, data);
      return Promise.resolve({
        ...base,
        kind: "indeterminate" as const,
        reason: "transport_error" as const,
      });
    });
    wsfe.lookupVoucher.mockRejectedValueOnce(new Error("offline"));
    expect((await arca.issue(input, { idempotencyKey: "a" })).kind).toBe(
      "indeterminate"
    );
    wsfe.lookupVoucher.mockRejectedValueOnce(new Error("offline"));
    const writes = wsfe.issue.mock.calls.length;
    expect(await arca.issue(input, { idempotencyKey: "b" })).toMatchObject({
      kind: "indeterminate",
      lookup: { kind: "blocked", by: "a" },
    });
    expect(wsfe.issue).toHaveBeenCalledTimes(writes);
    expect(await store.get(attemptKey("test", "20123456789", "b"))).toBeNull();
    // ARCA answers again: recover() settles the stranded claim.
    expect(await arca.recover("a")).toMatchObject({
      kind: "authorized",
      recoveredByMatch: true,
      voucher: { number: 77 },
    });
    expect(await arca.issue(input, { idempotencyKey: "b" })).toMatchObject({
      kind: "authorized",
      voucher: { number: 78 },
    });
  });
  it("does not let an expired lease bypass the barrier", async () => {
    const directory = await fileStore();
    const { wsfe, land } = provider();
    const store = createFileStore(directory);
    const arca = service(store, wsfe);
    wsfe.issue.mockImplementationOnce(({ data, voucherNumber }) => {
      land(voucherNumber, data);
      return Promise.resolve({
        ...base,
        kind: "indeterminate" as const,
        reason: "transport_error" as const,
      });
    });
    wsfe.lookupVoucher.mockRejectedValueOnce(new Error("offline"));
    await arca.issue(input, { idempotencyKey: "crashed" });
    // The worker died holding the lease: the lock file is stale and the claim
    // it left behind is still unresolved.
    const lock = await staleLock(directory);
    wsfe.lookupVoucher.mockRejectedValueOnce(new Error("offline"));
    expect(await arca.issue(input, { idempotencyKey: "next" })).toMatchObject({
      kind: "indeterminate",
      lookup: { kind: "blocked", by: "crashed" },
    });
    expect(lock).toBeDefined();
  });
  it("coordinates two independent stores over one directory", async () => {
    const directory = await fileStore();
    const { wsfe } = provider();
    const first = service(createFileStore(directory), wsfe);
    const second = service(createFileStore(directory), wsfe);
    const outcomes = await Promise.all([
      first.issue(input, { idempotencyKey: "first" }),
      second.issue(input, { idempotencyKey: "second" }),
    ]);
    expect(outcomes.map((outcome) => outcome.kind)).toEqual([
      "authorized",
      "authorized",
    ]);
    expect(
      wsfe.issue.mock.calls.map(([call]) => call.voucherNumber).sort()
    ).toEqual([77, 78]);
    const claimed = JSON.parse(
      (await createFileStore(directory).get(
        sequenceKey("test", "20123456789", 1, 11)
      )) ?? "null"
    ) as ArcaSequenceRecord;
    expect(claimed.resolvedAt).toBeDefined();
  });
});

describe("deadline", () => {
  it("answers aborted after the write and settles it with recover", async () => {
    const { wsfe, land } = provider();
    const arca = service(createMemoryStore(), wsfe);
    const controller = new AbortController();
    wsfe.issue.mockImplementationOnce(({ data, voucherNumber }) => {
      // The write reached ARCA; the caller's deadline fires before its answer.
      land(voucherNumber, data);
      controller.abort();
      return Promise.resolve({
        ...base,
        kind: "indeterminate" as const,
        reason: "transport_error" as const,
      });
    });
    expect(
      await arca.issue(input, {
        idempotencyKey: "sale",
        signal: controller.signal,
      })
    ).toMatchObject({
      kind: "indeterminate",
      attempted: { number: 77 },
      lookup: { kind: "aborted" },
    });
    expect(wsfe.lookupVoucher).not.toHaveBeenCalled();
    expect(await arca.recover("sale")).toMatchObject({
      kind: "authorized",
      recoveredByMatch: true,
      voucher: { number: 77, cae: "cae-77" },
    });
  });
  it("rejects an options.signal that is not an AbortSignal", async () => {
    const { wsfe } = provider();
    const arca = service(createMemoryStore(), wsfe);
    await expect(
      arca.issue(input, { signal: {} as AbortSignal })
    ).rejects.toMatchObject({ code: "ARCA_INPUT_INVALID_VALUE" });
    expect(wsfe.issue).not.toHaveBeenCalled();
  });
});

/** Leaves the lock of the invoice sequence held by a lease that already expired. */
async function staleLock(directory: string): Promise<string> {
  const path = join(
    directory,
    `${createHash("sha256")
      .update(sequenceLockKey("test", "20123456789", 1, 11))
      .digest("hex")}.lock`
  );
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "holder"),
    JSON.stringify({
      owner: "dead-worker",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })
  );
  return path;
}
