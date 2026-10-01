import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFileStore } from "../store/file";
import { createMemoryStore } from "../store/memory";
import {
  type ArcaSequenceRecord,
  type ArcaStore,
  attemptKey,
  sequenceKey,
  sequenceLockKey,
  settledKey,
} from "../store/types";
import { createVouchersService } from "./vouchers";
import {
  normalizeWsfeVoucherInput,
  type WsfeAuthorizationOutcome,
  type WsfeIssueInput,
  type WsfeVoucherInput,
  type WsfeVoucherLookupResult,
} from "./wsfe";
import type { IssueInput } from "./wsfe-derive";

// The fixtures are dated around 2026-09-04, and ARCA only accepts a voucher
// dated near the day it is sent.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-05T15:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

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
/** A business rule rejects the voucher itself, not its number. */
const rejectedRule: WsfeAuthorizationOutcome = {
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
      code: "10015",
      message: "invalid document",
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
  const writes = { concurrent: 0 };
  let running = 0;
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
        cae: `741234567890${String(number).padStart(2, "0")}`,
        caeExpiry: "20260914",
        raw: {},
      },
    };
  };
  const wsfe = {
    getNextVoucherNumber: vi.fn(() => Promise.resolve(last + 1)),
    issue: vi.fn(async ({ data, voucherNumber }: WsfeIssueInput) => {
      normalizeWsfeVoucherInput(data);
      running += 1;
      writes.concurrent = Math.max(writes.concurrent, running);
      await Promise.resolve();
      running -= 1;
      if (voucherNumber !== last + 1) {
        return rejected10016;
      }
      issued.set(voucherNumber, structuredClone(data));
      last = voucherNumber;
      const outcome: WsfeAuthorizationOutcome = {
        ...base,
        kind: "authorized",
        result: "A",
        resultLevel: "detail",
        cae: `741234567890${String(voucherNumber).padStart(2, "0")}`,
        caeExpiry: "20260914",
        voucherNumber,
      };
      return outcome;
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
  return { wsfe, land, writes };
}
function service(
  store: ArcaStore,
  wsfe: ReturnType<typeof provider>["wsfe"],
  taxId = "20123456789"
) {
  return createVouchersService(wsfe, { store, environment: "test", taxId });
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
  const owner = "20123456789";
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
    const store = withoutLock(createMemoryStore());
    const arca = service(store, wsfe);
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
    // The conflict of the first send is kept: a retry and recover() give it back.
    expect(await store.get(settledKey("test", owner, "b"))).not.toBeNull();
    for (const outcome of [
      await arca.issue(input, { idempotencyKey: "b" }),
      await arca.recover("b"),
    ]) {
      expect(outcome.kind).toBe("conflict");
    }
  });
  it.each([
    ["with", true],
    ["without", false],
  ])(
    "keeps the conflict of a key's first send when a keyless sale takes the number first (%s withLock)",
    async (_, locked) => {
      const { wsfe } = provider();
      const memory = createMemoryStore();
      const store = locked ? memory : withoutLock(memory);
      const arca = service(store, wsfe);
      const write = wsfe.issue.getMockImplementation() as NonNullable<
        ReturnType<typeof wsfe.issue.getMockImplementation>
      >;
      wsfe.issue.mockImplementationOnce(async (call) => {
        await arca.issue(input);
        return write(call);
      });
      expect((await arca.issue(input, { idempotencyKey: "key1" })).kind).toBe(
        "conflict"
      );
      expect(await store.get(settledKey("test", owner, "key1"))).not.toBeNull();
      for (const outcome of [
        await arca.issue(input, { idempotencyKey: "key1" }),
        await arca.recover("key1"),
      ]) {
        expect(outcome.kind).toBe("conflict");
      }
    }
  );
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

describe("superseded claims", () => {
  const stranded = () =>
    Promise.resolve({
      ...base,
      kind: "indeterminate" as const,
      reason: "transport_error" as const,
    });
  async function strand(
    arca: ReturnType<typeof service>,
    wsfe: ReturnType<typeof provider>["wsfe"]
  ) {
    // The claim never reached ARCA and its consultation could not answer.
    wsfe.issue.mockImplementationOnce(stranded);
    wsfe.lookupVoucher.mockRejectedValueOnce(new Error("offline"));
    expect((await arca.issue(input, { idempotencyKey: "key1" })).kind).toBe(
      "indeterminate"
    );
  }

  it("never gives a superseded key the CAE of the key that replaced it", async () => {
    const { wsfe } = provider();
    const store = createMemoryStore();
    const arca = service(store, wsfe);
    await strand(arca, wsfe);
    // The next claim proves the number is free and takes it with the same
    // fiscal data: two consumidor final sales for the same amount.
    expect(await arca.issue(input, { idempotencyKey: "key2" })).toMatchObject({
      kind: "authorized",
      voucher: { number: 77, cae: "74123456789077" },
    });
    expect(
      JSON.parse(
        (await store.get(settledKey("test", "20123456789", "key1"))) ?? "null"
      )
    ).toMatchObject({ v: 1, kind: "superseded", number: 77, by: "key2" });
    const writes = wsfe.issue.mock.calls.length;
    // The voucher at 77 is key2's: key1 learns it was superseded and issues
    // under a new key, with no CAE and no conflict to reconcile by hand.
    for (const outcome of [
      await arca.issue(input, { idempotencyKey: "key1" }),
      await arca.recover("key1"),
    ]) {
      expect(outcome).toMatchObject({
        kind: "indeterminate",
        attempted: { number: 77 },
        lookup: { kind: "superseded", by: "key2" },
      });
      expect(outcome).not.toHaveProperty("voucher");
    }
    expect(wsfe.issue).toHaveBeenCalledTimes(writes);
  });
  it("keeps a superseded key in conflict when its successor met a stranger", async () => {
    const { wsfe, land } = provider();
    const arca = service(createMemoryStore(), wsfe);
    await strand(arca, wsfe);
    // A writer outside the store takes 77 between key2's barrier and its
    // write, so key2 records a conflict. The voucher there could be anyone's,
    // including a late write of key1's own, and stays for a person to settle.
    wsfe.issue.mockImplementationOnce(({ data }) => {
      land(77, data);
      return Promise.resolve(rejected10016);
    });
    expect(await arca.issue(input, { idempotencyKey: "key2" })).toMatchObject({
      kind: "conflict",
      found: { number: 77 },
    });
    const writes = wsfe.issue.mock.calls.length;
    for (const outcome of [
      await arca.issue(input, { idempotencyKey: "key1" }),
      await arca.recover("key1"),
    ]) {
      expect(outcome).toMatchObject({
        kind: "conflict",
        attempted: { number: 77 },
        found: { number: 77 },
      });
    }
    expect(wsfe.issue).toHaveBeenCalledTimes(writes);
  });
  it("follows the keys that took the number from each other", async () => {
    const { wsfe } = provider();
    const arca = service(createMemoryStore(), wsfe);
    await strand(arca, wsfe);
    // key2 takes 77 from key1 and is stranded the same way, once the barrier's
    // own consultation has answered.
    wsfe.issue.mockImplementationOnce(() => {
      wsfe.lookupVoucher.mockRejectedValueOnce(new Error("offline"));
      return stranded();
    });
    expect((await arca.issue(input, { idempotencyKey: "key2" })).kind).toBe(
      "indeterminate"
    );
    expect(await arca.issue(input, { idempotencyKey: "key3" })).toMatchObject({
      kind: "authorized",
      voucher: { number: 77 },
    });
    const writes = wsfe.issue.mock.calls.length;
    expect(await arca.recover("key1")).toMatchObject({
      kind: "indeterminate",
      lookup: { kind: "superseded", by: "key2" },
    });
    expect(await arca.recover("key2")).toMatchObject({
      kind: "indeterminate",
      lookup: { kind: "superseded", by: "key3" },
    });
    expect(wsfe.issue).toHaveBeenCalledTimes(writes);
  });
  it("never resends a stranded number while another key claims the sequence", async () => {
    const { wsfe, writes } = provider();
    const arca = service(createMemoryStore(), wsfe);
    await strand(arca, wsfe);
    const outcomes = await Promise.all([
      arca.issue(input, { idempotencyKey: "key1" }),
      arca.issue(input, { idempotencyKey: "key2" }),
    ]);
    expect(writes.concurrent).toBe(1);
    const numbers = outcomes.flatMap((outcome) =>
      outcome.kind === "authorized" ? [outcome.voucher.number] : []
    );
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers).not.toHaveLength(0);
  });
  it("does not supersede a claim when the sequence already moved", async () => {
    const { wsfe } = provider();
    const store = createMemoryStore();
    const arca = service(store, wsfe);
    await strand(arca, wsfe);
    // ARCA advanced past the number through a writer the consultation cannot
    // see, so nothing may be declared free.
    wsfe.getNextVoucherNumber.mockResolvedValue(78);
    const writes = wsfe.issue.mock.calls.length;
    expect(await arca.issue(input, { idempotencyKey: "key2" })).toMatchObject({
      kind: "indeterminate",
      lookup: { kind: "blocked", by: "key1" },
    });
    expect(
      await store.get(settledKey("test", "20123456789", "key1"))
    ).toBeNull();
    expect(wsfe.issue).toHaveBeenCalledTimes(writes);
  });
  it("asks ARCA, not a manual number, whether the sequence moved", async () => {
    const { wsfe } = provider();
    const store = createMemoryStore();
    const arca = service(store, wsfe);
    await strand(arca, wsfe);
    // The caller names the stranded number, but ARCA already moved past it.
    wsfe.getNextVoucherNumber.mockResolvedValue(78);
    const writes = wsfe.issue.mock.calls.length;
    expect(
      await arca.issue(input, { idempotencyKey: "key2", number: 77 })
    ).toMatchObject({
      kind: "indeterminate",
      lookup: { kind: "blocked", by: "key1" },
    });
    expect(
      await store.get(settledKey("test", "20123456789", "key1"))
    ).toBeNull();
    expect(wsfe.issue).toHaveBeenCalledTimes(writes);
  });
  it("supersedes only for a claim that takes the stranded number", async () => {
    const { wsfe } = provider();
    const store = createMemoryStore();
    const arca = service(store, wsfe);
    await strand(arca, wsfe);
    // key2 names 78: it would never write 77, so it cannot supersede key1.
    const writes = wsfe.issue.mock.calls.length;
    expect(
      await arca.issue(input, { idempotencyKey: "key2", number: 78 })
    ).toMatchObject({
      kind: "indeterminate",
      lookup: { kind: "blocked", by: "key1" },
    });
    expect(
      await store.get(settledKey("test", "20123456789", "key1"))
    ).toBeNull();
    expect(wsfe.issue).toHaveBeenCalledTimes(writes);
  });
  it("resolves the marker when a retry reaches ARCA", async () => {
    const { wsfe } = provider();
    const store = createMemoryStore();
    const arca = service(store, wsfe);
    await strand(arca, wsfe);
    // The retry finds 77 empty, resends it and ARCA authorizes it.
    expect(await arca.issue(input, { idempotencyKey: "key1" })).toMatchObject({
      kind: "authorized",
      voucher: { number: 77 },
    });
    expect(
      JSON.parse(
        (await store.get(sequenceKey("test", "20123456789", 1, 11))) ?? "null"
      )
    ).toMatchObject({ key: "key1", resolvedAt: expect.any(String) });
    // The next key needs no consultation, so a lookup outage cannot block it.
    const lookups = wsfe.lookupVoucher.mock.calls.length;
    wsfe.lookupVoucher.mockRejectedValue(new Error("offline"));
    expect(await arca.issue(input, { idempotencyKey: "key2" })).toMatchObject({
      kind: "authorized",
      voucher: { number: 78 },
    });
    expect(wsfe.lookupVoucher).toHaveBeenCalledTimes(lookups);
  });
  it("reports a superseded key whose number stayed empty", async () => {
    const { wsfe } = provider();
    const arca = service(createMemoryStore(), wsfe);
    await strand(arca, wsfe);
    // The key that superseded it was rejected, so the number is still empty.
    wsfe.issue.mockImplementationOnce(() => Promise.resolve(rejected10016));
    expect((await arca.issue(input, { idempotencyKey: "key2" })).kind).toBe(
      "rejected"
    );
    const writes = wsfe.issue.mock.calls.length;
    for (const outcome of [
      await arca.issue(input, { idempotencyKey: "key1" }),
      await arca.recover("key1"),
    ]) {
      expect(outcome).toMatchObject({
        kind: "indeterminate",
        lookup: { kind: "superseded", by: "key2" },
      });
    }
    expect(wsfe.issue).toHaveBeenCalledTimes(writes);
  });
  it.each([
    ["memory", () => Promise.resolve(createMemoryStore())],
    ["file", async () => createFileStore(await fileStore())],
  ])("never gives a rejected key its successor's CAE (%s)", async (_, open) => {
    const { wsfe } = provider();
    const store = await open();
    const arca = service(store, wsfe);
    // A business rule rejects key1, so 77 stays empty.
    wsfe.issue.mockImplementationOnce(() => Promise.resolve(rejectedRule));
    expect(await arca.issue(input, { idempotencyKey: "key1" })).toMatchObject({
      kind: "rejected",
      attempted: { number: 77 },
    });
    // The rejection settles the claim: the next key takes 77 at once.
    const lookups = wsfe.lookupVoucher.mock.calls.length;
    expect(await arca.issue(input, { idempotencyKey: "key2" })).toMatchObject({
      kind: "authorized",
      voucher: { number: 77, cae: "74123456789077" },
    });
    expect(wsfe.lookupVoucher).toHaveBeenCalledTimes(lookups);
    const writes = wsfe.issue.mock.calls.length;
    for (const outcome of [
      await arca.issue(input, { idempotencyKey: "key1" }),
      await arca.recover("key1"),
    ]) {
      expect(outcome).toMatchObject({
        kind: "conflict",
        attempted: { number: 77 },
        found: { number: 77 },
      });
      expect(outcome).not.toHaveProperty("voucher");
    }
    expect(wsfe.issue).toHaveBeenCalledTimes(writes);
  });
  it.each([
    ["with withLock", () => createMemoryStore()],
    ["without withLock", () => withoutLock(createMemoryStore())],
  ])(
    "keeps a rejected key off a number taken outside the barrier (%s)",
    async (_, open) => {
      const { wsfe } = provider();
      const arca = service(open(), wsfe);
      wsfe.issue.mockImplementationOnce(() => Promise.resolve(rejectedRule));
      expect((await arca.issue(input, { idempotencyKey: "key1" })).kind).toBe(
        "rejected"
      );
      // The same sale issued with no key never passes the barrier.
      expect(await arca.issue(input)).toMatchObject({
        kind: "authorized",
        voucher: { number: 77 },
      });
      const writes = wsfe.issue.mock.calls.length;
      for (const outcome of [
        await arca.recover("key1"),
        await arca.issue(input, { idempotencyKey: "key1" }),
      ]) {
        expect(outcome).toMatchObject({
          kind: "conflict",
          found: { number: 77 },
        });
      }
      expect(wsfe.issue).toHaveBeenCalledTimes(writes);
    }
  );
  it("resends a rejected key while its number is still free", async () => {
    const { wsfe } = provider();
    const arca = service(createMemoryStore(), wsfe);
    wsfe.issue.mockImplementationOnce(() => Promise.resolve(rejectedRule));
    expect((await arca.issue(input, { idempotencyKey: "key1" })).kind).toBe(
      "rejected"
    );
    expect(await arca.issue(input, { idempotencyKey: "key1" })).toMatchObject({
      kind: "authorized",
      recoveredByMatch: false,
      voucher: { number: 77 },
    });
    expect(wsfe.issue).toHaveBeenCalledTimes(2);
    // Its own voucher is not a stranger's: a later retry recovers it.
    expect(await arca.issue(input, { idempotencyKey: "key1" })).toMatchObject({
      kind: "authorized",
      recoveredByMatch: true,
      voucher: { number: 77 },
    });
    expect(wsfe.issue).toHaveBeenCalledTimes(2);
  });
  it("lets a concurrent same-key call resend its rejected number", async () => {
    const { wsfe } = provider();
    const store = createMemoryStore();
    const arca = service(store, wsfe);
    // A double submit: the first call is rejected while the second waits.
    wsfe.issue.mockImplementationOnce(() => Promise.resolve(rejectedRule));
    const outcomes = await Promise.all([
      arca.issue(input, { idempotencyKey: "sale" }),
      arca.issue(input, { idempotencyKey: "sale" }),
    ]);
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual([
      "authorized",
      "rejected",
    ]);
    expect(
      await store.get(settledKey("test", "20123456789", "sale"))
    ).toBeNull();
    expect(wsfe.issue.mock.calls.map(([call]) => call.voucherNumber)).toEqual([
      77, 77,
    ]);
  });
  it("does not block the sequence on a rejected manual number", async () => {
    const { wsfe } = provider();
    const store = createMemoryStore();
    const arca = service(store, wsfe);
    // ARCA only takes 77, so a manual 80 is rejected.
    expect(
      await arca.issue(input, { idempotencyKey: "key1", number: 80 })
    ).toMatchObject({ kind: "rejected", attempted: { number: 80 } });
    expect(await arca.issue(input, { idempotencyKey: "key2" })).toMatchObject({
      kind: "authorized",
      voucher: { number: 77 },
    });
    expect(
      await store.get(settledKey("test", "20123456789", "key1"))
    ).toBeNull();
    // 80 is still empty: recover reports it and a retry is rejected again.
    expect(await arca.recover("key1")).toMatchObject({
      kind: "indeterminate",
      attempted: { number: 80 },
      lookup: { kind: "not_found" },
    });
    expect(
      await arca.issue(input, { idempotencyKey: "key1", number: 80 })
    ).toMatchObject({ kind: "rejected", attempted: { number: 80 } });
  });
});

