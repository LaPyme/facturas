# Errores

## Manejo de errores

Todos los errores extienden `ArcaError` y exponen un `code` estable como
string.

| Clase | Cuándo |
| --- | --- |
| `ArcaConfigurationError` | Configuración del cliente inválida |
| `ArcaInputError` | Input inválido del llamador, por ejemplo una fecha mal formada |
| `ArcaAuthenticationError` | Rechazo de autenticación explícito del proveedor |
| `ArcaTransportError` | Falla de HTTP o de transporte |
| `ArcaSoapFaultError` | SOAP fault devuelto por ARCA |
| `ArcaServiceError` | Rechazo de servicio a nivel de negocio, sobre todo los errores estilo WSFE |

```ts
import {
  ArcaAuthenticationError,
  ArcaServiceError,
  ArcaSoapFaultError,
  ArcaTransportError,
} from "facturas";

try {
  await client.wsfe.getNextVoucherNumber({ salesPoint: 1, voucherType: 6 });
} catch (error) {
  if (error instanceof ArcaAuthenticationError) {
    console.error(
      error.reason,
      error.service,
      error.operation,
      error.providerCode
    );
  } else if (error instanceof ArcaServiceError) {
    console.error(error.serviceCode, error.message);
  } else if (error instanceof ArcaSoapFaultError) {
    console.error(error.faultCode, error.message);
  } else if (error instanceof ArcaTransportError) {
    console.error(error.statusCode, error.message);
  }
  throw error;
}
```

Importá las clases de error desde `facturas` o desde `facturas/errors`. También
se exporta `isArcaAuthenticationError(error)` para ruteo con predicados. Los
errores de autenticación exponen solamente el código estable
`ARCA_AUTHENTICATION_ERROR`, un `reason` tipado, el servicio, la operación y un
código de proveedor seguro cuando está disponible; no se adjuntan los cuerpos
crudos del proveedor ni los valores de las credenciales.

## Diagnóstico

- `coe.alreadyAuthenticated`: el SDK deduplica los logins WSAA en vuelo y reusa
  los tickets cacheados válidos. En serverless, en workers de cola o en
  cualquier despliegue con varios procesos, configurá un `wsaaSessionStore`
  durable para que un worker frío reuse el TA que obtuvo otro proceso. El caché
  solo en memoria no puede recuperarse entre procesos.
- `dh key too small`: los requests de producción de WSFE ya usan, donde hace
  falta, un nivel de seguridad legacy de OpenSSL. Si igual lo ves, confirmá que
  no estés salteando el transporte del SDK ni terminando TLS en otra capa.
- Certificado vencido: reemplazá el certificado PEM por uno renovado que
  cumpla las mismas expectativas de clave privada, y redesplegá o reiniciá el
  proceso.
- Servicio no autorizado: tu certificado puede ser válido pero no estar
  autorizado para el servicio o el entorno de destino. Revisá de nuevo la
  configuración de WSASS / homologación para `test` y las relaciones de
  servicio para producción.
- WSFE `10015`: en general significa que la combinación `DocTipo` / `DocNro` es
  inconsistente para ese tipo de comprobante y ese importe. Por ejemplo, la
  Factura B tiene reglas especiales de documento del receptor según el total.
- WSFE `10016`: el número de comprobante enviado en `CbteDesde` no es el
  siguiente válido para ese punto de venta y ese tipo de comprobante. Llamá a
  `getNextVoucherNumber()` inmediatamente antes de autorizar cuando tu
  numeración se pueda haber movido. Con clave de idempotencia, `issue()`
  consulta el número reservado: si ya lo ocupa otro comprobante el resultado es
  `conflict` y queda anotado en el store, y si el número está vacío sigue
  siendo `rejected`.

Cuando un error no es claro, revisá esto en orden:

1. Que el certificado y la clave privada correspondan entre sí.
2. Que el entorno sea el correcto (`test` o `production`).
3. Que la autorización del servicio esté hecha para ese entorno.
4. Que la combinación de tipo de comprobante, tipo de documento e importe sea
   válida.
5. Que tu proceso no esté reusando supuestos viejos sobre el próximo número.
