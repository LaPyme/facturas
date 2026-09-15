# Política de seguridad

`facturas` maneja certificados, claves privadas y tickets de acceso a ARCA.
Tomamos en serio cualquier falla que pueda exponerlos o que permita emitir un
comprobante que no corresponde.

## Cómo reportar una vulnerabilidad

No abras un issue, un pull request ni una discusión pública.

Escribí a [tomas@lapyme.com.ar](mailto:tomas@lapyme.com.ar) con el asunto
`facturas: vulnerabilidad`. Incluí:

- La versión de `facturas` y de Node.js.
- Qué encontraste y qué impacto tiene.
- Los pasos o el código mínimo para reproducirlo.
- Si ya lo compartiste con alguien más.

No mandes certificados, claves privadas, tickets WSAA ni datos fiscales reales
de terceros. Si el ejemplo necesita credenciales, usá las de homologación o
reemplazá los valores.

## Qué pasa después

Te confirmamos que recibimos el reporte y te contamos si lo pudimos reproducir.
Coordinamos con vos la corrección y la fecha en que se hace público. Si querés,
te mencionamos en el changelog de la versión que lo corrige.

## Versiones con soporte

Mientras `facturas` esté en `0.x`, solo la última versión publicada recibe
correcciones de seguridad.

## Alcance

Esta política cubre el paquete `facturas` de npm, con su SDK y su CLI, y este
repositorio. Por ejemplo:

- Una clave privada, un certificado o un ticket WSAA que aparece en logs,
  errores o archivos.
- Una conexión a ARCA que acepta un certificado TLS inválido.
- Una respuesta XML que el SDK procesa de forma insegura.
- Un archivo que el CLI escribe con permisos demasiado abiertos.

No cubre los servicios web de ARCA, que se reportan a ARCA, ni la forma en que
guardás tus credenciales en tu infraestructura. Un error fiscal sin impacto de
seguridad, como un redondeo incorrecto, va en un
[issue](https://github.com/LaPyme/facturas/issues).
