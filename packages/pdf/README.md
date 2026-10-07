# @facturas/pdf

El PDF de un comprobante autorizado por ARCA, en A4 y con la ubicación de datos
de la RG 1415, Anexo II, Apartado B. Dibuja el modelo que arma
`buildVoucherDocument()` de [facturas](https://www.npmjs.com/package/facturas)
con [@react-pdf/renderer](https://react-pdf.org).

```bash
pnpm add facturas @facturas/pdf @react-pdf/renderer react
```

```ts
import { renderVoucherPdf } from "@facturas/pdf";

const pdf = await renderVoucherPdf(comprobante, {
  logo: await readFile("logo.png"),
  notes: "Garantía oficial de 6 meses.",
  theme: { accentColor: "#C00000" },
});
```

- Los bloques fiscales son fijos: el recuadro del emisor, la letra en el centro,
  el bloque de transparencia fiscal abajo a la izquierda y el CAE con su
  vencimiento en 12 puntos abajo a la derecha.
- El tema cambia tipografía y colores. El logo y las notas tienen su espacio
  fuera de las zonas fiscales.
- El QR se dibuja en vectores y es un link a la constatación de ARCA.
- Sale con la misma versión que `facturas`.

La guía completa está en
[Comprobante impreso](https://facturas-sdk.dev/guides/printed-voucher).
