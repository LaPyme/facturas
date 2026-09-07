# Stores

Un solo `store` persiste los tickets WSAA y las reservas inmutables de facturas
y notas de crédito, y coordina la secuencia del punto de venta entre todos los
procesos que lo comparten. El SDK no agrega ninguna dependencia de base de
datos ni de Redis. Las fallas del store lanzan `ArcaConfigurationError` con su
causa adjunta y un mensaje sin contenido.

## Qué garantiza cada store

| Store | Reservas durables | Secuencia coordinada |
| --- | --- | --- |
| Postgres | sí | sí, con una fila de lease y un `UPDATE` condicional |
| Redis | sí | sí, con `SET NX PX` y una liberación verificada |
| Archivos | sí, en un solo servidor con volumen privado | sí, con un directorio de lock y vencimiento |
| Memoria | no: no sobrevive a un reinicio | solo dentro del proceso |
| Store propio con `withLock` | según tu backend | sí, con tu implementación |
| Store propio sin `withLock` | según tu backend | no: cada proceso lee y escribe por su cuenta |

Con un store que provee `withLock`, `issue()`, `issueCreditNote()` e
`issueDebitNote()` toman el lock de la secuencia antes de leer el próximo
número y lo sueltan recién después de resolver la escritura. Dos llamadas
simultáneas sobre el mismo punto de venta y tipo de comprobante toman números
consecutivos y escriben una sola vez cada una. Sin `withLock`, o sin store, el
comportamiento es el de siempre: cada llamada lee el próximo número y escribe,
y un 10016 se resuelve como conflicto.

Antes de tomar un número, la llamada revisa la última reserva reclamada en esa
secuencia. Si nadie registró su desenlace, la consulta sin escribir: una
autorización, un rechazo, un conflicto o un número vacío la dan por resuelta.
Si la consulta no puede contestar, el resultado es `indeterminate` con
`lookup: { kind: "blocked", by: <clave> }` y no se reserva ni se escribe nada:
resolvé esa clave con `recover()` y repetí. El lease del lock dura lo que dure
el trabajo, se renueva mientras el proceso vive y vence solo cuando el proceso
se cae; no es configurable. Un lease vencido libera el lock, nunca la barrera:
la reserva sin resolver sigue frenando el próximo reclamo.

## Postgres

Usá el cliente que ya tiene tu aplicación. Neon, Supabase Postgres, Vercel
Postgres, `pg` y `postgres` pueden proveer la función de consulta
parametrizada. Los resultados pueden ser un array de filas o `{ rows }`. Con
`postgres`, adaptá `sql.unsafe(text, params)`. Creá la tabla por defecto una
sola vez:

