import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
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

/**
 * A WSAA ticket authorizes fiscal work for twelve hours, so it never reaches
 * the store in clear. The key is derived from the private key the client
 * already holds: whoever has that PEM can log in on their own, so wrapping the
 * ticket with it adds no exposure and asks for no second secret.
 */
export type WsaaStoreAdapterSecret = { privateKeyPem: string };

const KEY_PREFIX = "arca:v2:wsaa:";
/**
 * Where releases before 0.15 kept the ticket in clear. A valid one is resealed
 * under the v2 key on first read, because ARCA refuses a second login while it
 * lives (`coe.alreadyAuthenticated`), and the lock stays on this key so a
 * mixed-version rollout still serializes its logins.
 */
const LEGACY_KEY_PREFIX = "arca:v1:wsaa:";
const HKDF_SALT = "facturas:wsaa:v2";
const RECORD_VERSION = 2;

type SealedRecord = {
  v: typeof RECORD_VERSION;
  iv: string;
  data: string;
  tag: string;
};

export function createWsaaStoreAdapter(
  store: ArcaStore,
  secret: WsaaStoreAdapterSecret
): ArcaWsaaSessionStore {
  const key = (value: ArcaWsaaSessionKey) =>
    `${KEY_PREFIX}${serializeWsaaSessionKey(value)}`;
  const legacyKey = (value: ArcaWsaaSessionKey) =>
    `${LEGACY_KEY_PREFIX}${serializeWsaaSessionKey(value)}`;
  const remove = store.delete?.bind(store);
  const lock = store.withLock?.bind(store);
  const write = (value: ArcaWsaaSessionKey, credentials: ArcaAuthCredentials) =>
    store.set(
      key(value),
      seal(JSON.stringify(credentials), cipherKey(secret, value))
    );
  return {
    get: (value) =>
      storeCall(async () => {
        const json = await store.get(key(value));
        if (json !== null) {
          return usable(open(json, cipherKey(secret, value)));
        }
        const legacy = usable(parseClear(await store.get(legacyKey(value))));
        if (legacy) {
          await write(value, legacy);
          await remove?.(legacyKey(value));
        }
        return legacy;
      }),
    set: (value, credentials) => storeCall(() => write(value, credentials)),
    ...(remove
      ? {
          delete: (value: ArcaWsaaSessionKey) =>
            storeCall(() => remove(key(value))),
        }
      : {}),
    ...(lock
      ? {
          withLock: <T>(value: ArcaWsaaSessionKey, fn: () => Promise<T>) =>
            lock(legacyKey(value), fn),
        }
      : {}),
  };
}

function usable(
  credentials: ArcaAuthCredentials | null
): ArcaAuthCredentials | null {
  return credentials &&
    typeof credentials.token === "string" &&
    typeof credentials.sign === "string" &&
    isWsaaCredentialValid(credentials)
    ? credentials
    : null;
}

function parseClear(json: string | null): ArcaAuthCredentials | null {
  if (json === null) {
    return null;
  }
  try {
    return JSON.parse(json) as ArcaAuthCredentials;
  } catch {
    return null;
  }
}

/** One key per session key, so a ticket sealed for one certificate opens for no other. */
function cipherKey(
  secret: WsaaStoreAdapterSecret,
  value: ArcaWsaaSessionKey
): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      secret.privateKeyPem,
      HKDF_SALT,
      serializeWsaaSessionKey(value),
      32
    )
  );
}

function seal(plaintext: string, cipherKey: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", cipherKey, iv);
  const data = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const record: SealedRecord = {
    v: RECORD_VERSION,
    iv: iv.toString("base64url"),
    data: data.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
  return JSON.stringify(record);
}

/** Anything that does not open cleanly is a cache miss, never a throw. */
function open(json: string, cipherKey: Buffer): ArcaAuthCredentials | null {
  try {
    const record = JSON.parse(json) as Partial<SealedRecord> | null;
    if (
      !record ||
      record.v !== RECORD_VERSION ||
      typeof record.iv !== "string" ||
      typeof record.data !== "string" ||
      typeof record.tag !== "string"
    ) {
      return null;
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      cipherKey,
      Buffer.from(record.iv, "base64url")
    );
    decipher.setAuthTag(Buffer.from(record.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(record.data, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext) as ArcaAuthCredentials;
  } catch {
    return null;
  }
}
