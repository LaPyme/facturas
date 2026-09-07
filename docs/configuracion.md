# Configuración

## Variables de entorno

`createArcaClient()` descubre los campos que faltan con las mismas reglas que
`createArcaClientConfigFromEnv()`. Los campos explícitos ganan; `process.env` no
se modifica.

| Variable | Obligatoria | Notas |
| --- | --- | --- |
| `ARCA_TAX_ID` | Sí | CUIT de 11 dígitos |
| `ARCA_CERTIFICATE_PEM` | Sí | Certificado PEM |
| `ARCA_PRIVATE_KEY_PEM` | Sí | Clave privada PEM |
| `ARCA_ENVIRONMENT` | Sí | `test` o `production`; no hay valor por defecto |

Para loguear sin tocar el código, definí `ARCA_LOG_LEVEL` en `debug`, `info`,
`warn` o `error`.

## Opciones de `createArcaClient()`

Pasale un objeto de configuración a `createArcaClient`:

```ts
import { createArcaClient } from "facturas";

const client = createArcaClient({
  taxId: "20123456786",
  certificatePem: process.env.ARCA_CERTIFICATE_PEM!,
  privateKeyPem: process.env.ARCA_PRIVATE_KEY_PEM!,
  environment: "test",
  timeout: 30_000,
  retries: 2,
  retryDelay: 500,
  logger: { level: "debug" },
  // Optional: share WSAA login tickets across workers.
  // wsaaSessionStore,
});
```

| Campo | Por defecto | Descripción |
| --- | --- | --- |
| `taxId` | `ARCA_TAX_ID` | CUIT de 11 dígitos |
| `certificatePem` | `ARCA_CERTIFICATE_PEM` | Certificado PEM |
| `privateKeyPem` | `ARCA_PRIVATE_KEY_PEM` | Clave privada PEM |
| `environment` | `ARCA_ENVIRONMENT` | `test` o `production`. Sin valor por defecto: si falta en ambos lados, `createArcaClient()` lanza `ArcaConfigurationError` |
| `timeout` | `30000` | Timeout de la request HTTP en milisegundos |
| `retries` | `0` | Intentos extra, solo ante fallas de transporte |
| `retryDelay` | `500` | Espera entre reintentos de transporte en milisegundos |
| `logger` | — | Configuración opcional del logger estructurado |
| `store` | — | Tickets y reservas durables unificados |
| `wsaaSessionStore` | — | Store opcional de tickets WSAA para despliegues con varios workers |

## Stores de sesión WSAA

Por defecto, los tickets de login de WSAA se cachean solo en el proceso actual.
Eso mantiene los scripts y las apps de un solo proceso sin configuración:

```ts
const client = createArcaClient({
  taxId: "20123456786",
  certificatePem: process.env.ARCA_CERTIFICATE_PEM!,
  privateKeyPem: process.env.ARCA_PRIVATE_KEY_PEM!,
  environment: "production",
});
```

Un `store` configurado provee tickets WSAA durables de forma automática. Un
`wsaaSessionStore` explícito sigue soportado y tiene prioridad, solo para los
tickets.

```ts
import {
  type ArcaAuthCredentials,
  type ArcaWsaaSessionKey,
  createArcaClient,
} from "facturas";

const wsaaSessionStore = {
  async get(key: ArcaWsaaSessionKey): Promise<ArcaAuthCredentials | null> {
    // Read from Postgres, Redis, or another shared store.
    return null;
  },
  async set(
    key: ArcaWsaaSessionKey,
    credentials: ArcaAuthCredentials
  ): Promise<void> {
    // Persist token, sign, and expiresAt for the key.
  },
  async withLock<T>(
    key: ArcaWsaaSessionKey,
    fn: () => Promise<T>
  ): Promise<T> {
    // Optional but recommended: serialize cold-start refreshes.
    return await fn();
  },
};

const client = createArcaClient({
  taxId: "20123456786",
  certificatePem: process.env.ARCA_CERTIFICATE_PEM!,
  privateKeyPem: process.env.ARCA_PRIVATE_KEY_PEM!,
  environment: "production",
  wsaaSessionStore,
});
```

La clave del store está alcanzada por entorno, servicio WSAA y huella del
certificado. Las lecturas del store igual se controlan con el margen de
seguridad de expiración del SDK. Un store de producción tendría que compartir
los datos entre todos los workers, cifrar o apoyarse en almacenamiento cifrado,
hacer cumplir la expiración en la lectura, e implementar locking con advisory
locks, locks de Redis o equivalentes.

Para pruebas y coordinación local a través de un objeto compartido, el paquete
también exporta `createMemoryWsaaSessionStore()`.

## Logging

El nivel mínimo por defecto es `warn`. En `debug`, el SDK loguea los requests
SOAP, los tiempos de respuesta, el origen del login WSAA (`cached` o `fresh`) y
los reintentos.

```ts
const client = createArcaClient({
  taxId: "20123456786",
  certificatePem: "...",
  privateKeyPem: "...",
  environment: "test",
  logger: { level: "debug" },
});
```

Los sinks de logger propios reciben `(level, message, ...args)`:

```ts
const client = createArcaClient({
  taxId: "20123456786",
  certificatePem: "...",
  privateKeyPem: "...",
  environment: "production",
  logger: {
    level: "info",
    log(level, message, ...args) {
      // forward to your logger
    },
  },
});
```

Desactivá el logging por completo con `logger: { disabled: true }`.

## Reintentos y timeouts

Los reintentos de transporte configurados se aplican solo a
`ArcaTransportError`: timeouts, fallas de conexión y respuestas HTTP de error
que no son XML. Las respuestas XML, incluidos los SOAP faults con HTTP 500, se
parsean y se exponen como errores de SOAP o de servicio en vez de reintentarse
a ciegas.

Aparte, las operaciones autenticadas de conveniencia de WSFE y WSMTXCA pueden
hacer un reintento con refresco forzado, solo después de un
`ArcaAuthenticationError`. Los timeouts, la pérdida de conexión, el SOAP
inválido, la evidencia incompleta, la evidencia contradictoria y los rechazos
genéricos de servicio nunca habilitan ese camino de recuperación.
`wsfe.issue()` y `wsmtxca.issue()` siempre hacen un único intento exacto de
autorización, y cada intento SOAP de autorización va con los reintentos de
transporte en cero.