describe("rejected retries", () => {
  const sequence = sequenceKey("test", "20123456789", 1, 11);
  const stranded = () =>
    Promise.resolve({
      ...base,
      kind: "indeterminate" as const,
      reason: "transport_error" as const,
    });
  async function reject(
    arca: ReturnType<typeof service>,
    wsfe: ReturnType<typeof provider>["wsfe"]
  ) {
    wsfe.issue.mockImplementationOnce(() => Promise.resolve(rejectedRule));
    expect((await arca.issue(input, { idempotencyKey: "key1" })).kind).toBe(
      "rejected"
    );
  }

  it("gives two concurrent retries of a rejected key its own voucher", async () => {
    const { wsfe } = provider();
    const store = createMemoryStore();
    const arca = service(store, wsfe);
    await reject(arca, wsfe);
    const outcomes = await Promise.all([
      arca.issue(input, { idempotencyKey: "key1" }),
      arca.issue(input, { idempotencyKey: "key1" }),
    ]);
    expect(outcomes).toMatchObject([
      { kind: "authorized", voucher: { number: 77 } },
      { kind: "authorized", voucher: { number: 77 } },
    ]);
    expect(
      await store.get(settledKey("test", "20123456789", "key1"))
    ).toBeNull();
    expect(wsfe.issue).toHaveBeenCalledTimes(2);
  });
  it("reopens the claim before a rejected key resends", async () => {
    const { wsfe } = provider();
    const store = createMemoryStore();
    const arca = service(store, wsfe);
    await reject(arca, wsfe);
    // The resend gets no answer and nothing can consult it.
    wsfe.issue.mockImplementationOnce(stranded);
    wsfe.lookupVoucher
      .mockImplementationOnce(() => Promise.resolve(absent))
      .mockRejectedValueOnce(new Error("offline"));
    expect((await arca.issue(input, { idempotencyKey: "key1" })).kind).toBe(
      "indeterminate"
    );
    expect(
      JSON.parse((await store.get(sequence)) ?? "null")
    ).not.toHaveProperty("resolvedAt");
    // The next key must prove 77 empty and supersede key1 before taking it.
    expect(await arca.issue(input, { idempotencyKey: "key2" })).toMatchObject({
      kind: "authorized",
      voucher: { number: 77 },
    });
    expect(await arca.issue(input, { idempotencyKey: "key1" })).toMatchObject({
      kind: "indeterminate",
      lookup: { kind: "superseded", by: "key2" },
    });
  });
  it("never resends a number another key holds unresolved", async () => {
    const { wsfe } = provider();
    const arca = service(createMemoryStore(), wsfe);
    await reject(arca, wsfe);
    // key2 takes 77. its write is lost and its consultation fails.
    wsfe.issue.mockImplementationOnce(stranded);
    wsfe.lookupVoucher.mockRejectedValueOnce(new Error("offline"));
    expect((await arca.issue(input, { idempotencyKey: "key2" })).kind).toBe(
      "indeterminate"
    );
    const writes = wsfe.issue.mock.calls.length;
    expect(await arca.issue(input, { idempotencyKey: "key1" })).toMatchObject({
      kind: "indeterminate",
      attempted: { number: 77 },
      lookup: { kind: "blocked", by: "key2" },
    });
    expect(wsfe.issue).toHaveBeenCalledTimes(writes);
  });
  /** Holds recover()'s next lookup until the returned function runs. */
  function holdLookup(wsfe: ReturnType<typeof provider>["wsfe"]) {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const lookup = wsfe.lookupVoucher.getMockImplementation();
    wsfe.lookupVoucher.mockImplementationOnce(async (call) => {
      await gate;
      return (lookup as NonNullable<typeof lookup>)(call);
    });
    return open;
  }
  /** Lets a retry run to its end, unless the sequence lock holds it back. */
  const settleOrWait = (retrying: Promise<unknown>) =>
    Promise.race([retrying, new Promise((resolve) => setTimeout(resolve, 50))]);

  it("makes a retry wait for recover() on the same sequence", async () => {
    const { wsfe } = provider();
    const store = createMemoryStore();
    const arca = service(store, wsfe);
    await reject(arca, wsfe);
    const open = holdLookup(wsfe);
    const recovering = arca.recover("key1");
    await vi.waitFor(() => expect(wsfe.lookupVoucher).toHaveBeenCalled());
    const retrying = arca.issue(input, { idempotencyKey: "key1" });
    await settleOrWait(retrying);
    open();
    // recover() still sees the rejection and an empty number. the retry
    // resends only after it.
    expect(await recovering).toMatchObject({
      kind: "indeterminate",
      lookup: { kind: "not_found" },
    });
    expect(await retrying).toMatchObject({
      kind: "authorized",
      voucher: { number: 77 },
    });
    expect(
      await store.get(settledKey("test", "20123456789", "key1"))
    ).toBeNull();
    expect(await arca.recover("key1")).toMatchObject({
      kind: "authorized",
      recoveredByMatch: true,
      voucher: { number: 77 },
    });
  });
  it("makes recover() read the rejection again once it holds the lock", async () => {
    const { wsfe } = provider();
    const store = createMemoryStore();
    const arca = service(store, wsfe);
    await reject(arca, wsfe);
    // The retry holds the lock while it checks 77, before it clears the
    // rejection and resends.
    const open = holdLookup(wsfe);
    const retrying = arca.issue(input, { idempotencyKey: "key1" });
    await vi.waitFor(() => expect(wsfe.lookupVoucher).toHaveBeenCalled());
    // recover() reads the rejection, then waits for the lease.
    const recovering = arca.recover("key1");
    await settleOrWait(recovering);
    open();
    expect(await retrying).toMatchObject({
      kind: "authorized",
      voucher: { number: 77 },
    });
    expect(await recovering).toMatchObject({
      kind: "authorized",
      recoveredByMatch: true,
      voucher: { number: 77 },
    });
    expect(
      await store.get(settledKey("test", "20123456789", "key1"))
    ).toBeNull();
  });
  it("never lets recover() take a stranger's CAE during a retry", async () => {
    const { wsfe, land } = provider();
    const arca = service(createMemoryStore(), wsfe);
    await reject(arca, wsfe);
    const open = holdLookup(wsfe);
    const recovering = arca.recover("key1");
    await vi.waitFor(() => expect(wsfe.lookupVoucher).toHaveBeenCalled());
    // The retry resends 77, but a keyless sale with the same data got there
    // first.
    wsfe.issue.mockImplementationOnce(({ data }) => {
      land(77, data);
      return Promise.resolve(rejected10016);
    });
    const retrying = arca.issue(input, { idempotencyKey: "key1" });
    await settleOrWait(retrying);
    open();
    const recovered = await recovering;
    expect(recovered).not.toMatchObject({ kind: "authorized" });
    expect(await retrying).toMatchObject({
      kind: "conflict",
      found: { number: 77 },
    });
    expect(await arca.recover("key1")).toMatchObject({ kind: "conflict" });
  });
  it("treats a voucher landing during the resend as a stranger's", async () => {
    const { wsfe, land } = provider();
    const arca = service(createMemoryStore(), wsfe);
    await reject(arca, wsfe);
    // 77 is empty when the retry checks it, but a keyless sale takes it
    // before the resend reaches ARCA.
    wsfe.issue.mockImplementationOnce(({ data }) => {
      land(77, data);
      return Promise.resolve(rejected10016);
    });
    expect(await arca.issue(input, { idempotencyKey: "key1" })).toMatchObject({
      kind: "conflict",
      found: { number: 77 },
    });
  });
  it("never lets a double submit supersede its own key", async () => {
    const { wsfe } = provider();
    const store = createMemoryStore();
    const arca = service(store, wsfe);
    // The first call is stranded; the second waits for the lease.
    wsfe.issue.mockImplementationOnce(stranded);
    wsfe.lookupVoucher.mockRejectedValueOnce(new Error("offline"));
    const outcomes = await Promise.all([
      arca.issue(input, { idempotencyKey: "sale" }),
      arca.issue(input, { idempotencyKey: "sale" }),
    ]);
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual([
      "authorized",
      "indeterminate",
    ]);
    expect(
      await store.get(settledKey("test", "20123456789", "sale"))
    ).toBeNull();
  });
  it("lets the next key pass a rejection whose marker never resolved", async () => {
    const { wsfe } = provider();
    const memory = createMemoryStore();
    // The marker write after the rejection is lost; the rejection is kept.
    let sets = 0;
    const store: ArcaStore = {
      ...memory,
      set: (key, value) =>
        key === sequence && ++sets === 2
          ? Promise.reject(new Error("connection lost"))
          : memory.set(key, value),
    };
    const arca = service(store, wsfe);
    wsfe.issue.mockImplementationOnce(() => Promise.resolve(rejectedRule));
    await expect(arca.issue(input, { idempotencyKey: "key1" })).rejects.toThrow(
      "ARCA store operation failed."
    );
    // The barrier needs no consultation: key1's retry treats 77 as foreign.
    const lookups = wsfe.lookupVoucher.mock.calls.length;
    expect(await arca.issue(input, { idempotencyKey: "key2" })).toMatchObject({
      kind: "authorized",
      voucher: { number: 77 },
    });
    expect(wsfe.lookupVoucher).toHaveBeenCalledTimes(lookups);
    expect(await arca.issue(input, { idempotencyKey: "key1" })).toMatchObject({
      kind: "conflict",
      found: { number: 77 },
    });
  });
  it("blocks behind an unanswered manual number ahead of the sequence", async () => {
    const { wsfe } = provider();
    const store = createMemoryStore();
    const arca = service(store, wsfe);
    wsfe.issue.mockImplementationOnce(stranded);
    wsfe.lookupVoucher.mockRejectedValueOnce(new Error("offline"));
    expect(
      (await arca.issue(input, { idempotencyKey: "key1", number: 80 })).kind
    ).toBe("indeterminate");
    // ARCA is at 77: key2 would never write 80, so key1 stays unsettled.
    expect(await arca.issue(input, { idempotencyKey: "key2" })).toMatchObject({
      kind: "indeterminate",
      lookup: { kind: "blocked", by: "key1" },
    });
    expect(
      await store.get(settledKey("test", "20123456789", "key1"))
    ).toBeNull();
  });
});

