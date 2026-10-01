---
"facturas": minor
---

Una llamada que espera el lock de la secuencia ahora deja de esperar cuando vence su `abortSignal`. Antes la espera lo ignoraba y podía durar hasta 120 segundos. Al rendirse, por espera máxima o por `abortSignal`, lanza `ArcaLockTimeoutError` con `code: "ARCA_LOCK_TIMEOUT"` y `reason` `"held"` o `"aborted"`, en vez de un `ArcaConfigurationError` que había que reconocer por el mensaje. En los dos casos no se reservó ni se envió nada, así que la misma llamada se puede repetir.

`withLock` del store acepta un tercer argumento opcional, `{ signal }`. Los stores incluidos lo respetan. Un store propio que lo ignora sigue funcionando, pero su espera no se corta con el `abortSignal`.
