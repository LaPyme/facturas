import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createArcaClient } from "../client";
import { ArcaConfigurationError } from "../errors";
import { createWsaaStoreAdapter } from "../wsaa/store-adapter";
import { createFileStore } from "./file";
import { createMemoryStore } from "./memory";
import { createPostgresStore } from "./postgres";
import { createRedisStore } from "./redis";
import { type ArcaStore, canonicalHash } from "./types";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});
function postgres(array = false) {
  const values = new Map<string, string>();
  const query = vi.fn((sql: string, params: string[]) => {
    const [key, value] = params;
    let rows: { key?: string; value?: string }[] = [];
    if (sql.startsWith("SELECT")) {
      rows = values.has(key) ? [{ value: values.get(key) }] : [];
    }
    if (sql.includes("DO NOTHING") && !values.has(key)) {
      values.set(key, value);
      rows = [{ key }];
    }
    if (sql.includes("DO UPDATE")) {
      values.set(key, value);
    }
    if (sql.startsWith("DELETE")) {
      values.delete(key);
    }
    return Promise.resolve(array ? rows : { rows });
  });
  return { query, store: createPostgresStore({ query }) };
}
function redis(flavor: "upstash" | "ioredis") {
  const values = new Map<string, string>();
  const set = vi.fn((key: string, value: string, options?: { nx: true }) => {
    if (options?.nx && values.has(key)) {
      return Promise.resolve(null);
    }
    values.set(key, value);
    return Promise.resolve("OK");
  });
  const call = vi.fn(
    (_command: string, key: string, value: string, _nx: string) =>
      set(key, value, { nx: true })
  );
  const client = {
    get: (key: string) => Promise.resolve(values.get(key) ?? null),
    set,
    ...(flavor === "ioredis" ? { call } : {}),
    del: (key: string) => Promise.resolve(values.delete(key)),
  };
  return { set, call, store: createRedisStore(client) };
}
const factories: [string, () => ArcaStore | Promise<ArcaStore>][] = [
  ["memory", createMemoryStore],
  [
    "file",
    async () => {
      const path = await mkdtemp(join(tmpdir(), "arca-store-"));
      directories.push(path);
      return createFileStore(path);
    },
  ],
  ["postgres rows", () => postgres().store],
  ["postgres array", () => postgres(true).store],
  ["upstash", () => redis("upstash").store],
  ["ioredis", () => redis("ioredis").store],
];
for (const [name, factory] of factories) {
  describe(name, () => {
    it("implements the atomic key/value contract", async () => {
      const store = await factory();
      expect(await store.get("a")).toBeNull();
      expect(await store.add("a", "first")).toBe(true);
      expect(await store.add("a", "second")).toBe(false);
      expect(await store.get("a")).toBe("first");
      await store.set("a", "third");
      expect(await store.get("a")).toBe("third");
      await store.delete?.("a");
      expect(await store.get("a")).toBeNull();
      expect(
        (
          await Promise.all(
            Array.from({ length: 10 }, () => store.add("race", "value"))
          )
        ).filter(Boolean)
      ).toHaveLength(1);
    });
  });
}
it("uses parameterized SQL and validates the table", async () => {
  const { query, store } = postgres();
  await store.add("key'", "private");
  expect(query).toHaveBeenCalledWith(
    'INSERT INTO "arca_store" (key, value) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING key',
    ["key'", "private"]
  );
  expect(() =>
    createPostgresStore({ query, table: "x; DROP TABLE x" })
  ).toThrow(ArcaConfigurationError);
});
it("uses each Redis NX protocol and allows a flavor override", async () => {
  const io = redis("ioredis");
  await io.store.add("k", "v");
  expect(io.call).toHaveBeenCalledWith("SET", "k", "v", "NX");
  const up = redis("upstash");
  await up.store.add("k", "v");
  expect(up.set).toHaveBeenCalledWith("k", "v", { nx: true });
  const call = vi.fn();
  const set = vi.fn().mockResolvedValue("OK");
  await createRedisStore(
    { get: vi.fn(), set, call },
    { flavor: "upstash" }
  ).add("k", "v");
  expect(call).not.toHaveBeenCalled();
});
it("wraps driver failure without exposing values", async () => {
  const cause = new Error("secret record");
  await expect(
    createPostgresStore({ query: () => Promise.reject(cause) }).add(
      "secret-key",
      "secret-value"
    )
  ).rejects.toMatchObject({
    name: "ArcaConfigurationError",
    message: "ARCA store operation failed.",
    cause,
  });
});
it("serializes memory locks and releases after failures", async () => {
  const store = createMemoryStore();
  const order: number[] = [];
  await Promise.all([
    store.withLock?.("k", async () => {
      await Promise.resolve();
      order.push(1);
    }),
    store.withLock?.("k", () => {
      order.push(2);
      return Promise.resolve();
    }),
  ]);
  expect(order).toEqual([1, 2]);
  await expect(
    store.withLock?.("k", () => Promise.reject(new Error("fail")))
  ).rejects.toThrow("fail");
  expect(await store.withLock?.("k", () => Promise.resolve(3))).toBe(3);
});
it("adapts namespaced WSAA credentials and expiry", async () => {
  const store = createMemoryStore();
  const lock = vi.spyOn(store, "withLock");
  const adapter = createWsaaStoreAdapter(store);
  const key = {
    environment: "test" as const,
    service: "wsfe" as const,
    certificateFingerprint: "fingerprint",
  };
  const credentials = {
    token: "token",
    sign: "sign",
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  };
  await adapter.set(key, credentials);
  expect(await adapter.get(key)).toEqual(credentials);
  expect(await store.get("arca:v1:wsaa:test:wsfe:fingerprint")).toBe(
    JSON.stringify(credentials)
  );
  await adapter.withLock?.(key, () => Promise.resolve());
  expect(lock).toHaveBeenCalledWith(
    "arca:v1:wsaa:test:wsfe:fingerprint",
    expect.any(Function)
  );
  await adapter.set(key, {
    ...credentials,
    expiresAt: new Date(0).toISOString(),
  });
  expect(await adapter.get(key)).toBeNull();
});
it("discovers credentials without mutating the environment", () => {
  vi.stubEnv("ARCA_TAX_ID", "20123456789");
  vi.stubEnv("ARCA_CERTIFICATE_PEM", "-----BEGIN CERTIFICATE-----\ncert");
  vi.stubEnv("ARCA_PRIVATE_KEY_PEM", "-----BEGIN PRIVATE KEY-----\nkey");
  vi.stubEnv("ARCA_ENVIRONMENT", "PRODUCTION");
  expect(createArcaClient().config.environment).toBe("production");
  expect(createArcaClient({ store: createMemoryStore() }).config.taxId).toBe(
    "20123456789"
  );
  expect(
    createArcaClient({ taxId: "20987654321", environment: "test" }).config.taxId
  ).toBe("20987654321");
  expect(process.env.ARCA_ENVIRONMENT).toBe("PRODUCTION");
  vi.stubEnv("ARCA_TAX_ID", undefined);
  expect(() => createArcaClient()).toThrow("taxId (ARCA_TAX_ID)");
});
it("canonicalizes objects without reordering arrays", () => {
  expect(canonicalHash({ b: 1, a: { z: 2, x: undefined } })).toBe(
    canonicalHash({ a: { z: 2 }, b: 1 })
  );
  expect(canonicalHash([1, 2])).not.toBe(canonicalHash([2, 1]));
});
