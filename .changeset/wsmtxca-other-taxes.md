---
"facturas": patch
---

WSMTXCA requests without other tributes no longer send `importeOtrosTributos: 0`. ARCA rejects that amount without an `arrayOtrosTributos` detail with error 114 ("Si informa el Importe de Otros Tributos debe informar el detalle de los mismos"), so every detailed invoice without tributes was refused since 0.12.0. The amount and the detail now travel together or not at all, and a non-zero tribute amount without details is rejected as invalid input before any request.
