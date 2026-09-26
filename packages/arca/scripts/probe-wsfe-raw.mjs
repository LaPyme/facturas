#!/usr/bin/env node
import fs from "node:fs";
import https from "node:https";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));

if (args["env-file"]) {
  loadEnvFile(String(args["env-file"]));
}

const environment = readChoice(args.env, ["production", "test"], "production");
const operation = readChoice(args.operation, ["last", "lookup"], "last");
const representedTaxId = readRequired(args["represented-tax-id"]);
const salesPoint = readPositiveInteger(args["sales-point"], "sales-point");
const voucherType = readPositiveInteger(args["voucher-type"], "voucher-type");
const voucherNumber =
  operation === "lookup"
    ? readPositiveInteger(args["voucher-number"], "voucher-number")
    : null;

installWsfeRawResponseProbe();

const { createArcaClient } = await import("../dist/index.mjs");

const client = createArcaClient({
  taxId: readEnv(
    environment === "production" ? "ARCA_CUIT_PROD" : "ARCA_CUIT_TEST"
  ),
  certificatePem: readPemEnv(
    environment === "production" ? "ARCA_CERT_PROD" : "ARCA_CERT_TEST"
  ),
  privateKeyPem: readPemEnv(
    environment === "production" ? "ARCA_KEY_PROD" : "ARCA_KEY_TEST"
  ),
  environment,
});

console.log(
  JSON.stringify(
    {
      probe: "wsfe-raw",
      environment,
      operation,
      representedTaxId,
      salesPoint,
      voucherType,
      voucherNumber,
    },
    null,
    2
  )
);

try {
  if (operation === "lookup") {
    const result = await client.wsfe.lookupVoucher({
      representedTaxId,
      salesPoint,
      voucherType,
      number: voucherNumber,
    });
    console.log(JSON.stringify({ ok: true, result }, null, 2));
  } else {
    const nextVoucherNumber = await client.wsfe.getNextVoucherNumber({
      representedTaxId,
      salesPoint,
      voucherType,
    });
    console.log(
      JSON.stringify(
        {
          ok: true,
          nextVoucherNumber,
          lastAuthorizedVoucherNumber: nextVoucherNumber - 1,
        },
        null,
        2
      )
    );
  }
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        name: error?.name,
        code: error?.code,
        message: error instanceof Error ? error.message : String(error),
        statusCode: error?.statusCode,
        responseBodyLength: error?.responseBodyLength,
        responseBodyPreview: error?.responseBodyPreview,
        issues: error?.issues,
      },
      null,
      2
    )
  );
  process.exitCode = 1;
}

function installWsfeRawResponseProbe() {
  const originalRequest = https.request;

  https.request = function patchedRequest(input, options, callback) {
    let requestOptions = options;
    let requestCallback = callback;

    if (typeof options === "function") {
      requestCallback = options;
      requestOptions = undefined;
    }

    const target = resolveRequestUrl(input, requestOptions);
    const wrappedCallback =
      typeof requestCallback === "function"
        ? (response) => {
            captureWsfeResponse(target, response);
            requestCallback(response);
          }
        : (response) => {
            captureWsfeResponse(target, response);
          };

    if (requestOptions === undefined) {
      return originalRequest.call(https, input, wrappedCallback);
    }

    return originalRequest.call(https, input, requestOptions, wrappedCallback);
  };
}

function captureWsfeResponse(target, response) {
  if (!target.includes("/wsfev1/")) {
    return;
  }

  const chunks = [];
  response.on("data", (chunk) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  });
  response.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    console.error(
      JSON.stringify(
        {
          probe: "raw-wsfe-response",
          url: target,
          statusCode: response.statusCode,
          contentType: response.headers["content-type"],
          bodyLength: Buffer.byteLength(body),
          bodyPreview: preview(body),
        },
        null,
        2
      )
    );
  });
}

function resolveRequestUrl(input, options) {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }

  const protocol = input?.protocol ?? options?.protocol ?? "https:";
  const hostname =
    input?.hostname ?? input?.host ?? options?.hostname ?? options?.host ?? "";
  const port = input?.port ?? options?.port;
  const requestPath = input?.path ?? options?.path ?? "/";
  return `${protocol}//${hostname}${port ? `:${port}` : ""}${requestPath}`;
}

function readEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function readPemEnv(name) {
  const value = readEnv(name);
  if (value.includes("-----BEGIN ")) {
    return value;
  }
  return Buffer.from(value, "base64").toString("utf8");
}

function readRequired(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Missing required argument");
  }
  return value.trim();
}

function readPositiveInteger(value, name) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid --${name}: ${value}`);
  }
  return parsed;
}

function readChoice(value, choices, fallback) {
  const normalized = String(value ?? fallback);
  if (!choices.includes(normalized)) {
    throw new Error(`Expected one of ${choices.join(", ")}, got ${normalized}`);
  }
  return normalized;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function loadEnvFile(filePath) {
  const absolutePath = path.resolve(process.cwd(), filePath);
  const content = fs.readFileSync(absolutePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf("=");
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
}

function preview(value) {
  return value
    .replace(
      /<((?:[A-Za-z_][\w.-]*:)?(?:Token|Sign))\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      (_match, tagName) => `<${tagName}>[redacted]</${tagName}>`
    )
    .slice(0, 2000);
}
