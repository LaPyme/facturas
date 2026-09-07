---
"facturas": patch
---

Hand the CSR and the certificate over inside the terminal. `init` now copies the CSR to the system clipboard in homologación, with the tool the platform already ships and no shell, and prints the request inline when there is none, so step 3 in ARCA is one paste either way. It then asks for the certificate right there, verifies that it belongs to the key it just wrote and to the CUIT it was given before writing `arca-<entorno>.crt`, and reports its expiry; `--no-clipboard`, `--no-paste`, Ctrl-C and a run without a terminal all keep the previous instructions. The new `npx facturas cert` command takes that same paste on its own, for the certificate you saved for later.