describe("issuers sharing a sequence", () => {
  // Two certificates represent the same taxpayer and share one store.
  const represented = { representedTaxId: "30712345678" };
  const first = "20123456789";
  const second = "20987654321";
  async function strand(
    arca: ReturnType<typeof service>,
    wsfe: ReturnType<typeof provider>["wsfe"],
    idempotencyKey: string
  ) {
    wsfe.issue.mockImplementationOnce(() =>
      Promise.resolve({
        ...base,
        kind: "indeterminate" as const,
        reason: "transport_error" as const,
      })
    );
    wsfe.lookupVoucher.mockRejectedValueOnce(new Error("offline"));
    expect(
      (await arca.issue(input, { ...represented, idempotencyKey })).kind
    ).toBe("indeterminate");
  }

  it("never lets a rejected key take another issuer's claim on the same key", async () => {
    const { wsfe } = provider();
    const store = createMemoryStore();
    const a = service(store, wsfe, first);
    const b = service(store, wsfe, second);
    wsfe.issue.mockImplementationOnce(() => Promise.resolve(rejectedRule));
    expect(
      (await a.issue(input, { ...represented, idempotencyKey: "sale" })).kind
    ).toBe("rejected");
    // The other issuer claims 77 under the same key, and its write is lost.
    await strand(b, wsfe, "sale");
    const writes = wsfe.issue.mock.calls.length;
    expect(
      await a.issue(input, { ...represented, idempotencyKey: "sale" })
    ).toMatchObject({
      kind: "indeterminate",
      lookup: { kind: "blocked", by: "sale", byTaxId: second },
    });
    expect(wsfe.issue).toHaveBeenCalledTimes(writes);
  });
  it("names the issuer that holds the claim", async () => {
    const { wsfe } = provider();
    const store = createMemoryStore();
    await strand(service(store, wsfe, first), wsfe, "sale-1");
    expect(
      JSON.parse(
        (await store.get(sequenceKey("test", "30712345678", 1, 11))) ?? "null"
      )
    ).toMatchObject({ key: "sale-1", issuerTaxId: first, number: 77 });
  });
  it("names the issuer that reclaimed a rejected key", async () => {
    const { wsfe } = provider();
    const store = createMemoryStore();
    const a = service(store, wsfe, first);
    const b = service(store, wsfe, second);
    wsfe.issue.mockImplementationOnce(() => Promise.resolve(rejectedRule));
    expect(
      (await a.issue(input, { ...represented, idempotencyKey: "sale" })).kind
    ).toBe("rejected");
    // The resend finds 77 empty, goes out and gets no answer.
    wsfe.lookupVoucher.mockResolvedValueOnce(absent);
    wsfe.issue.mockImplementationOnce(() =>
      Promise.resolve({
        ...base,
        kind: "indeterminate" as const,
        reason: "transport_error" as const,
      })
    );
    wsfe.lookupVoucher.mockRejectedValueOnce(new Error("offline"));
    expect(
      (await a.issue(input, { ...represented, idempotencyKey: "sale" })).kind
    ).toBe("indeterminate");
    wsfe.lookupVoucher.mockRejectedValueOnce(new Error("offline"));
    const writes = wsfe.issue.mock.calls.length;
    expect(
      await b.issue(input, { ...represented, idempotencyKey: "other" })
    ).toMatchObject({
      kind: "indeterminate",
      lookup: { kind: "blocked", by: "sale", byTaxId: first },
    });
    expect(wsfe.issue).toHaveBeenCalledTimes(writes);
  });
  it("blocks another issuer on the unresolved claim", async () => {
    const { wsfe } = provider();
    const store = createMemoryStore();
    await strand(service(store, wsfe, first), wsfe, "sale-1");
    wsfe.lookupVoucher.mockRejectedValueOnce(new Error("offline"));
    const writes = wsfe.issue.mock.calls.length;
    expect(
      await service(store, wsfe, second).issue(input, {
        ...represented,
        idempotencyKey: "sale-2",
      })
    ).toMatchObject({
      kind: "indeterminate",
      attempted: { number: 77 },
      lookup: { kind: "blocked", by: "sale-1", byTaxId: first },
    });
    expect(wsfe.issue).toHaveBeenCalledTimes(writes);
  });
  it.each([
    ["another key", "sale-2"],
    ["the same key", "sale-1"],
  ])(
    "never gives one issuer's key the CAE of %s from another issuer",
    async (_, key) => {
      const { wsfe } = provider();
      const store = createMemoryStore();
      const a = service(store, wsfe, first);
      await strand(a, wsfe, "sale-1");
      // The second issuer proves 77 is empty and supersedes the first one's key.
      expect(
        await service(store, wsfe, second).issue(input, {
          ...represented,
          idempotencyKey: key,
        })
      ).toMatchObject({ kind: "authorized", voucher: { number: 77 } });
      expect(
        JSON.parse(
          (await store.get(settledKey("test", first, "sale-1"))) ?? "null"
        )
      ).toMatchObject({ kind: "superseded", number: 77, by: key });
      const writes = wsfe.issue.mock.calls.length;
      const recovered = await a.recover("sale-1", represented);
      expect(recovered).toMatchObject({
        kind: "indeterminate",
        attempted: { number: 77 },
        lookup: { kind: "superseded", by: key, byTaxId: second },
      });
      expect(recovered).not.toHaveProperty("voucher");
      expect(wsfe.issue).toHaveBeenCalledTimes(writes);
    }
  );
  it("follows the succession into the other issuer's records", async () => {
    const { wsfe, land } = provider();
    const store = createMemoryStore();
    const a = service(store, wsfe, first);
    await strand(a, wsfe, "sale-1");
    // A writer outside the store takes 77 before the second issuer's write,
    // which records the conflict under its own CUIT.
    wsfe.issue.mockImplementationOnce(({ data }) => {
      land(77, data);
      return Promise.resolve(rejected10016);
    });
    expect(
      await service(store, wsfe, second).issue(input, {
        ...represented,
        idempotencyKey: "sale-2",
      })
    ).toMatchObject({ kind: "conflict", found: { number: 77 } });
    expect(
      JSON.parse(
        (await store.get(settledKey("test", first, "sale-1"))) ?? "null"
      )
    ).toMatchObject({ kind: "superseded", by: "sale-2", byTaxId: second });
    expect(await a.recover("sale-1", represented)).toMatchObject({
      kind: "conflict",
      attempted: { number: 77 },
      found: { number: 77 },
    });
  });
  it("reads a marker written before it named its issuer", async () => {
    const { wsfe } = provider();
    const store = createMemoryStore();
    const arca = service(store, wsfe);
    await strand(arca, wsfe, "sale-1");
    const sequence = sequenceKey("test", "30712345678", 1, 11);
    const { issuerTaxId: _, ...legacy } = JSON.parse(
      (await store.get(sequence)) ?? "null"
    ) as ArcaSequenceRecord;
    await store.set(sequence, JSON.stringify(legacy));
    // Without an issuer, the marker is read as the caller's own claim.
    wsfe.lookupVoucher.mockRejectedValueOnce(new Error("offline"));
    expect(
      await arca.issue(input, { ...represented, idempotencyKey: "sale-2" })
    ).toMatchObject({
      kind: "indeterminate",
      lookup: { kind: "blocked", by: "sale-1", byTaxId: first },
    });
  });
  it("names the caller as the successor of a record written before it named one", async () => {
    const { wsfe } = provider();
    const store = createMemoryStore();
    const a = service(store, wsfe, first);
    await strand(a, wsfe, "sale-1");
    await a.issue(input, { ...represented, idempotencyKey: "sale-2" });
    const settled = settledKey("test", first, "sale-1");
    const { byTaxId: _, ...legacy } = JSON.parse(
      (await store.get(settled)) ?? "null"
    );
    await store.set(settled, JSON.stringify(legacy));
    expect(await a.recover("sale-1", represented)).toMatchObject({
      kind: "indeterminate",
      lookup: { kind: "superseded", by: "sale-2", byTaxId: first },
    });
  });
  it("refuses a marker whose issuer is not a string", async () => {
    const { wsfe } = provider();
    const store = createMemoryStore();
    const arca = service(store, wsfe);
    await strand(arca, wsfe, "sale-1");
    const sequence = sequenceKey("test", "30712345678", 1, 11);
    const marker = JSON.parse((await store.get(sequence)) ?? "null");
    await store.set(
      sequence,
      JSON.stringify({ ...marker, issuerTaxId: 20_123 })
    );
    await expect(
      arca.issue(input, { ...represented, idempotencyKey: "sale-2" })
    ).rejects.toThrow("Invalid ARCA sequence record");
  });
  it("consults an unrepresented claim in the numbering it advanced", async () => {
    // The taxpayer issues with its own certificate, so its reservation names
    // no represented CUIT. An accountant representing it shares the store.
    const { wsfe } = provider();
    const store = createMemoryStore();
    const taxpayer = service(store, wsfe, "30712345678");
    wsfe.issue.mockImplementationOnce(() =>
      Promise.resolve({
        ...base,
        kind: "indeterminate" as const,
        reason: "transport_error" as const,
      })
    );
    wsfe.lookupVoucher.mockRejectedValueOnce(new Error("offline"));
    expect(
      (await taxpayer.issue(input, { idempotencyKey: "sale-1" })).kind
    ).toBe("indeterminate");
    // The accountant's own numbering holds another voucher at 77.
    const own = provider();
    const sent = wsfe.issue.mock.calls[0]?.[0].data as WsfeVoucherInput;
    own.land(77, {
      ...sent,
      totalAmount: 250,
      netAmount: 250,
    });
    const accountant = {
      ...wsfe,
      lookupVoucher: vi.fn(
        (request: { representedTaxId?: string | number; number: number }) =>
          request.representedTaxId === undefined
            ? own.wsfe.lookupVoucher(request)
            : wsfe.lookupVoucher(request)
      ),
    };
    expect(
      await service(store, accountant, first).issue(input, {
        ...represented,
        idempotencyKey: "sale-2",
      })
    ).toMatchObject({ kind: "authorized", voucher: { number: 77 } });
    expect(
      JSON.parse(
        (await store.get(settledKey("test", "30712345678", "sale-1"))) ?? "null"
      )
    ).toMatchObject({ kind: "superseded", by: "sale-2", byTaxId: first });
    expect(await taxpayer.recover("sale-1")).toMatchObject({
      kind: "indeterminate",
      lookup: { kind: "superseded", by: "sale-2", byTaxId: first },
    });
  });
  it("refuses a superseded record whose successor's issuer is not a string", async () => {
    const { wsfe } = provider();
    const store = createMemoryStore();
    const a = service(store, wsfe, first);
    await strand(a, wsfe, "sale-1");
    await service(store, wsfe, second).issue(input, {
      ...represented,
      idempotencyKey: "sale-2",
    });
    const settled = settledKey("test", first, "sale-1");
    const record = JSON.parse((await store.get(settled)) ?? "null");
    expect(record).toMatchObject({ kind: "superseded", byTaxId: second });
    await store.set(settled, JSON.stringify({ ...record, byTaxId: 20_987 }));
    await expect(a.recover("sale-1", represented)).rejects.toThrow(
      "Invalid ARCA settled record"
    );
  });
});

