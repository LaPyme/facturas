import { ArcaConfigurationError } from "../errors";
import { ARCA_LEASE_MS, withLease } from "./lock";
import { type ArcaStore, storeCall } from "./types";

type RedisClient = {
  get(key: string): Promise<unknown>;
  set(key: string, value: string): Promise<unknown>;
  call?(...args: string[]): Promise<unknown>;
  del?(key: string): Promise<unknown>;
};
/** Uses ioredis or Upstash without importing either driver. */
export function createRedisStore(
  client: RedisClient,
  options: { flavor?: "ioredis" | "upstash" } = {}
): ArcaStore {
  const flavor =
    options.flavor ??
    (typeof client.call === "function" ? "ioredis" : "upstash");
  if (flavor === "ioredis" && !client.call) {
    throw new ArcaConfigurationError(
      "ARCA Redis ioredis flavor requires client.call."
    );
  }
  // The public structural type accepts ioredis's overloaded set method.
  // Only the Upstash flavor invokes its options-object overload.
  const upstashSet = client.set as (
    key: string,
    value: string,
    options: { nx?: true; xx?: true; px?: number }
  ) => Promise<unknown>;
  const read = async (key: string) => {
    const value = await client.get(key);
    if (value === null || value === undefined) {
      return null;
    }
    // Upstash can deserialize stored JSON automatically.
    return typeof value === "string" ? value : JSON.stringify(value);
  };
  // A lease, so a crashed holder frees the key; a renewal keeps a live one.
  const lease = (key: string, owner: string, mode: "nx" | "xx") =>
    storeCall(
      async () =>
        (flavor === "ioredis"
          ? await client.call?.(
              "SET",
              key,
              owner,
              mode.toUpperCase(),
              "PX",
              String(ARCA_LEASE_MS)
            )
          : await upstashSet.call(client, key, owner, {
              [mode]: true,
              px: ARCA_LEASE_MS,
            })) === "OK"
    );
  return {
    get: (key) => storeCall(() => read(key)),
    set: (key, value) =>
      storeCall(async () => {
        await client.set(key, value);
      }),
    add: (key, value) =>
      storeCall(
        async () =>
          (flavor === "ioredis"
            ? await client.call?.("SET", key, value, "NX")
            : await upstashSet.call(client, key, value, { nx: true })) === "OK"
      ),
    ...(client.del
      ? {
          delete: (key: string) =>
            storeCall(async () => {
              await client.del?.(key);
            }),
          withLock: <T>(key: string, fn: () => Promise<T>) =>
            withLease(
              key,
              {
                acquire: (owner) => lease(key, owner, "nx"),
                renew: async (owner) => {
                  // Check and set: only the holder extends its own lease.
                  if ((await storeCall(() => read(key))) === owner) {
                    await lease(key, owner, "xx");
                  }
                },
                release: async (owner) => {
                  await storeCall(async () => {
                    if ((await read(key)) === owner) {
                      await client.del?.(key);
                    }
                  });
                },
              },
              fn
            ),
        }
      : {}),
  };
}
