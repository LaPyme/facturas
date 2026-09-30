---
"facturas": patch
---

Las consultas de Padrón ahora devuelven `ArcaAuthenticationError` cuando un
SOAP fault indica un rechazo de autenticación. Conservan el motivo, el servicio
y la operación, sin agregar reintentos.
