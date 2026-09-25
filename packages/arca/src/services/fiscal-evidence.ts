import type { ArcaAuthenticationReason } from "../errors";

/** The ARCA service a call targets. It is chosen explicitly, never switched. */
export type IssuanceService = "wsfe" | "wsmtxca";

/** Location of a structured authorization result in the service response. */
export type ArcaFiscalResultLevel = "header" | "detail" | "operation";

/** Every structured result field exposed by one provider response. */
export type ArcaFiscalResults = {
  header?: string;
  detail?: string;
  operation?: string;
};

/** Source and meaning of one provider issue. */
export type ArcaFiscalIssue = {
  service: IssuanceService;
  operation: string;
  source: "error" | "observation";
  category: "business" | "infrastructure" | "observation" | "unknown";
  code?: string;
  message: string;
  resultLevel?: ArcaFiscalResultLevel;
};

/** Why an authorization response cannot prove approval or rejection. */
export type ArcaAuthorizationIndeterminateReason =
  | "authentication_rejected"
  | "transport_error"
  | "soap_fault"
  | "invalid_response"
  | "incomplete_response"
  | "contradictory_response"
  | "unexpected_error";

/** Safe authentication evidence attached to an exact authorization outcome. */
export type ArcaAuthenticationEvidence = {
  code: "ARCA_AUTHENTICATION_ERROR";
  reason: ArcaAuthenticationReason;
  providerCode?: string | number;
};

type ArcaAuthorizationEvidenceBase<
  TService extends IssuanceService = IssuanceService,
> = {
  service: TService;
  operation: string;
  results: ArcaFiscalResults;
  errors: ArcaFiscalIssue[];
  observations: ArcaFiscalIssue[];
  raw?: Record<string, unknown>;
};

/** Structured evidence returned by one exact voucher authorization attempt. */
export type ArcaAuthorizationOutcome<
  TService extends IssuanceService = IssuanceService,
> =
  | (ArcaAuthorizationEvidenceBase<TService> & {
      kind: "authorized";
      result: "A" | "O";
      resultLevel: ArcaFiscalResultLevel;
      cae: string;
      caeExpiry?: string;
      voucherNumber: number;
    })
  | (ArcaAuthorizationEvidenceBase<TService> & {
      kind: "rejected";
      result: "R";
      resultLevel: ArcaFiscalResultLevel;
    })
  | (ArcaAuthorizationEvidenceBase<TService> & {
      kind: "indeterminate";
      reason: ArcaAuthorizationIndeterminateReason;
      authentication?: ArcaAuthenticationEvidence;
      result?: string;
      resultLevel?: ArcaFiscalResultLevel;
      cae?: string;
      caeExpiry?: string;
      voucherNumber?: number;
    });

/** Structured result of consulting one exact voucher number. */
export type ArcaVoucherLookupResult<
  TVoucher,
  TService extends IssuanceService = IssuanceService,
> =
  | {
      kind: "found";
      service: TService;
      operation: string;
      voucher: TVoucher;
      observations: ArcaFiscalIssue[];
      raw: Record<string, unknown>;
    }
  | {
      kind: "not_found";
      service: TService;
      operation: string;
      errors: ArcaFiscalIssue[];
      observations: ArcaFiscalIssue[];
      raw: Record<string, unknown>;
    };
