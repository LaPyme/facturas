import type { VoucherClass } from "../constants";
import type { ArcaSafeErrorMetadata } from "../errors";
import type {
  ArcaAuthorizationOutcome,
  ArcaFiscalIssue,
} from "./fiscal-evidence";
import type { WsfeVoucherInput } from "./wsfe";
import type { IssueAmounts } from "./wsfe-amounts";
import type { VoucherCoordinates, VoucherSummary } from "./wsfe-identity";

export type IssueOptions = {
  idempotencyKey?: string;
  representedTaxId?: number | string;
  forceRefresh?: boolean;
  include?: { raw?: boolean; exactInput?: boolean };
};

export type IssuedVoucher = VoucherCoordinates & {
  voucherClass: VoucherClass;
  date: string;
  cae: string;
  caeExpiry: string;
  amounts: IssueAmounts;
};

type WithRaw<T, O extends IssueOptions> = T &
  (true extends NonNullable<O["include"]>["raw"]
    ? { raw?: Record<string, unknown> }
    : unknown);
type WithSent<O extends IssueOptions> = O extends {
  include: { exactInput: true };
}
  ? { sent: WsfeVoucherInput }
  : true extends NonNullable<O["include"]>["exactInput"]
    ? { sent?: WsfeVoucherInput }
    : unknown;
type Evidence<
  K extends ArcaAuthorizationOutcome<"wsfe">["kind"],
  O extends IssueOptions,
> = WithRaw<
  Omit<Extract<ArcaAuthorizationOutcome<"wsfe">, { kind: K }>, "raw">,
  O
>;

/** Fiscal outcomes are returned. Keyed replays authorize only after not_found. */
export type IssueOutcome<O extends IssueOptions = { include?: never }> =
  | ({
      kind: "authorized";
      recoveredByMatch: false;
      voucher: IssuedVoucher;
      authorization: Evidence<"authorized", O>;
    } & WithSent<O>)
  | ({
      kind: "authorized";
      recoveredByMatch: true;
      voucher: IssuedVoucher;
      attempt: Evidence<"indeterminate", O>;
      lookup: WithRaw<VoucherSummary, O>;
    } & WithSent<O>)
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
        | WithRaw<{ kind: "not_found" }, O>
        | WithRaw<{ kind: "incomplete"; reason: string }, O>
        | { kind: "failed"; error: ArcaSafeErrorMetadata };
    }
  | {
      kind: "conflict";
      attempted: VoucherCoordinates;
      attempt: Evidence<"indeterminate", O>;
      found: WithRaw<VoucherSummary, O>;
      reason: string;
    };
