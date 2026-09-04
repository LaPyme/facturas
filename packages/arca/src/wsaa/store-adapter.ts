import type {
  ArcaAuthCredentials,
  ArcaWsaaSessionKey,
  ArcaWsaaSessionStore,
} from "../internal/types";
import { type ArcaStore, storeCall } from "../store/types";
import {
  isWsaaCredentialValid,
  serializeWsaaSessionKey,
} from "./session-store";

export function createWsaaStoreAdapter(store: ArcaStore): ArcaWsaaSessionStore {
  const key = (value: ArcaWsaaSessionKey) =>
    `arca:v1:wsaa:${serializeWsaaSessionKey(value)}`;
  const remove = store.delete?.bind(store);
  const lock = store.withLock?.bind(store);
  return {
    get: (value) =>
      storeCall(async () => {
        const json = await store.get(key(value));
        if (json === null) {
          return null;
        }
        const credentials = JSON.parse(json) as ArcaAuthCredentials;
        return credentials &&
          typeof credentials.token === "string" &&
          typeof credentials.sign === "string" &&
          isWsaaCredentialValid(credentials)
          ? credentials
          : null;
      }),
    set: (value, credentials) =>
      storeCall(() => store.set(key(value), JSON.stringify(credentials))),
    ...(remove
      ? {
          delete: (value: ArcaWsaaSessionKey) =>
            storeCall(() => remove(key(value))),
        }
      : {}),
    ...(lock
      ? {
          withLock: <T>(value: ArcaWsaaSessionKey, fn: () => Promise<T>) =>
            lock(key(value), fn),
        }
      : {}),
  };
}
