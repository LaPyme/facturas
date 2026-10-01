import { createHash } from "node:crypto";
import { ArcaConfigurationError } from "../errors";
import type { ArcaEnvironment } from "../internal/types";
import type { WsfeVoucherInput } from "../services/wsfe";

/** What a caller may pass to `withLock`: a signal that stops the wait. */
export type ArcaLockOptions = { signal?: AbortSignal };

/**
 * Durable values. add must atomically create only when the key is absent.
 * withLock runs `fn` exclusively across processes. `options.signal` only stops
 * the wait: an abort before the lock is taken throws `ArcaLockTimeoutError`
 * with `reason: "aborted"` and never runs `fn`.
 */
export type ArcaStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  add(key: string, value: string): Promise<boolean>;
  delete?(key: string): Promise<void>;
  withLock?<T>(
    key: string,
    fn: () => Promise<T>,
    options?: ArcaLockOptions
  ): Promise<T>;
};

/**
 * Reservation record. Version 1 is a plain WSFE reservation, readable by every
 * release since 0.9. Version 2 carries a WSMTXCA provider or detailed items and
 * always names its `service`, so an older reader refuses it instead of
 * replaying a WSMTXCA reservation through WSFE. Version 2 has three compatible
 * line spellings: releases through 0.12 wrote `details`; 0.13 writes `lines`,
 * or `authorizedLines` when a full note mirrors provider-authorized history.
 *
 * `rejectedAt` marks a reservation whose every submission ARCA rejected, so
 * this key never wrote its number and any voucher found there is a
 * stranger's. It is the one field rewritten with `set`: cleared before a
 * retry resends the number and written again only if ARCA rejects that send
 * too. A rejection that follows a submission left without an answer is not
 * marked, since that write may still land: the reservation stays pending and
 * its retries match a voucher there by its fiscal fields.
 * Readers that predate it ignore it and match a voucher there by its fiscal
 * fields, so every process sharing a store must run a release that knows it.
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
    lines?: readonly import("../services/issuance-wsmtxca").WsmtxcaLine[];
    authorizedLines?: readonly import("../services/issuance-wsmtxca").WsmtxcaLine[];
    details?: readonly import("../services/issuance-wsmtxca").LegacyWsmtxcaLine[];
  };
  createdAt: string;
  rejectedAt?: string;
};

/**
 * Settled outcome of a reservation, created once with `add` and never
 * rewritten. A `conflict` records the voucher found at the reserved number, which without
 * `withLock` can be this key's own after a double submit. A
 * `superseded` record says the sequence moved past this reservation: the
 * barrier proved the number was empty and handed it to `by`, so this key can
 * never write. Authorizations are not recorded, because ARCA is their source of
 * truth, and rejections live on the reservation as `rejectedAt`, because a
 * retry may still write the number. A reader that does not know a future
 * `kind` refuses the record instead of guessing.
 */
export type ArcaSettledRecord =
  | {
      /** Version 1 stored `found` in ARCA's units; version 2 stores it normalized. */
      v: 1 | 2;
      kind: "conflict";
      number: number;
      found: import("../services/wsfe-identity").VoucherSummary;
      settledAt: string;
    }
  | {
      v: 1;
      kind: "superseded";
      number: number;
      by: string;
      /** The CUIT `by` was claimed under. Without it, `by` shares this issuer. */
      byTaxId?: string;
      settledAt: string;
    };

export function attemptKey(
  environment: ArcaEnvironment,
  taxId: string,
  key: string
): string {
  return `arca:v1:attempt:${environment}:${taxId}:${key}`;
}

/**
 * The last reservation claimed on one sequence through this store, written
 * with `set` under the sequence lock and before the reservation it names, so
 * no reservation can exist that the barrier does not see. `resolvedAt` marks a
 * claim whose fate ARCA already reported, on its first submission or on a
 * retry, so the next claim needs no consultation. A rejected key takes the
 * marker back, unresolved, before it resends its number. Only an unanswered
 * claim stays unresolved.
 */
export type ArcaSequenceRecord = {
  v: 1;
  key: string;
  /**
   * The issuer's CUIT: `key` names a reservation under it. Several issuers may
   * represent the taxpayer that owns the sequence. A marker without it names
   * the caller's own reservation.
   */
  issuerTaxId?: string;
  number: number;
  claimedAt: string;
  resolvedAt?: string;
};

export function sequenceKey(
  environment: ArcaEnvironment,
  taxId: string,
  salesPoint: number,
  voucherType: number
): string {
  return `arca:v1:sequence:${environment}:${taxId}:${salesPoint}:${voucherType}`;
}

export function sequenceLockKey(
  environment: ArcaEnvironment,
  taxId: string,
  salesPoint: number,
  voucherType: number
): string {
  return `arca:v1:lock:sequence:${environment}:${taxId}:${salesPoint}:${voucherType}`;
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
