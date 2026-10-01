---
"facturas": patch
---

Las consultas de Padrón ahora devuelven `ArcaAuthenticationError` ante los
rechazos de autenticación del login de WSAA o de la consulta al servicio.
Conservan el motivo, el servicio y la operación, sin agregar reintentos.
