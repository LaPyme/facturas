---
"facturas": patch
---

Fix FCE credit and debit notes for services and products with services when annulment is false. Preserve the original service dates without copying its payment due date, which ARCA rejects with WSFE error 10175. Apply the same rule to previews, issuance and explicit optional field 22 with value N.
