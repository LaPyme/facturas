---
"facturas": patch
---

WSMTXCA valida el último número autorizado igual que WSFE. Rechaza respuestas sin un entero decimal explícito entre 0 y 99.999.999, como `"12abc"` o `"1.5"`, con `ArcaInvalidSoapResponseError`. Una respuesta sin número, que antes lanzaba `ArcaServiceError` ("WSMTXCA did not return the last authorized voucher number"), ahora también lanza `ArcaInvalidSoapResponseError` ("Invalid WSMTXCA last authorized number").