describe("claim durability", () => {
  const sequence = sequenceKey("test", "20123456789", 1, 11);
  const attempt = (key: string) => attemptKey("test", "20123456789", key);
  it("writes the sequence marker before the reservation", async () => {
    const { wsfe } = provider();
    const memory = createMemoryStore();
    // The connection drops on the marker write: nothing else may be written.
    const arca = service(
      failing(memory, {
        set: (key) => key.startsWith("arca:v1:sequence:"),
      }),
      wsfe
    );
    await expect(arca.issue(input, { idempotencyKey: "a" })).rejects.toThrow(
      "ARCA store operation failed."
    );
    expect(wsfe.issue).not.toHaveBeenCalled();
    expect(await memory.get(attempt("a"))).toBeNull();
    expect(await memory.get(sequence)).toBeNull();
    expect(await arca.issue(input, { idempotencyKey: "b" })).toMatchObject({
      kind: "authorized",
      voucher: { number: 77 },
    });
    await expect(arca.recover("a")).rejects.toMatchObject({
      code: "ARCA_INPUT_RESERVATION_NOT_FOUND",
      field: "idempotencyKey",
    });
    expect(await arca.issue(input, { idempotencyKey: "a" })).toMatchObject({
      kind: "authorized",
      recoveredByMatch: false,
      voucher: { number: 78 },
    });
  });
  it("hands over a number whose marker has no reservation", async () => {
    const { wsfe } = provider();
    const memory = createMemoryStore();
    // The connection drops between the marker and the reservation.
    const arca = service(
      failing(memory, { add: (key) => key.startsWith("arca:v1:attempt:") }),
      wsfe
    );
    await expect(arca.issue(input, { idempotencyKey: "a" })).rejects.toThrow(
      "ARCA store operation failed."
    );
    expect(wsfe.issue).not.toHaveBeenCalled();
    expect(JSON.parse((await memory.get(sequence)) ?? "null")).toMatchObject({
      key: "a",
      number: 77,
    });
    expect(await memory.get(attempt("a"))).toBeNull();
    // That key never submitted: the barrier clears without consulting ARCA.
    expect(await arca.issue(input, { idempotencyKey: "b" })).toMatchObject({
      kind: "authorized",
      voucher: { number: 77 },
    });
    expect(wsfe.lookupVoucher).not.toHaveBeenCalled();
    await expect(arca.recover("a")).rejects.toMatchObject({
      code: "ARCA_INPUT_RESERVATION_NOT_FOUND",
      field: "idempotencyKey",
    });
    expect(await arca.issue(input, { idempotencyKey: "a" })).toMatchObject({
      kind: "authorized",
      recoveredByMatch: false,
      voucher: { number: 78 },
    });
  });
  it("never lets a reservation lost before its submission take the next key's CAE", async () => {
    const { wsfe } = provider();
    const arca = service(createMemoryStore(), wsfe);
    // The process dies with the reservation written and the write never sent.
    wsfe.issue.mockRejectedValueOnce(new Error("process lost"));
    await expect(arca.issue(input, { idempotencyKey: "a" })).rejects.toThrow(
      "process lost"
    );
    // Same fiscal data under the next key: the barrier proves 77 is free.
    expect(await arca.issue(input, { idempotencyKey: "b" })).toMatchObject({
      kind: "authorized",
      recoveredByMatch: false,
      voucher: { number: 77 },
    });
    // The voucher at 77 is b's: a is told it was superseded, gets no CAE and
    // issues again under a new key.
    for (const outcome of [
      await arca.recover("a"),
      await arca.issue(input, { idempotencyKey: "a" }),
    ]) {
      expect(outcome).toMatchObject({
        kind: "indeterminate",
        attempted: { number: 77 },
        lookup: { kind: "superseded", by: "b" },
      });
      expect(outcome).not.toHaveProperty("voucher");
    }
    expect(wsfe.issue).toHaveBeenCalledTimes(2);
  });
  it("reads the sequence marker once per issuance", async () => {
    const { wsfe } = provider();
    const memory = createMemoryStore();
    const reads = vi.fn();
    const arca = service(
      {
        ...memory,
        get: (key) => {
          if (key === sequence) {
            reads();
          }
          return memory.get(key);
        },
      },
      wsfe
    );
    for (const idempotencyKey of ["a", "b"]) {
      reads.mockClear();
      expect((await arca.issue(input, { idempotencyKey })).kind).toBe(
        "authorized"
      );
      // The barrier reads it; the claim resolves the marker it just wrote.
      expect(reads).toHaveBeenCalledTimes(1);
    }
  });
  it("keeps the marker on the winner when a same-key call loses the race", async () => {
    const { wsfe } = provider();
    const store = createMemoryStore();
    const arca = service(store, wsfe);
    const outcomes = await Promise.all([
      arca.issue(input, { idempotencyKey: "sale" }),
      arca.issue(input, { idempotencyKey: "sale" }),
    ]);
    expect(outcomes.map((outcome) => outcome.kind)).toEqual([
      "authorized",
      "authorized",
    ]);
    expect(wsfe.issue).toHaveBeenCalledTimes(1);
    // The loser finds the reservation under the lock and never reads a
    // number it could have written into the marker.
    expect(wsfe.getNextVoucherNumber).toHaveBeenCalledTimes(1);
    expect(JSON.parse((await store.get(sequence)) ?? "null")).toMatchObject({
      key: "sale",
      number: 77,
      resolvedAt: expect.any(String),
    });
    expect(await arca.issue(input, { idempotencyKey: "next" })).toMatchObject({
      kind: "authorized",
      voucher: { number: 78 },
    });
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
        abortSignal: controller.signal,
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
      voucher: { number: 77, cae: "74123456789077" },
    });
  });
  it("rejects an options.abortSignal that is not an AbortSignal", async () => {
    const { wsfe } = provider();
    const arca = service(createMemoryStore(), wsfe);
    await expect(
      arca.issue(input, { abortSignal: {} as AbortSignal })
    ).rejects.toMatchObject({ code: "ARCA_INPUT_INVALID_VALUE" });
    expect(wsfe.issue).not.toHaveBeenCalled();
  });
});

