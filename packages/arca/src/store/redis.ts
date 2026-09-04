import { ArcaConfigurationError } from "../errors";
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
    options: { nx: true }
  ) => Promise<unknown>;
  return {
    get: (key) =>
      storeCall(async () => {
        const value = await client.get(key);
        if (value === null) {
          return null;
        }
        // Upstash can deserialize stored JSON automatically.
        return typeof value === "string" ? value : JSON.stringify(value);
      }),
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
        }
      : {}),
  };
}
