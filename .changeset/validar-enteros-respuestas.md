---
"facturas": patch
---

Valida los identificadores enteros de las respuestas SOAP sin truncar ni convertir valores mal formados. WSMTXCA conserva el CAE y la evidencia de una emisión con número inválido como `indeterminate` con `reason: "invalid_response"`, para poder conciliarla con `recover()` sin reenviar. Esto también se aplica a una respuesta `R` con número mal formado, que antes podía clasificarse como `rejected`.

Las consultas `consultarComprobante` de WSMTXCA y `FECompConsultar` de WSFE rechazan números, puntos de venta y tipos inválidos con `ArcaInvalidSoapResponseError`. Los campos opcionales ausentes siguen omitidos. En WSFE, `CbteDesde` o `CbteHasta` debe aportar el número obligatorio del comprobante. Si faltan ambos se rechaza la respuesta, en lugar de inventar el cero, y un extremo válido no oculta otro presente mal formado.

Los puntos de venta de WSMTXCA y WSFE rechazan toda la respuesta si una entrada no tiene un número válido, en lugar de descartarla o inventar el cero. Los catálogos numéricos de WSFE también rechazan identificadores ausentes o mal formados y siguen aceptando un cero explícito. Se aceptan enteros decimales dentro del dominio del campo, incluidos ceros iniciales y espacios exteriores. Un valor presente `null` o vacío es inválido.
