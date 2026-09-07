# Habilitación en ARCA

Este paquete **no** te da de alta las credenciales de ARCA. La configuración
oficial de certificados y servicios la seguís haciendo fuera del SDK.

## Antes de usar el SDK

Necesitás CUIT, certificado y clave privada, la relación del certificado con el
servicio **Facturación Electrónica**, y un punto de venta habilitado para web
services. Homologación y producción tienen certificados y puntos de venta
propios.

1. Conseguí un CUIT válido.
2. Generá o recibí un certificado y su clave privada en formato PEM.
3. Autorizá el certificado para el servicio y el entorno de destino.
4. Empezá con `environment: "test"` y pasá a producción solo después de validar
   el flujo de punta a punta.

## Con el CLI

`npx facturas init` genera la clave y el CSR con el subject que pide el
instructivo oficial, y después imprime una sola lista de pasos, la del entorno
que elegiste. Guardá el certificado que te dé ARCA en ese directorio, con el
nombre que `init` te indica (`arca-test.crt` o `arca-production.crt`), y
`npx facturas check` lo encuentra solo: prueba cada capa y nombra la que falta
habilitar, sin que tengas que exportar nada. Ninguno de los dos escribe en
ARCA. Están en [CLI](./cli.md).

### Homologación, paso a paso

El entorno de testing se maneja con **WSASS**, una aplicación aparte. No es
delegable: entrás con tu clave fiscal de **persona física**, nivel 2 o
superior.

1. Entrá con clave fiscal a
   [auth.afip.gob.ar](https://auth.afip.gob.ar/contribuyente_/login.xhtml).
2. Abrí `WSASS - Autogestión Certificados Homologación` en Mis Servicios. Si no
   está, agregalo desde `Administrador de Relaciones` → `Adherir Servicio` →
   ARCA → `Servicios Interactivos` → WSASS; después cerrá la sesión y volvé a
   entrar, que recién ahí aparece.
3. En el menú del WSASS, `Nuevo Certificado`. Es el formulario "Crear DN y
   certificado", con tres campos: `Nombre simbólico del DN` (el alias),
   `CUIT del contribuyente` (viene puesto y no se edita) y
   `Solicitud de certificado en formato PKCS10` (ahí va el CSR entero, con las
   líneas `BEGIN` y `END`). Botón `Crear DN y Obtener Certificado`.
4. **No hay descarga.** El certificado x509 en PEM aparece en el cuadro de
   resultado de esa misma página, de `-----BEGIN CERTIFICATE-----` a
   `-----END CERTIFICATE-----`. Copialo entero y guardalo en un archivo de
   texto, como `arca-test.crt`.
5. En el menú, `Crear autorización a servicio`:
   `Nombre simbólico del DN a autorizar` (el alias del paso 3),
   `CUIT representado` (el mismo CUIT, salvo que operes para un tercero) y
   `Servicio al que desea acceder` (`wsfe - Facturación Electrónica`). Botón
   `Crear Autorización de Acceso`.

Los campos `CUIT del DN a autorizar` y `CUIT de quien genera la autorizacion`
los completa el sistema y no se editan.

### Producción, paso a paso

1. Entrá con clave fiscal a
   [auth.afip.gob.ar](https://auth.afip.gob.ar/contribuyente_/login.xhtml).
2. Abrí `Administración de Certificados Digitales` en Mis Servicios. Si no
   está, habilitalo desde `Administrador de Relaciones` → `Nueva Relación` →
   `BUSCAR` → `Servicios Interactivos` → el mismo
   `Administración de Certificados Digitales` → `Confirmar`; después cerrá la
   sesión y volvé a entrar.
3. Apretá `Agregar alias`. El formulario pide el `Alias` (el nombre del
   computador fiscal) y el archivo CSR, con `Seleccionar archivo`. Confirmá con
   `Agregar alias`.
4. En la lista, entrá con `Ver` y usá el icono `Descargar` para bajar el
   certificado emitido (archivo CRT). Guardalo como `arca-production.crt`.
5. Volvé a `Administrador de Relaciones` → `Nueva Relación`. En `Servicio`,
   `BUSCAR` y dentro de la agrupación `Webservices` elegí
   `Facturación Electrónica`. En `Representante`, `BUSCAR` y elegí el
   computador fiscal del paso 3. Apretá `Confirmar`, revisá y volvé a apretar
   `Confirmar`.

### Punto de venta

Los dos entornos tienen puntos de venta propios, y se dan de alta en
`Administración de Puntos de Venta y Domicilios` → Nuevo. El sistema depende de
tu condición: `RECE para aplicativo y Web Services` para responsable inscripto,
y `Factura Electrónica – Monotributo – Web Services` o
`Factura Electrónica – Exento en IVA – Web Services` para monotributo y exento.
`Comprobantes en línea` es otro sistema y no sirve para web services. `init` no
lo pide: `npx facturas check` te informa cuáles tenés habilitados.

## Referencias oficiales

- [Índice de documentación de facturación electrónica](https://www.arca.gob.ar/ws/documentacion/ws-factura-electronica.asp)
- [Documentación de WSAA](https://www.afip.gob.ar/ws/documentacion/wsaa.asp)
- [Certificados para pruebas / homologación](https://www.afip.gob.ar/ws/documentacion/certificados.asp)
- [Manual del desarrollador de WSAA](https://www.afip.gob.ar/ws/WSAA/WSAAmanualDev.pdf)
- [Alta de servicios en WSASS](https://www.afip.gob.ar/ws/WSASS/WSASS_como_adherirse.pdf)
- [Manual del usuario de WSASS](https://www.arca.gob.ar/ws/WSASS/html/index.html)
  ([PDF](https://www.afip.gob.ar/ws/WSASS/WSASS_manual.pdf))
- [Generación de certificados para producción](https://www.afip.gob.ar/ws/WSAA/WSAA.ObtenerCertificado.pdf)
- [Delegación de webservices con el Administrador de Relaciones](https://www.afip.gob.ar/ws/WSAA/ADMINREL.DelegarWS.pdf)
- [Manual del desarrollador de WSFE](https://www.afip.gob.ar/ws/documentacion/manuales/manual-desarrollador-ARCA-COMPG.pdf)

Las reglas del manual que el SDK codifica están anotadas, en inglés y para
mantenedores, en [docs/external/README.md](./external/README.md).