/** A store whose first matching write fails, as a dropped connection would. */
function failing(
  store: ArcaStore,
  drop: { set?: (key: string) => boolean; add?: (key: string) => boolean }
): ArcaStore {
  let armed = true;
  const lost = () => {
    armed = false;
    return Promise.reject(new Error("connection lost"));
  };
  return {
    ...store,
    set: (key, value) =>
      armed && drop.set?.(key) ? lost() : store.set(key, value),
    add: (key, value) =>
      armed && drop.add?.(key) ? lost() : store.add(key, value),
  };
}

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

describe("rejections after an unanswered send", () => {
  const owner = "20123456789";
  /** The write reaches ARCA, its answer is lost and nothing can consult it. */
  function strand(provided: ReturnType<typeof provider>) {
    provided.wsfe.issue.mockImplementationOnce(({ data, voucherNumber }) => {
      provided.land(voucherNumber, data);
      return Promise.resolve({
        ...base,
        kind: "indeterminate" as const,
        reason: "transport_error" as const,
      });
    });
    provided.wsfe.lookupVoucher.mockRejectedValueOnce(new Error("offline"));
  }
  /** The retry's lookup lags behind the landed write; its consultation fails. */
  function lagThenFail(wsfe: ReturnType<typeof provider>["wsfe"]) {
    wsfe.lookupVoucher
      .mockImplementationOnce(() => Promise.resolve(absent))
      .mockRejectedValueOnce(new Error("offline"));
  }

  it.each([
    ["with withLock", () => createMemoryStore()],
    ["without withLock", () => withoutLock(createMemoryStore())],
  ])(
    "never marks a rejection that follows an unanswered claim (%s)",
    async (_, make) => {
      const provided = provider();
      const { wsfe } = provided;
      const store = make();
      const arca = service(store, wsfe);
      strand(provided);
      expect((await arca.issue(input, { idempotencyKey: "key1" })).kind).toBe(
        "indeterminate"
      );
      lagThenFail(wsfe);
      expect((await arca.issue(input, { idempotencyKey: "key1" })).kind).toBe(
        "rejected"
      );
      // The claim's write may have landed: the rejection is not every send's.
      expect(
        JSON.parse(
          (await store.get(attemptKey("test", owner, "key1"))) ?? "null"
        )
      ).not.toHaveProperty("rejectedAt");
      expect(await arca.issue(input, { idempotencyKey: "key1" })).toMatchObject(
        {
          kind: "authorized",
          recoveredByMatch: true,
          voucher: { number: 77 },
        }
      );
      expect(await store.get(settledKey("test", owner, "key1"))).toBeNull();
    }
  );
  it("lets recover() match the key's own voucher after that rejection", async () => {
    const provided = provider();
    const { wsfe } = provided;
    const store = createMemoryStore();
    const arca = service(store, wsfe);
    strand(provided);
    await arca.issue(input, { idempotencyKey: "key1" });
    lagThenFail(wsfe);
    await arca.issue(input, { idempotencyKey: "key1" });
    expect(await arca.recover("key1")).toMatchObject({
      kind: "authorized",
      recoveredByMatch: true,
      voucher: { number: 77 },
    });
    expect(await store.get(settledKey("test", owner, "key1"))).toBeNull();
  });
  it("never marks a rejection that follows an unanswered resend", async () => {
    const provided = provider();
    const { wsfe } = provided;
    const store = createMemoryStore();
    const arca = service(store, wsfe);
    wsfe.issue.mockImplementationOnce(() => Promise.resolve(rejectedRule));
    expect((await arca.issue(input, { idempotencyKey: "key1" })).kind).toBe(
      "rejected"
    );
    // The resend after the rejection lands, unanswered: 77 is empty when the
    // retry checks it, and the consultation after the write fails.
    wsfe.lookupVoucher.mockImplementationOnce(() => Promise.resolve(absent));
    strand(provided);
    expect((await arca.issue(input, { idempotencyKey: "key1" })).kind).toBe(
      "indeterminate"
    );
    lagThenFail(wsfe);
    expect((await arca.issue(input, { idempotencyKey: "key1" })).kind).toBe(
      "rejected"
    );
    expect(await arca.issue(input, { idempotencyKey: "key1" })).toMatchObject({
      kind: "authorized",
      recoveredByMatch: true,
      voucher: { number: 77 },
    });
    expect(await store.get(settledKey("test", owner, "key1"))).toBeNull();
  });
});