```sql
CREATE TABLE arca_store (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

```ts
const store = createPostgresStore({
  query: (text, params) => sql.query(text, params),
  table: "arca_store", // Optional simple SQL identifier.
});
```

La creación atómica usa `INSERT ... ON CONFLICT DO NOTHING RETURNING key`. El
adaptador no crea la tabla. El lock de secuencia es una fila más de esa tabla,
tomada con el mismo `INSERT` y liberada con un `DELETE` que verifica el dueño,
y una fila abandonada se recupera con un `UPDATE` condicional sobre
`updated_at`: no usa locks de sesión, así que funciona detrás de PgBouncer en
modo transacción.

## Redis

```ts
import { createRedisStore } from "facturas";
const store = createRedisStore(redis);
// Optional override: createRedisStore(redis, { flavor: "upstash" });
```

Un cliente con `call` usa ioredis `SET key value NX`; si no, el adaptador usa
Upstash `set(key, value, { nx: true })`. Usá un Redis durable, sin desalojo de
las claves de reserva: los registros no llevan TTL. El lock de secuencia sí es
una clave con vencimiento, tomada con `SET NX PX`, renovada mientras se la
tiene y borrada solo si sigue siendo tuya. Necesita `del` en el cliente: sin
`del`, el adaptador no expone `withLock` y la secuencia no se coordina.

## Archivos

```ts
import { createFileStore } from "facturas";
const store = createFileStore("/private/durable/arca");
```

Usá un volumen privado y durable en un único servidor. Las claves se hashean a
nombres de archivo; la creación es exclusiva y el reemplazo usa un archivo
temporal y un rename. Los archivos quedan con modo `0600` y los directorios
nuevos con `0700`. El lock de secuencia es un directorio `.lock` creado con
`mkdir`, con el dueño y el vencimiento adentro: coordina varios procesos sobre
el mismo volumen, no varios servidores sobre un NFS compartido.

## Memoria

```ts
import { createMemoryStore } from "facturas";
const store = createMemoryStore();
```

Para pruebas y ejemplos. Serializa los refrescos de ticket y la secuencia
dentro del objeto compartido, pero **no sobrevive a un reinicio**. No hace
durables los reintentos en serverless.

## Store propio y vida de los registros

```ts
type ArcaStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  add(key: string, value: string): Promise<boolean>;
  delete?(key: string): Promise<void>;
  withLock?<T>(key: string, fn: () => Promise<T>): Promise<T>;
};
```

`add` tiene que devolver false de forma atómica sin cambiar un valor existente.
El `withLock` opcional coordina los refrescos de ticket WSAA y la secuencia del
punto de venta; tiene que ser exclusivo entre procesos y soltarse siempre, aun
si el proceso muere. Un store sin `withLock` es válido y conserva el
comportamiento de siempre. Cuando pasás las dos opciones, un `wsaaSessionStore`
explícito gana para los tickets.

Las claves usan `arca:v1:wsaa:{environment}:{service}:{fingerprint}` y
`arca:v1:attempt:{environment}:{taxId}:{idempotencyKey}`. Los registros de
reserva contienen el hash del input, la operación, las coordenadas reservadas y
el input exacto enviado. Contienen datos fiscales y de clientes: restringí el
acceso y protegé los backups.

`arca:v1:settled:{environment}:{taxId}:{idempotencyKey}` guarda un resultado
que tiene que sobrevivir al reintento. Hoy se escribe uno solo, la forma
`{ v: 1, kind: "conflict", number, found, settledAt }`: cuando otro comprobante
ocupa el número reservado, el `conflict` queda anotado con `add` antes de
responder, y una repetición con esa clave o un `recover()` lo devuelven sin
consultar al proveedor. Las autorizaciones no se anotan porque ARCA es la
fuente de verdad y cada repetición la consulta; los rechazos tampoco, porque el
input se corrige bajo una clave nueva. Si el store falla al anotar el conflicto,
la llamada lanza `ArcaConfigurationError` en vez de devolver un conflicto que
un reintento podría no volver a ver.

Cada registro lleva su versión. `v: 1` es una reserva de WSFE sin detalle y la
lee cualquier versión desde la 0.9. `v: 2` es una reserva de WSMTXCA o con
detalle de ítems: siempre nombra su proveedor, y la 0.10 no puede reproducirla,
justamente para que un rollback no reenvíe por WSFE un comprobante que era de
WSMTXCA. Preservá las dos versiones.

`arca:v1:sequence:{environment}:{taxId}:{salesPoint}:{voucherType}` guarda la
última reserva reclamada en esa secuencia y si ARCA ya informó su desenlace;
`arca:v1:lock:sequence:...` es la clave del lock. Los dos son registros de
coordinación, no evidencia fiscal: se reescriben en cada reclamo y se pueden
borrar si hacen falta, siempre que ninguna reserva quede sin conciliar. Repetir una clave con otro input, otra
operación, otro proveedor u otro `number` explícito es un mismatch de
idempotencia y lanza `ARCA_INPUT_IDEMPOTENCY_MISMATCH`.

**No podés borrar, vencer ni reescribir los registros de reserva.** El SDK solo
los crea, nunca guarda resultados encima y siempre consulta a ARCA en una
repetición. Borrar una reserva puede hacer que un reintento posterior emita
otra factura.
