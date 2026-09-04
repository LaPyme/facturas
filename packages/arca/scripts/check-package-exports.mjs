#!/usr/bin/env node
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const publicErrorClasses = [
  "ArcaError",
  "ArcaConfigurationError",
  "ArcaInputError",
  "ArcaAuthenticationError",
  "ArcaTransportError",
  "ArcaSoapFaultError",
  "ArcaInvalidSoapResponseError",
  "ArcaServiceError",
];

const entrypoints = [
  [
    "facturas",
    [
      "createArcaClient",
      "createPostgresStore",
      "createRedisStore",
      "createFileStore",
      "createMemoryStore",
      "buildFacturaB",
      "buildFacturaC",
      "matchWsfeVoucherIdentity",
      "toArcaSafeErrorMetadata",
      "ARCA_FINAL_CONSUMER_IDENTIFICATION_THRESHOLD_MINOR_UNITS",
      ...publicErrorClasses,
      "isArcaAuthenticationError",
    ],
  ],
  [
    "facturas/constants",
    ["ARCA_VOUCHER_TYPES", "ISO_CURRENCIES", "ARCA_CURRENCY_IDS"],
  ],
  ["facturas/errors", [...publicErrorClasses, "isArcaAuthenticationError"]],
  ["facturas/padron", ["createPadronService"]],
  ["facturas/types", []],
  ["facturas/wsfe", ["createWsfeService", "buildFacturaB", "buildFacturaC"]],
  ["facturas/wsmtxca", ["createWsmtxcaService"]],
];

const importedEntrypoints = new Map();

for (const [specifier, runtimeExports] of entrypoints) {
  const imported = await import(specifier);
  importedEntrypoints.set(specifier, imported);

  for (const runtimeExport of runtimeExports) {
    if (!(runtimeExport in imported)) {
      throw new Error(
        `Expected ${specifier} ESM import to expose ${runtimeExport}.`
      );
    }
  }

  try {
    const required = require(specifier);

    for (const runtimeExport of runtimeExports) {
      if (!(runtimeExport in required)) {
        throw new Error(
          `Expected ${specifier} require() to expose ${runtimeExport}.`
        );
      }
    }
  } catch (error) {
    if (
      error?.code !== "ERR_REQUIRE_ESM" &&
      error?.code !== "ERR_REQUIRE_ASYNC_MODULE"
    ) {
      throw error;
    }
  }
}

const root = importedEntrypoints.get("facturas");
const errors = importedEntrypoints.get("facturas/errors");
const wsfe = importedEntrypoints.get("facturas/wsfe");
const wsmtxca = importedEntrypoints.get("facturas/wsmtxca");

for (const errorClass of publicErrorClasses) {
  if (root[errorClass] !== errors[errorClass]) {
    throw new Error(
      `Expected facturas and facturas/errors to share ${errorClass} identity.`
    );
  }
}

const wsfeInputError = captureThrown(
  () =>
    wsfe.createWsfeService(createServiceOptions()).authorizeVoucher({
      data: createWsfeVoucherInput({ receiverVatConditionId: undefined }),
      voucherNumber: 1,
    }),
  "facturas/wsfe ArcaInputError"
);
assertErrorIdentity(wsfeInputError, "ArcaInputError", "facturas/wsfe");

const wsmtxcaInputError = await captureRejected(
  () =>
    wsmtxca.createWsmtxcaService(createServiceOptions()).authorizeVoucher({
      data: {
        authRequest: { token: "caller-token", sign: "caller-sign" },
        comprobanteCAERequest: { numeroComprobante: 1 },
      },
    }),
  "facturas/wsmtxca ArcaInputError"
);
assertErrorIdentity(wsmtxcaInputError, "ArcaInputError", "facturas/wsmtxca");

const wsfeAuthenticationError = await captureRejected(
  () =>
    wsfe
      .createWsfeService(
        createServiceOptions(async () => ({
          result: {
            FECAESolicitarResponse: {
              FECAESolicitarResult: {
                Errors: {
                  Err: {
                    Code: 600,
                    Msg: "No se corresponden token y firma",
                  },
                },
              },
            },
          },
        }))
      )
      .authorizeVoucher({ data: createWsfeVoucherInput(), voucherNumber: 1 }),
  "facturas/wsfe ArcaAuthenticationError"
);
assertAuthenticationErrorIdentity(wsfeAuthenticationError, "facturas/wsfe");

const wsmtxcaAuthenticationError = await captureRejected(
  () =>
    wsmtxca
      .createWsmtxcaService(
        createServiceOptions(async () => ({
          result: {
            autorizarComprobanteResponse: {
              resultado: "R",
              arrayErrores: {
                codigoDescripcion: {
                  codigo: 1000,
                  descripcion: "ValidacionDeToken: token vencido",
                },
              },
            },
          },
        }))
      )
      .authorizeVoucher({
        data: { comprobanteCAERequest: { numeroComprobante: 1 } },
      }),
  "facturas/wsmtxca ArcaAuthenticationError"
);
assertAuthenticationErrorIdentity(
  wsmtxcaAuthenticationError,
  "facturas/wsmtxca"
);

console.log(
  "Package runtime exports resolve as ESM-only entrypoints with shared error identities."
);

function createServiceOptions(execute) {
  return {
    config: {
      taxId: "20123456789",
      certificatePem: "certificate",
      privateKeyPem: "private-key",
      environment: "test",
    },
    auth: {
      login() {
        return Promise.resolve({
          token: "token",
          sign: "sign",
          expiresAt: "2099-01-01T00:00:00Z",
        });
      },
    },
    soap: {
      execute:
        execute ??
        (() =>
          Promise.reject(
            new Error("Unexpected SOAP call in package export check.")
          )),
    },
  };
}

function createWsfeVoucherInput(overrides = {}) {
  return {
    salesPoint: 1,
    voucherType: 6,
    concept: 1,
    documentType: 80,
    documentNumber: 30_717_329_654,
    receiverVatConditionId: 5,
    voucherDate: "20260501",
    totalAmount: 121,
    nonTaxableAmount: 0,
    netAmount: 100,
    exemptAmount: 0,
    taxAmount: 0,
    vatAmount: 21,
    currencyId: "PES",
    exchangeRate: 1,
    vatRates: [{ id: 5, baseAmount: 100, amount: 21 }],
    ...overrides,
  };
}

function captureThrown(operation, label) {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error(`Expected ${label} to be thrown.`);
}

async function captureRejected(operation, label) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error(`Expected ${label} to be rejected.`);
}

function assertErrorIdentity(error, errorClass, entrypoint) {
  if (!(error instanceof root[errorClass])) {
    throw new Error(
      `Expected ${entrypoint} error to be instanceof facturas ${errorClass}.`
    );
  }
  if (!(error instanceof errors[errorClass])) {
    throw new Error(
      `Expected ${entrypoint} error to be instanceof facturas/errors ${errorClass}.`
    );
  }
  if (!(error instanceof root.ArcaError && error instanceof errors.ArcaError)) {
    throw new Error(
      `Expected ${entrypoint} error to share the public ArcaError base class.`
    );
  }
}

function assertAuthenticationErrorIdentity(error, entrypoint) {
  assertErrorIdentity(error, "ArcaAuthenticationError", entrypoint);
  if (!root.isArcaAuthenticationError(error)) {
    throw new Error(
      `Expected facturas predicate to recognize ${entrypoint} authentication error.`
    );
  }
  if (!errors.isArcaAuthenticationError(error)) {
    throw new Error(
      `Expected facturas/errors predicate to recognize ${entrypoint} authentication error.`
    );
  }
}