describe("recover() holds the sequence", () => {
  it("never gives an unanswered key the CAE of the key that takes its number", async () => {
    const { wsfe } = provider();
    const store = createMemoryStore();
    const arca = service(store, wsfe);
    // key1's write never reached ARCA, and nothing could consult it.
    wsfe.issue.mockImplementationOnce(() =>
      Promise.resolve({
        ...base,
        kind: "indeterminate" as const,
        reason: "transport_error" as const,
      })
    );
    wsfe.lookupVoucher.mockRejectedValueOnce(new Error("offline"));
    expect((await arca.issue(input, { idempotencyKey: "key1" })).kind).toBe(
      "indeterminate"
    );
    // recover() checks 77 and waits there, holding the sequence lock.
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const lookup = wsfe.lookupVoucher.getMockImplementation() as NonNullable<
      ReturnType<typeof wsfe.lookupVoucher.getMockImplementation>
    >;
    wsfe.lookupVoucher.mockImplementationOnce(async (call) => {
      await gate;
      return lookup(call);
    });
    const recovering = arca.recover("key1");
    await vi.waitFor(() => expect(wsfe.lookupVoucher).toHaveBeenCalledTimes(2));
    // key2 would find 77 empty, take it over and write it meanwhile.
    const taking = arca.issue(input, { idempotencyKey: "key2" });
    await Promise.race([
      taking,
      new Promise((resolve) => setTimeout(resolve, 50)),
    ]);
    open();
    expect(await recovering).toMatchObject({
      kind: "indeterminate",
      lookup: { kind: "not_found" },
    });
    expect(await taking).toMatchObject({
      kind: "authorized",
      voucher: { number: 77, cae: "74123456789077" },
    });
    expect(await arca.recover("key1")).not.toMatchObject({
      kind: "authorized",
    });
  });
});
describe("rejected retries without withLock", () => {
  const settled = settledKey("test", "20123456789", "key1");
  async function reject(
    arca: ReturnType<typeof service>,
    wsfe: ReturnType<typeof provider>["wsfe"]
  ) {
    wsfe.issue.mockImplementationOnce(() => Promise.resolve(rejectedRule));
    expect((await arca.issue(input, { idempotencyKey: "key1" })).kind).toBe(
      "rejected"
    );
  }
  function holdLookup(wsfe: ReturnType<typeof provider>["wsfe"]) {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const lookup = wsfe.lookupVoucher.getMockImplementation();
    wsfe.lookupVoucher.mockImplementationOnce(async (call) => {
      await gate;
      return (lookup as NonNullable<typeof lookup>)(call);
    });
    return open;
  }

  it("never records the key's own voucher as a conflict when two retries race", async () => {
    const { wsfe } = provider();
    const store = withoutLock(createMemoryStore());
    const arca = service(store, wsfe);
    await reject(arca, wsfe);
    const outcomes = await Promise.all([
      arca.issue(input, { idempotencyKey: "key1" }),
      arca.issue(input, { idempotencyKey: "key1" }),
    ]);
    expect(outcomes.map((outcome) => outcome.kind)).toContain("authorized");
    expect(await store.get(settled)).toBeNull();
    for (const outcome of [
      await arca.issue(input, { idempotencyKey: "key1" }),
      await arca.recover("key1"),
    ]) {
      expect(outcome).toMatchObject({
        kind: "authorized",
        recoveredByMatch: true,
        voucher: { number: 77, cae: "74123456789077" },
      });
    }
    expect(wsfe.issue).toHaveBeenCalledTimes(3);
  });

  it("never records the key's own voucher as a conflict when recover() races a retry", async () => {
    const { wsfe } = provider();
    const store = withoutLock(createMemoryStore());
    const arca = service(store, wsfe);
    await reject(arca, wsfe);
    // recover() reads the rejection, then its lookup waits while the retry
    // checks 77, clears the rejection and writes it.
    const open = holdLookup(wsfe);
    const recovering = arca.recover("key1");
    await vi.waitFor(() => expect(wsfe.lookupVoucher).toHaveBeenCalled());
    expect(await arca.issue(input, { idempotencyKey: "key1" })).toMatchObject({
      kind: "authorized",
      recoveredByMatch: false,
      voucher: { number: 77 },
    });
    open();
    await recovering;
    expect(await store.get(settled)).toBeNull();
    for (const outcome of [
      await arca.issue(input, { idempotencyKey: "key1" }),
      await arca.recover("key1"),
    ]) {
      expect(outcome).toMatchObject({
        kind: "authorized",
        recoveredByMatch: true,
        voucher: { number: 77, cae: "74123456789077" },
      });
    }
    expect(wsfe.issue).toHaveBeenCalledTimes(2);
  });

  it("never marks the key rejected when a concurrent retry's resend authorized", async () => {
    const { wsfe } = provider();
    const store = withoutLock(createMemoryStore());
    const arca = service(store, wsfe);
    await reject(arca, wsfe);
    // Both retries find 77 empty. The first resend is held until the second
    // one authorizes 77; it then gets 10016 and its consultation fails.
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const write = wsfe.issue.getMockImplementation() as NonNullable<
      ReturnType<typeof wsfe.issue.getMockImplementation>
    >;
    wsfe.issue.mockImplementationOnce(async (call) => {
      await gate;
      return write(call);
    });
    const first = arca.issue(input, { idempotencyKey: "key1" });
    await vi.waitFor(() => expect(wsfe.issue).toHaveBeenCalledTimes(2));
    expect(await arca.issue(input, { idempotencyKey: "key1" })).toMatchObject({
      kind: "authorized",
      voucher: { number: 77 },
    });
    wsfe.lookupVoucher.mockRejectedValueOnce(new Error("offline"));
    open();
    await first;
    for (const outcome of [
      await arca.issue(input, { idempotencyKey: "key1" }),
      await arca.recover("key1"),
    ]) {
      expect(outcome).toMatchObject({
        kind: "authorized",
        recoveredByMatch: true,
        voucher: { number: 77, cae: "74123456789077" },
      });
    }
    expect(wsfe.issue).toHaveBeenCalledTimes(3);
  });

  it("answers a stranger at a rejected number without keeping it", async () => {
    const { wsfe } = provider();
    const store = withoutLock(createMemoryStore());
    const arca = service(store, wsfe);
    await reject(arca, wsfe);
    expect(await arca.issue(input)).toMatchObject({ kind: "authorized" });
    const writes = wsfe.issue.mock.calls.length;
    for (const outcome of [
      await arca.issue(input, { idempotencyKey: "key1" }),
      await arca.recover("key1"),
      await arca.issue(input, { idempotencyKey: "key1" }),
    ]) {
      expect(outcome).toMatchObject({
        kind: "conflict",
        found: { number: 77 },
      });
    }
    // The rejection stays on the reservation, so every call checks again.
    expect(await store.get(settled)).toBeNull();
    expect(wsfe.issue).toHaveBeenCalledTimes(writes);
  });
  it("keeps the rejection of a resend that ARCA refused on its merits", async () => {
    const { wsfe } = provider();
    const store = withoutLock(createMemoryStore());
    const arca = service(store, wsfe);
    await reject(arca, wsfe);
    wsfe.issue.mockImplementationOnce(() => Promise.resolve(rejectedRule));
    expect((await arca.issue(input, { idempotencyKey: "key1" })).kind).toBe(
      "rejected"
    );
    // A keyless sale with the same data takes 77 afterwards.
    expect(await arca.issue(input)).toMatchObject({ kind: "authorized" });
    expect(await arca.issue(input, { idempotencyKey: "key1" })).toMatchObject({
      kind: "conflict",
      found: { number: 77 },
    });
  });
});

