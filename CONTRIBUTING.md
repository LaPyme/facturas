# Cómo contribuir

Gracias por querer mejorar `facturas`. Esta guía explica cómo levantar el
repositorio y proponer un cambio.

## Antes de empezar

- Para reportar un error o proponer una mejora, abrí un
  [issue](https://github.com/LaPyme/facturas/issues). Si el cambio es grande o
  toca la API pública, conversalo ahí antes de escribir código.
- Para reportar una vulnerabilidad, no abras un issue. Seguí
  [SECURITY.md](./SECURITY.md).
- No pegues certificados, claves privadas, tickets WSAA ni datos fiscales reales
  en issues, pull requests, tests o ejemplos.
- Al participar aceptás el [código de conducta](./CODE_OF_CONDUCT.md).

## Entorno

Necesitás Node.js 22 o superior y pnpm 12. Desarrollamos con la versión de
Node.js de `.nvmrc`. Si no tenés pnpm, instalalo con `npm install -g pnpm@12`.
pnpm usa la versión fijada en `package.json`.

```bash
nvm use
pnpm install
```

Los tests no llaman a ARCA ni necesitan credenciales.

## Comandos

Desde la raíz del repositorio:

| Comando | Qué verifica |
| --- | --- |
| `pnpm typecheck` | Tipos del paquete y de los ejemplos |
| `pnpm test` | Tests |
| `pnpm test:coverage` | Tests con cobertura |
| `pnpm check` | Lint y formato. `pnpm fix` corrige lo que puede |
| `pnpm check:docs` | README, links de la documentación y ejemplos |
| `pnpm --filter facturas check:exports` | Entrypoints del paquete compilado |
| `pnpm pack:check` | Archivos que se publican en npm |

CI corre estos comandos en Node.js 22 y 24.

## Probar contra ARCA

Probá siempre en homologación, nunca en producción. Cada comprobante autorizado
queda en los registros de ARCA.

`npx facturas` usa la versión publicada. Para probar tu cambio, compilá el
paquete y corré el CLI local con tus credenciales de homologación:

```bash
pnpm build
node packages/arca/bin/facturas.mjs check
```

La guía del [CLI](./docs/getting-started/cli.mdx) explica `init`, `check` e
`issue`.

## Pull requests

- `main` está protegida. Todo cambio entra por pull request y necesita CI en
  verde.
- Mantené cada pull request enfocado en un solo cambio.
- Agregá o actualizá los tests del comportamiento que cambiás.
- Si el cambio afecta a quien usa el paquete, agregá un changeset con
  `pnpm changeset`. Usá `patch` para correcciones y `minor` para funciones
  nuevas o cambios de API. Mientras la versión empiece en `0.`, un minor puede
  romper compatibilidad.
- Si cambiás una regla que el SDK toma del manual de ARCA, actualizá
  [`.github/ARCA_SOURCES.md`](./.github/ARCA_SOURCES.md) con la regla y la
  página del manual. Ese archivo no se publica en el sitio de documentación.

## Documentación

La documentación pública está en castellano rioplatense, con voseo.
`README.md` es la portada del paquete y `docs/` es un sitio Mintlify con inicio,
guías, referencia y ejemplos.

- Escribí oraciones cortas y concretas. No uses punto y coma ni raya en la
  prosa.
- Presentá `issue()` como la forma normal de emitir. `client.wsfe`,
  `client.wsmtxca` y `client.padron` son para lecturas, catálogos y consultas
  que `issue()` no cubre.
- Cada ejemplo ejecutable lee las credenciales de ARCA desde variables de
  entorno.

`packages/arca/README.md` es una copia exacta de `README.md`. Después de editar
el README de la raíz, corré:

```bash
pnpm docs:sync
pnpm check:docs
```

`pnpm check:docs` verifica que resuelvan los links internos y las anclas de
`README.md`, `docs/**/*.mdx` y `packages/arca/README.md`, que cada archivo de
`examples/` esté linkeado desde algún documento y que la prosa respete estas
reglas. Corre en CI.

## Licencia

Al contribuir, aceptás que tu aporte se publique bajo la
[licencia Apache-2.0](./LICENSE).
