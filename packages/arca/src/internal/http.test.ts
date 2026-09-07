import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import https from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArcaTransportError } from "../errors";
import { postXml, postXmlWithMetadata } from "./http";
import { createArcaLogger } from "./logger";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("postXml", () => {
  it("sends SOAP requests and resolves successful responses", async () => {
    const capturedOptions: https.RequestOptions[] = [];
    vi.spyOn(https, "request").mockImplementation(
      createMockRequest({
        statusCode: 200,
        responseBody: "<soap>ok</soap>",
        captureRequestOptions: capturedOptions,
      })
    );

    const result = await postXml({
      url: "https://example.com/ws?ticket=1",
      body: "<request />",
      contentType: 'text/xml; charset="utf-8"',
      soapAction: "urn:test-action",
    });

    expect(result).toBe("<soap>ok</soap>");
    expect(capturedOptions[0]).toEqual(
      expect.objectContaining({
        protocol: "https:",
        hostname: "example.com",
        path: "/ws?ticket=1",
        method: "POST",
        headers: expect.objectContaining({
          Accept: "text/xml, application/soap+xml",
          "Content-Type": 'text/xml; charset="utf-8"',
          SOAPAction: '"urn:test-action"',
        }),
      })
    );
  });

  it("can return HTTP response metadata with XML bodies", async () => {
    vi.spyOn(https, "request").mockImplementation(
      createMockRequest({
        statusCode: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        responseBody: "<html />",
      })
    );

    await expect(
      postXmlWithMetadata({
        url: "https://example.com/ws",
        body: "<request />",
        contentType: 'text/xml; charset="utf-8"',
      })
    ).resolves.toEqual({
      body: "<html />",
      statusCode: 200,
      contentType: "text/html; charset=utf-8",
    });
  });

  it("switches the HTTP agent when legacy TLS mode is enabled", async () => {
    const capturedOptions: https.RequestOptions[] = [];
    vi.spyOn(https, "request").mockImplementation(
      createMockRequest({
        statusCode: 200,
        responseBody: "<soap>ok</soap>",
        captureRequestOptions: capturedOptions,
      })
    );

    await postXml({
      url: "https://example.com/ws",
      body: "<request />",
      contentType: 'text/xml; charset="utf-8"',
      useLegacyTlsSecurityLevel0: false,
    });
    await postXml({
      url: "https://example.com/ws",
      body: "<request />",
      contentType: 'text/xml; charset="utf-8"',
      useLegacyTlsSecurityLevel0: true,
    });

    expect(capturedOptions[0]?.agent).toBeDefined();
    expect(capturedOptions[1]?.agent).toBeDefined();
    expect(capturedOptions[0]?.agent).not.toBe(capturedOptions[1]?.agent);
  });

  it("resolves XML fault bodies even on HTTP 500", async () => {
    const responseBody =
      '<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>soap:Server</faultcode><faultstring>No existe</faultstring></soap:Fault></soap:Body></soap:Envelope>';

    vi.spyOn(https, "request").mockImplementation(
      createMockRequest({
        statusCode: 500,
        headers: { "content-type": "text/xml; charset=utf-8" },
        responseBody,
      })
    );

    await expect(
      postXml({
        url: "https://example.com/ws",
        body: "<request />",
        contentType: 'text/xml; charset="utf-8"',
      })
    ).resolves.toBe(responseBody);
  });

  it("keeps non-XML HTTP 500 responses as transport errors", async () => {
    const responseBody = `upstream exploded\n<ns:Token>token-value</ns:Token><Sign>sign-value</Sign>${"x".repeat(5000)}`;
    const log = vi.fn();
    vi.spyOn(https, "request").mockImplementation(
      createMockRequest({
        statusCode: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
        responseBody,
      })
    );

    const error = await postXml({
      url: "https://example.com/ws",
      body: "<request />",
      contentType: 'text/xml; charset="utf-8"',
      logger: createArcaLogger({ level: "error", log }),
      service: "wsfe",
      operation: "FEParamGetPtosVenta",
    }).catch((caughtError: unknown) => caughtError);

    expect(error).toMatchObject({
      name: "ArcaTransportError",
      statusCode: 500,
      contentType: "text/plain; charset=utf-8",
      responseBodyLength: responseBody.length,
    });
    expect(error).not.toHaveProperty("responseBody");
    expect((error as ArcaTransportError).responseBodyPreview).toHaveLength(
      4096
    );
    expect((error as ArcaTransportError).responseBodyPreview).toContain(
      "<ns:Token>[REDACTED]</ns:Token>"
    );
    expect((error as ArcaTransportError).responseBodyPreview).toContain(
      "<Sign>[REDACTED]</Sign>"
    );
    expect(JSON.stringify(error)).not.toContain("token-value");
    expect(JSON.stringify(error)).not.toContain("sign-value");
    expect(log).toHaveBeenCalledWith(
      "error",
      "ARCA transport request failed",
      expect.objectContaining({
        service: "wsfe",
        operation: "FEParamGetPtosVenta",
        errorName: "ArcaTransportError",
        errorCode: "ARCA_TRANSPORT_ERROR",
        statusCode: 500,
        responseBodyLength: responseBody.length,
        responseBodyPreview: expect.any(String),
      })
    );
    const loggerMetadata = log.mock.calls[0]?.[2];
    expect(loggerMetadata).not.toHaveProperty("error");
    expect(JSON.stringify(loggerMetadata)).not.toContain("token-value");
    expect(JSON.stringify(loggerMetadata)).not.toContain("sign-value");
  });

  it("retries transport failures with a fixed delay", async () => {
    vi.useFakeTimers();

    const log = vi.fn();
    const requestSpy = vi
      .spyOn(https, "request")
      .mockImplementationOnce(
        createMockRequest({
          statusCode: 200,
          responseBody: "",
          failWithRequestError: new Error("connection reset"),
        })
      )
      .mockImplementationOnce(
        createMockRequest({
          statusCode: 200,
          responseBody: "",
          failWithRequestError: new Error("connection reset"),
        })
      )
      .mockImplementationOnce(
        createMockRequest({
          statusCode: 200,
          responseBody: "<soap>ok</soap>",
        })
      );

    const responsePromise = postXml({
      url: "https://example.com/ws",
      body: "<request />",
      contentType: 'text/xml; charset="utf-8"',
      retries: 2,
      retryDelay: 500,
      logger: createArcaLogger({
        level: "warn",
        log,
      }),
      service: "wsfe",
      operation: "FEParamGetPtosVenta",
    });

    await Promise.resolve();
    expect(requestSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(499);
    expect(requestSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    expect(requestSpy).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(499);
    expect(requestSpy).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    await expect(responsePromise).resolves.toBe("<soap>ok</soap>");
    expect(requestSpy).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledWith(
      "warn",
      "Retrying ARCA request after transport failure (attempt 2/3)",
      expect.objectContaining({
        service: "wsfe",
        operation: "FEParamGetPtosVenta",
        attempt: 2,
        attempts: 3,
      })
    );
    for (const [, , metadata] of log.mock.calls) {
      expect(metadata).not.toHaveProperty("error");
      expect(metadata).toMatchObject({
        errorName: "ArcaTransportError",
        errorCode: "ARCA_TRANSPORT_ERROR",
      });
    }
    expect(log).toHaveBeenCalledWith(
      "warn",
      "Retrying ARCA request after transport failure (attempt 3/3)",
      expect.objectContaining({
        service: "wsfe",
        operation: "FEParamGetPtosVenta",
        attempt: 3,
        attempts: 3,
      })
    );
  });

  it("does not retry XML responses returned with HTTP errors", async () => {
    const responseBody =
      '<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>soap:Server</faultcode><faultstring>No existe</faultstring></soap:Fault></soap:Body></soap:Envelope>';

    const requestSpy = vi.spyOn(https, "request").mockImplementation(
      createMockRequest({
        statusCode: 500,
        headers: { "content-type": "text/xml; charset=utf-8" },
        responseBody,
      })
    );

    await expect(
      postXml({
        url: "https://example.com/ws",
        body: "<request />",
        contentType: 'text/xml; charset="utf-8"',
        retries: 2,
        retryDelay: 500,
      })
    ).resolves.toBe(responseBody);
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects when the response stream errors", async () => {
    vi.spyOn(https, "request").mockImplementation(
      createMockRequest({
        statusCode: 200,
        responseBody: "<partial",
        failWithResponseError: new Error("socket closed"),
      })
    );

    await expect(
      postXml({
        url: "https://example.com/ws",
        body: "<request />",
        contentType: 'text/xml; charset="utf-8"',
      })
    ).rejects.toMatchObject({
      name: "ArcaTransportError",
      statusCode: 200,
      responseBodyLength: 8,
      responseBodyPreview: "<partial",
    });
  });

  it("rejects when the response is aborted", async () => {
    vi.spyOn(https, "request").mockImplementation(
      createMockRequest({
        statusCode: 200,
        responseBody: "<partial",
        abortResponse: true,
      })
    );

    await expect(
      postXml({
        url: "https://example.com/ws",
        body: "<request />",
        contentType: 'text/xml; charset="utf-8"',
      })
    ).rejects.toMatchObject({
      name: "ArcaTransportError",
      message: "ARCA HTTP response was aborted",
      statusCode: 200,
      responseBodyLength: 8,
      responseBodyPreview: "<partial",
    });
  });

  it("aborts an in-flight request with the caller's deadline", async () => {
    const destroyed: (Error | undefined)[] = [];
    vi.spyOn(https, "request").mockImplementation(
      createMockRequest({
        statusCode: 200,
        responseBody: "",
        hangs: true,
        captureDestroy: destroyed,
      })
    );

    const controller = new AbortController();
    const pending = postXml({
      url: "https://example.com/ws",
      body: "<request />",
      contentType: 'text/xml; charset="utf-8"',
      retries: 3,
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      name: "ArcaTransportError",
      message: "ARCA HTTP request was aborted",
    });
    expect(destroyed).toHaveLength(1);
  });

  it("never opens a request for an already aborted deadline", async () => {
    const request = vi.spyOn(https, "request");

    await expect(
      postXml({
        url: "https://example.com/ws",
        body: "<request />",
        contentType: 'text/xml; charset="utf-8"',
        signal: AbortSignal.abort(),
      })
    ).rejects.toMatchObject({
      name: "ArcaTransportError",
      message: "ARCA HTTP request was aborted",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects when the request fails before a response arrives", async () => {
    vi.spyOn(https, "request").mockImplementation(
      createMockRequest({
        statusCode: 200,
        responseBody: "",
        failWithRequestError: new Error("connection refused"),
      })
    );

    await expect(
      postXml({
        url: "https://example.com/ws",
        body: "<request />",
        contentType: 'text/xml; charset="utf-8"',
      })
    ).rejects.toMatchObject({
      name: "ArcaTransportError",
      message: "ARCA HTTP request failed",
      cause: expect.objectContaining({ message: "connection refused" }),
    });
  });

  it("uses the configured timeout for request timeouts", async () => {
    const capturedTimeoutMs: number[] = [];
    vi.spyOn(https, "request").mockImplementation(
      createMockRequest({
        statusCode: 200,
        responseBody: "",
        triggerTimeout: true,
        captureTimeoutMs: capturedTimeoutMs,
      })
    );

    const error = await postXml({
      url: "https://example.com/ws",
      body: "<request />",
      contentType: 'text/xml; charset="utf-8"',
      timeout: 1234,
    }).catch((caughtError) => caughtError);

    expect(error).toBeInstanceOf(ArcaTransportError);
    expect(capturedTimeoutMs).toEqual([1234]);
    assert.match(
      (error as ArcaTransportError).message,
      /ARCA HTTP request timed out after 1234ms/
    );
  });
});

function createMockRequest(options: {
  statusCode: number;
  headers?: Record<string, string>;
  responseBody: string;
  captureRequestOptions?: https.RequestOptions[];
  failWithRequestError?: Error;
  failWithResponseError?: Error;
  abortResponse?: boolean;
  hangs?: boolean;
  triggerTimeout?: boolean;
  captureTimeoutMs?: number[];
  captureDestroy?: (Error | undefined)[];
}): typeof https.request {
  return ((
    requestOptions: https.RequestOptions,
    callback?: (response: EventEmitter) => void
  ) => {
    options.captureRequestOptions?.push(requestOptions);

    let timeoutListener: (() => void) | undefined;
    const request = new EventEmitter() as EventEmitter & {
      write: (chunk: string | Buffer) => void;
      end: () => void;
      destroy: (error?: Error) => void;
      setTimeout: (timeoutMs: number, listener?: () => void) => void;
    };

    request.write = () => undefined;
    request.destroy = (error?: Error) => {
      options.captureDestroy?.push(error);
      if (error) {
        process.nextTick(() => request.emit("error", error));
      }
    };
    request.setTimeout = (timeoutMs: number, listener?: () => void) => {
      options.captureTimeoutMs?.push(timeoutMs);
      timeoutListener = listener;
    };
    request.end = () => {
      if (options.failWithRequestError) {
        process.nextTick(() =>
          request.emit("error", options.failWithRequestError)
        );
        return;
      }

      if (options.hangs) {
        return;
      }

      if (options.triggerTimeout) {
        process.nextTick(() => timeoutListener?.());
        return;
      }

      const response = new EventEmitter() as EventEmitter & {
        statusCode?: number;
        headers: Record<string, string>;
      };

      response.statusCode = options.statusCode;
      response.headers = options.headers ?? {};

      process.nextTick(() => {
        callback?.(response);
        response.emit("data", Buffer.from(options.responseBody, "utf8"));
        if (options.failWithResponseError) {
          response.emit("error", options.failWithResponseError);
          return;
        }
        if (options.abortResponse) {
          response.emit("aborted");
          return;
        }
        response.emit("end");
      });
    };

    return request as never;
  }) as unknown as typeof https.request;
}
