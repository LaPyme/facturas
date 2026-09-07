---
"facturas": patch
---

`wsfe.getSalesPoints()` returns an empty list when WSFE answers error 602 (Sin Resultados), which is how ARCA reports a taxpayer with no sales point for web services. Previously it threw `ArcaServiceError`, which made `npx facturas check` fail its WSFE layer on a fresh homologación CUIT. Other errors still throw.
