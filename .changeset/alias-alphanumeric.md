---
"facturas": patch
---

`init` now suggests an alphanumeric alias (`facturasTest`, `facturasProduction`), because ARCA's alias fields reject hyphens; anything else in `--name` is dropped from the alias while the CSR common name keeps it.
