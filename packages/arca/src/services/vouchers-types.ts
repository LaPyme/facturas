import type { VoucherClass } from "../constants";
import type { ArcaSafeErrorMetadata } from "../errors";
import type {
  ArcaAuthorizationOutcome,
  ArcaFiscalIssue,
  IssuanceService,
} from "./fiscal-evidence";
import type { WsfeVoucherInput } from "./wsfe";
import type { IssueAmounts } from "./wsfe-amounts";
import type { VoucherCoordinates, VoucherSummary } from "./wsfe-identity";

/**
 * The normalized fiscal fields shared by previews and authorized vouchers.
 * Dates are `YYYY-MM-DD`; `exchangeRate` is an exact decimal string. Service
 * dates are absent for product-only documents. `paymentDueDate` is absent when
 * the fiscal document has no due date.
 */
export type FiscalHeader = {
  /** ARCA concept: products (1), services (2), or both (3). */
  concept: 1 | 2 | 3;
  documentType: number;
  documentNumber: string;
  receiverVatConditionId: number;
  currencyId: string;
  exchangeRate?: string;
  serviceStartDate?: string;
  serviceEndDate?: string;
  paymentDueDate?: string;
};

export type IssueOptions = {
  service?: "wsfe" | "wsmtxca";
  /** An externally reserved number. Never reads the next number when supplied. */
  number?: number;
  idempotencyKey?: string;
  representedTaxId?: number | string;
  forceRefresh?: boolean;
  include?: { request?: boolean; rawResponse?: boolean };
  /**
   * The caller's deadline. It aborts the WSAA login, the submission and every
   * consultation of this call. An abort after the write was sent answers
   * `indeterminate` with `lookup.kind === "aborted"`: the reservation stays and
   * `recover()` settles it.
   */
  abortSignal?: AbortSignal;
};

/** Dates are `YYYY-MM-DD` and money is in minor units, like the input. */
export type IssuedVoucher = VoucherCoordinates & {
  voucherClass: VoucherClass;
  date: string;
  header: FiscalHeader;
  cae: string;
  caeExpiry: string;
  amounts: IssueAmounts;
  /**
   * The URL the printed voucher's QR must encode, per ARCA's specification.
   * Absent only if ARCA answered a CAE the specification cannot encode: an
   * authorization is never lost over its QR.
   */
  qr?: string;
};

export type ServiceFor<O extends IssueOptions> = "service" extends keyof O
  ? "wsmtxca" extends O["service"]
    ? O extends { service: "wsmtxca" }
      ? "wsmtxca"
      : IssuanceService
    : "wsfe"
  : "wsfe";
export type IssueRequest<S extends IssuanceService = "wsfe"> =
  S extends "wsmtxca"
    ? import("./issuance-wsmtxca").WsmtxcaIssueRequest
    : WsfeVoucherInput;
/**
 * What issue() would send, derived with zero I/O. The voucher number is absent
 * because it is only known when the number is reserved at issuance.
 */
export type IssuePreview<S extends IssuanceService = "wsfe"> = {
  voucherClass: VoucherClass;
  voucherType: number;
  header: FiscalHeader;
  amounts: IssueAmounts;
  request: IssueRequest<S>;
  service?: S;
};

type WithRawResponse<T, O extends IssueOptions> = T &
  (true extends NonNullable<O["include"]>["rawResponse"]
    ? { rawResponse?: Record<string, unknown> }
    : unknown);
type WithRequest<O extends IssueOptions> = O extends {
  include: { request: true };
}
  ? {
      request: IssueRequest<ServiceFor<O>>;
    }
  : true extends NonNullable<O["include"]>["request"]
    ? {
        request?: IssueRequest<ServiceFor<O>>;
      }
    : unknown;
type Evidence<
  K extends ArcaAuthorizationOutcome["kind"],
  O extends IssueOptions,
> = WithRawResponse<
  Omit<Extract<ArcaAuthorizationOutcome<ServiceFor<O>>, { kind: K }>, "raw">,
  O
>;

/** Fiscal outcomes are returned. Keyed replays authorize only after not_found. */
export type IssueOutcome<O extends IssueOptions = { include?: never }> = (
  | {
      kind: "authorized";
      recoveredByMatch: false;
      voucher: IssuedVoucher;
      authorization: Evidence<"authorized", O>;
    }
  | {
      kind: "authorized";
      recoveredByMatch: true;
      voucher: IssuedVoucher;
      attempt: Evidence<"indeterminate", O>;
      lookup: WithRawResponse<VoucherSummary, O>;
    }
  | {
      kind: "rejected";
      attempted: VoucherCoordinates;
      issues: ArcaFiscalIssue[];
      authorization: Evidence<"rejected", O>;
    }
  | {
      kind: "indeterminate";
      attempted: VoucherCoordinates;
      attempt: Evidence<"indeterminate", O>;
      lookup:
        | WithRawResponse<{ kind: "not_found" }, O>
        | WithRawResponse<{ kind: "incomplete"; reason: string }, O>
        | { kind: "failed"; error: ArcaSafeErrorMetadata }
        /** The caller's deadline fired; the reservation stays for recover(). */
        | { kind: "aborted" }
        /** An unresolved claim holds this sequence; resolve `by` and retry. */
        | { kind: "blocked"; by: string }
        /** The sequence moved past this key: it can never write. Use a new one. */
        | { kind: "superseded"; by: string };
    }
  | {
      kind: "conflict";
      attempted: VoucherCoordinates;
      attempt: Evidence<"indeterminate", O>;
      found: WithRawResponse<VoucherSummary, O>;
      reason: string;
    }
) &
  WithRequest<O>;
