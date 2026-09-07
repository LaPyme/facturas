---
"facturas": minor
---

Add the `facturas` CLI: `init` generates the key and CSR and tells you where to save the certificate, `check` diagnoses each ARCA layer, and `issue` emits one homologation invoice. `check` and `issue` resolve their inputs from flags, then environment variables, then the `arca-<entorno>.crt` and `.key` files in the directory, taking the CUIT from the certificate, so the first run after `init` needs no configuration at all.