describe("settling what ARCA answered", () => {
  const owner = "20123456789";
  const stranded = () =>
    Promise.resolve({
      ...base,
      kind: "indeterminate" as const,
      reason: "transport_error" as const,
    });

  it("keeps the claim open after a rejection that follows an unanswered send", async () => {
    const { wsfe } = provider();
    const arca = service(createMemoryStore(), wsfe);
    wsfe.issue.mockImplementationOnce(stranded);
    wsfe.lookupVoucher.mockRejectedValueOnce(new Error("offline"));
    expect((await arca.issue(input, { idempotencyKey: "key1" })).kind).toBe(
      "indeterminate"
    );
    // The retry is refused on its merits, but the first send may still land.
    wsfe.issue.mockImplementationOnce(() => Promise.resolve(rejectedRule));
    expect((await arca.issue(input, { idempotencyKey: "key1" })).kind).toBe(
      "rejected"
    );
    // The next key must consult key1 before it takes 77.
    expect(await arca.issue(input, { idempotencyKey: "key2" })).toMatchObject({
      kind: "authorized",
      voucher: { number: 77 },
    });
    for (const outcome of [
      await arca.issue(input, { idempotencyKey: "key1" }),
      await arca.recover("key1"),
    ]) {
      expect(outcome).not.toMatchObject({ kind: "authorized" });
    }
  });
  /** The fresh claim waits inside its write while a retry of the same key writes 77 first. */
  async function raceOwnRetry(lookupFails: boolean) {
    const { wsfe } = provider();
    const store = withoutLock(createMemoryStore());
    const arca = service(store, wsfe);
    const write = wsfe.issue.getMockImplementation();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    wsfe.issue.mockImplementationOnce(async (call) => {
      entered();
      await gate;
      return (write as NonNullable<typeof write>)(call);
    });
    const claiming = arca.issue(input, { idempotencyKey: "key1" });
    await inside;
    expect(await arca.issue(input, { idempotencyKey: "key1" })).toMatchObject({
      kind: "authorized",
      voucher: { number: 77 },
    });
    if (lookupFails) {
      wsfe.lookupVoucher.mockRejectedValueOnce(new Error("offline"));
    }
    release();
    return { wsfe, store, arca, claiming };
  }
  it("never marks a claim's 10016 that races its own retry without withLock (the lookup fails)", async () => {
    const { store, arca, claiming } = await raceOwnRetry(true);
    await claiming;
    const later = [
      await arca.issue(input, { idempotencyKey: "key1" }),
      await arca.issue(input, { idempotencyKey: "key1" }),
      await arca.recover("key1"),
    ];
    expect(later.map((outcome) => outcome.kind)).toEqual([
      "authorized",
      "authorized",
      "authorized",
    ]);
    expect(await store.get(settledKey("test", owner, "key1"))).toBeNull();
  });
  it("leaves a claim's own voucher as a stored conflict when it races its own retry without withLock", async () => {
    const { wsfe, store, arca, claiming } = await raceOwnRetry(false);
    // A double submit without a lock leaves its own CAE as a conflict to
    // reconcile by hand, the safe failure.
    expect(await claiming).toMatchObject({
      kind: "conflict",
      found: { number: 77 },
    });
    const writes = wsfe.issue.mock.calls.length;
    for (const outcome of [
      await arca.issue(input, { idempotencyKey: "key1" }),
      await arca.recover("key1"),
    ]) {
      expect(outcome).toMatchObject({
        kind: "conflict",
        found: { number: 77 },
      });
    }
    expect(wsfe.issue).toHaveBeenCalledTimes(writes);
    expect(await store.get(settledKey("test", owner, "key1"))).not.toBeNull();
  });
  it("records the conflict recover() finds for a rejected key with withLock", async () => {
    const { wsfe } = provider();
    const store = createMemoryStore();
    const arca = service(store, wsfe);
    wsfe.issue.mockImplementationOnce(() => Promise.resolve(rejectedRule));
    await arca.issue(input, { idempotencyKey: "key1" });
    // A keyless sale takes 77.
    await arca.issue(input);
    expect((await arca.recover("key1")).kind).toBe("conflict");
    expect(await store.get(settledKey("test", owner, "key1"))).not.toBeNull();
  });
  it("records the conflict recover() finds for an unanswered key without withLock", async () => {
    const { wsfe } = provider();
    const store = withoutLock(createMemoryStore());
    const arca = service(store, wsfe);
    wsfe.issue.mockImplementationOnce(stranded);
    wsfe.lookupVoucher.mockRejectedValueOnce(new Error("offline"));
    expect((await arca.issue(input, { idempotencyKey: "key1" })).kind).toBe(
      "indeterminate"
    );
    // Another sale, with other data, takes 77.
    await arca.issue({ ...input, items: [{ amount: 250 }] });
    expect((await arca.recover("key1")).kind).toBe("conflict");
    expect(await store.get(settledKey("test", owner, "key1"))).not.toBeNull();
  });
});

