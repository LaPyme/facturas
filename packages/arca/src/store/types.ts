import { createHash } from "node:crypto";
import { ArcaConfigurationError } from "../errors";
import type { ArcaEnvironment } from "../internal/types";
import type { WsfeVoucherInput } from "../services/wsfe";

/** Durable values. add must atomically create only when the key is absent. */
export type ArcaStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  add(key: string, value: string): Promise<boolean>;
  delete?(key: string): Promise<void>;
  withLock?<T>(key: string, fn: () => Promise<T>): Promise<T>;
};

/**
 * Reservation record. Version 1 is a plain WSFE reservation, readable by every
 * release since 0.9. Version 2 carries a WSMTXCA provider or detailed items and
 * always names its `service`, so an older reader refuses it instead of
 * replaying a WSMTXCA reservation through WSFE.
 */
export type ArcaAttemptRecord = {
  v: 1 | 2;
  operation: "issue" | "creditNote" | "debitNote";
  service?: "wsfe" | "wsmtxca";
  representedTaxId?: string;
  salesPoint: number;
  voucherType: number;
  number: number;
  inputHash: string;
  sent: WsfeVoucherInput & {
    details?: readonly import("../services/issuance-wsmtxca").VoucherItemDetail[];
  };
  createdAt: string;
};

/**
 * Settled outcome of a reservation, created once with `add` and never
 * rewritten. Only conflicts are recorded: ARCA remains the source of truth for
 * an authorization, and a rejection may be fixed under a new key. A later
 * reader that does not know a future `kind` refuses the record instead of
 * guessing.
 */
export type ArcaSettledRecord = {
  v: 1;
  kind: "conflict";
  number: number;
  found: import("../services/wsfe-identity").VoucherSummary;
  settledAt: string;
};

export function attemptKey(
  environment: ArcaEnvironment,
  taxId: string,
  key: string
): string {
  return `arca:v1:attempt:${environment}:${taxId}:${key}`;
}

export function settledKey(
  environment: ArcaEnvironment,
  taxId: string,
  key: string
): string {
  return `arca:v1:settled:${environment}:${taxId}:${key}`;
}

export function canonicalHash(input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(input)))
    .digest("hex");
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value instanceof Date) {
    return value.toJSON();
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)])
    );
  }
  return value;
}

export async function storeCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (cause) {
    throw new ArcaConfigurationError("ARCA store operation failed.", { cause });
  }
}
