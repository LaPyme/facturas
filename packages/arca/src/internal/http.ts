import https from "node:https";
import { ArcaTransportError } from "../errors";
import type { ArcaLogger } from "./logger";
import {
  createResponseBodyDiagnostic,
  createSafeErrorDiagnostic,
} from "./redaction";

const defaultAgent = new https.Agent({
  keepAlive: true,
});

const legacyTlsAgent = new https.Agent({
  keepAlive: true,
  ciphers: "DEFAULT@SECLEVEL=0",
});

type PostXmlOptions = {
  url: string;
  body: string;
  contentType: string;
  soapAction?: string;
  useLegacyTlsSecurityLevel0?: boolean;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
  logger?: ArcaLogger;
  service?: string;
  operation?: string;
  signal?: AbortSignal;
};

export type PostXmlResponse = {
  body: string;
  statusCode?: number;
  contentType?: string;
};

export async function postXml({ ...options }: PostXmlOptions): Promise<string> {
  const response = await postXmlWithMetadata(options);
  return response.body;
}

export async function postXmlWithMetadata({
  url,
  body,
  contentType,
  soapAction,
  useLegacyTlsSecurityLevel0 = false,
  timeout = 30_000,
  retries = 0,
  retryDelay = 500,
  logger,
  service,
  operation,
  signal,
}: PostXmlOptions): Promise<PostXmlResponse> {
  const totalAttempts = retries + 1;
  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    try {
      return await postXmlOnce({
        url,
        body,
        contentType,
        soapAction,
        useLegacyTlsSecurityLevel0,
        timeout,
        signal,
      });
    } catch (error) {
      if (!(error instanceof ArcaTransportError)) {
        throw error;
      }

      // An aborted call is the caller's deadline, never a transient failure.
      if (attempt >= totalAttempts || signal?.aborted) {
        logger?.error("ARCA transport request failed", {
          service,
          operation,
          url,
          attempt,
          attempts: totalAttempts,
          ...createSafeErrorDiagnostic(error),
        });
        throw error;
      }

      const nextAttempt = attempt + 1;
      logger?.warn(
        `Retrying ARCA request after transport failure (attempt ${nextAttempt}/${totalAttempts})`,
        {
          service,
          operation,
          url,
          attempt: nextAttempt,
          attempts: totalAttempts,
          ...createSafeErrorDiagnostic(error),
        }
      );
      await delay(retryDelay);
    }
  }

  throw new ArcaTransportError("ARCA HTTP request exhausted retries");
}

async function postXmlOnce({
  url,
  body,
  contentType,
  soapAction,
  useLegacyTlsSecurityLevel0,
  timeout,
  signal,
}: Required<
  Pick<
    PostXmlOptions,
    "url" | "body" | "contentType" | "useLegacyTlsSecurityLevel0" | "timeout"
  >
> &
  Pick<PostXmlOptions, "soapAction" | "signal">): Promise<PostXmlResponse> {
  const endpoint = new URL(url);
  const requestBody = Buffer.from(body, "utf8");
  if (signal?.aborted) {
    throw new ArcaTransportError("ARCA HTTP request was aborted", {
      cause: signal.reason,
    });
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    const settleResolve = (response: PostXmlResponse) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(response);
    };
    const settleReject = (error: ArcaTransportError) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };
    const request = https.request(
      {
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port || undefined,
        path: `${endpoint.pathname}${endpoint.search}`,
        method: "POST",
        agent: useLegacyTlsSecurityLevel0 ? legacyTlsAgent : defaultAgent,
        headers: {
          Accept: "text/xml, application/soap+xml",
          "Content-Length": requestBody.byteLength,
          "Content-Type": contentType,
          ...(soapAction === undefined
            ? {}
            : { SOAPAction: `"${soapAction}"` }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        const getResponseBody = () => Buffer.concat(chunks).toString("utf8");

        response.on("data", (chunk: Buffer | string) => {
          chunks.push(
            typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk
          );
        });

        response.on("error", (error) => {
          settleReject(
            new ArcaTransportError("ARCA HTTP response stream failed", {
              cause: error,
              statusCode: response.statusCode,
              ...createResponseBodyDiagnostic(getResponseBody()),
            })
          );
        });

        response.on("aborted", () => {
          settleReject(
            new ArcaTransportError("ARCA HTTP response was aborted", {
              statusCode: response.statusCode,
              ...createResponseBodyDiagnostic(getResponseBody()),
            })
          );
        });

        response.on("end", () => {
          const responseBody = getResponseBody();
          const statusCode = response.statusCode ?? 500;
          const responseContentType = Array.isArray(
            response.headers["content-type"]
          )
            ? response.headers["content-type"].join("; ")
            : response.headers["content-type"];

          if (statusCode >= 200 && statusCode < 300) {
            settleResolve({
              body: responseBody,
              statusCode,
              contentType: responseContentType,
            });
            return;
          }

          // SOAP services commonly return structured fault payloads with HTTP
          // 500. Let higher layers parse those XML faults instead of forcing a
          // transport error here.
          if (isXmlLikeResponse(responseBody, responseContentType)) {
            settleResolve({
              body: responseBody,
              statusCode,
              contentType: responseContentType,
            });
            return;
          }

          settleReject(
            new ArcaTransportError(
              `ARCA HTTP request failed with status ${statusCode}`,
              {
                statusCode,
                contentType: responseContentType,
                ...createResponseBodyDiagnostic(responseBody),
              }
            )
          );
        });
      }
    );

    request.setTimeout(timeout, () => {
      const timeoutCause = new Error(
        `ARCA HTTP request timed out after ${timeout}ms`
      );
      settleReject(
        new ArcaTransportError(
          `ARCA HTTP request timed out after ${timeout}ms`,
          { cause: timeoutCause }
        )
      );
      request.destroy(timeoutCause);
    });

    request.on("error", (error) => {
      settleReject(
        new ArcaTransportError("ARCA HTTP request failed", {
          cause: error,
        })
      );
    });

    const abort = () => {
      const cause = new Error("ARCA HTTP request was aborted");
      settleReject(
        new ArcaTransportError("ARCA HTTP request was aborted", { cause })
      );
      request.destroy(cause);
    };
    signal?.addEventListener("abort", abort, { once: true });
    request.on("close", () => signal?.removeEventListener("abort", abort));

    request.write(requestBody);
    request.end();
  });
}

function isXmlLikeResponse(body: string, contentType?: string): boolean {
  const normalizedContentType = contentType?.toLowerCase() ?? "";
  if (
    normalizedContentType.includes("xml") ||
    normalizedContentType.includes("soap")
  ) {
    return true;
  }

  return body.trimStart().startsWith("<");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