describe("marking a rejection", () => {
  const owner = "20123456789";
  const reservation = attemptKey("test", owner, "key1");
  const rejectedAt = async (store: ArcaStore) => {
    const stored = await store.get(reservation);
    return (JSON.parse(stored as string) as { rejectedAt?: string }).rejectedAt;
  };

  it("marks a resend's 10016 with withLock even when the consultation fails", async () => {
    const { wsfe } = provider();
    const store = createMemoryStore();
    const arca = service(store, wsfe);
    wsfe.issue.mockImplementationOnce(() => Promise.resolve(rejectedRule));
    expect((await arca.issue(input, { idempotencyKey: "key1" })).kind).toBe(
      "rejected"
    );
    // The resend finds 77 empty, then gets 10016 and cannot consult it.
    wsfe.issue.mockImplementationOnce(() => Promise.resolve(rejected10016));
    wsfe.lookupVoucher.mockResolvedValueOnce(absent);
    wsfe.lookupVoucher.mockRejectedValueOnce(new Error("offline"));
    expect((await arca.issue(input, { idempotencyKey: "key1" })).kind).toBe(
      "rejected"
    );
    expect(await rejectedAt(store)).toBeDefined();
    // A keyless sale with the same data takes 77: it is a stranger's.
    await arca.issue(input);
    expect(await arca.issue(input, { idempotencyKey: "key1" })).toMatchObject({
      kind: "conflict",
      found: { number: 77 },
    });
  });

  it.each([
    { name: "with withLock", lock: true, marked: true },
    { name: "without withLock", lock: false, marked: false },
  ])(
    "marks a WSMTXCA first-send rejection $name: $marked",
    async ({ lock, marked }) => {
      const { wsfe } = provider();
      const wsmtxca = {
        getLastAuthorizedVoucher: vi.fn(() =>
          Promise.resolve({ voucherNumber: 76 })
        ),
        issue: vi.fn(() =>
          Promise.resolve({
            service: "wsmtxca" as const,
            operation: "autorizarComprobante",
            kind: "rejected" as const,
            result: "R" as const,
            resultLevel: "detail" as const,
            results: {},
            observations: [],
            errors: [
              {
                service: "wsmtxca" as const,
                operation: "autorizarComprobante",
                source: "error" as const,
                category: "business" as const,
                code: "1234",
                message: "invalid",
              },
            ],
          })
        ),
        lookupVoucher: vi.fn(() =>
          Promise.resolve({
            kind: "not_found" as const,
            service: "wsmtxca" as const,
            operation: "consultarComprobante",
            errors: [],
            observations: [],
            raw: {},
          })
        ),
      };
      const memory = createMemoryStore();
      const store = lock ? memory : withoutLock(memory);
      const arca = createVouchersService(
        wsfe,
        { store, environment: "test", taxId: owner },
        wsmtxca as never
      );
      const line = {
        description: "Product",
        quantity: 1,
        unit: 7,
        unitPrice: "100.000000",
        matrixCode: "7790001001054",
        matrixUnits: 1,
        net: 10_000,
        vat: 21,
      };
      const outcome = await arca.issue(
        {
          issuer: "responsable_inscripto",
          salesPoint: 1,
          date: "20260904",
          to: { condition: "responsable_inscripto", cuit: "20123456789" },
          items: [line],
        } as never,
        { service: "wsmtxca", idempotencyKey: "key1" }
      );
      expect(outcome.kind).toBe("rejected");
      expect(Boolean(await rejectedAt(memory))).toBe(marked);
    }
  );
});
