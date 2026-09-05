# tasita-api — backend de suscripciones

Cloudflare Worker + base D1. Reemplaza al plan viejo con Supabase, que en el plan
gratis **se pausa sola a la semana sin uso** — justo lo que le pasó al proyecto anterior.
Workers y D1 no se pausan por inactividad.

## Puesta en marcha (una sola vez)

```bash
cd C:\Users\usuario\TasitaApp\api
npx wrangler login                 # abre el navegador, lo hace Marc
npx wrangler d1 create tasita      # devuelve el database_id → copiarlo a wrangler.toml
npx wrangler d1 execute tasita --remote --file=./schema.sql
npx wrangler secret put MP_ACCESS_TOKEN   # el access token de producción de Mercado Pago
npx wrangler deploy
```

`deploy` imprime la URL (`https://tasita-api.<subdominio>.workers.dev`). Esa URL va en
`PAGOS.API_URL` dentro de `../index.html`. Opcionalmente se le puede colgar
`api.tasita.com.ar` desde el panel de Cloudflare (Workers → Routes).

En Mercado Pago, configurar la notificación de webhook apuntando a `<URL>/webhook-mp`.

## Endpoints

| Método | Ruta | Para qué |
|---|---|---|
| `GET` | `/suscripcion?codigo=tas_xxx` | La app pregunta si ese código tiene acceso. Devuelve `{activa, hasta}`. |
| `POST` | `/webhook-mp` | Mercado Pago avisa de un pago. Fuente de verdad. |
| `GET` | `/salud` | Chequeo rápido de que el Worker está vivo. |
| `GET` | `/panel?clave=…` | El panel privado: cuánta gente hay, quién pagó, a quién se le termina la prueba. |

## El panel privado

Vive en `https://tasita-api.<subdominio>.workers.dev/panel?clave=…`, que es **otro
dominio** que el de la app (`presupuesto.tasita.com.ar`). Los clientes no llegan
nunca: en la app no hay ningún link que apunte ahí, la dirección pide clave, y la
clave no está en el HTML de la app sino guardada como secret de Cloudflare.

```bash
npx wrangler secret put CLAVE_PANEL    # cargarla, o cambiarla cuando haga falta
```

Agregando `&json` a la dirección devuelve los mismos números en JSON, sin la página.

Se puede guardar en el teléfono como app (`/panel/manifest.json` y `/panel/sw.js`
están para eso). El service worker no guarda nada en caché a propósito: cada vez
que se abre el panel, va a buscar los números del momento.

### De dónde salen los números

La tabla `usuarios` se llena sola: cada vez que alguien abre Tasita, el Worker
anota el día (una sola escritura por persona por día, en segundo plano; si falla,
se ignora y la app ni se entera).

Los 40 que ya estaban antes de que esto existiera se reconstruyeron con
`backfill-usuarios.sql`, sacando la fecha del primer movimiento que cargó cada
uno. Esos quedan marcados con `origen = 'reconstruido'` y se muestran con un `≈`.

**El día que se le termina la prueba a cada uno es una estimación**: el reloj de
los 20 días corre en el `localStorage` del celular de la persona, el servidor no
lo ve. El panel lo calcula desde el día que vio a esa persona por primera vez, o
desde el lanzamiento del cobro (`LANZAMIENTO` en `worker.js`), lo que sea más
tarde. Para que sea exacto habría que hacer que la app le mande ese dato al
servidor — es una línea en `index.html`, todavía sin hacer.

## Cosas a tener en cuenta

- El webhook **nunca confía en el aviso que llega**: cualquiera puede hacer POST a esa URL,
  así que le vuelve a preguntar a Mercado Pago por el pago usando el token secreto.
- Siempre responde `200`, incluso ante un aviso que no puede procesar. Si devolviera error,
  MP reintenta el mismo aviso durante días. Lo que no se pudo procesar queda en `eventos_mp`
  para activarlo a mano.
- `ORIGEN_APP` en `wrangler.toml` limita quién puede llamar a la API desde el navegador.
  Para probar desde `localhost` hay que agregar ese origen temporalmente.
- El token de MP **no se commitea**: vive como secret de Cloudflare.

## Ver qué está pasando

```bash
npx wrangler tail                                                  # logs en vivo
npx wrangler d1 execute tasita --remote --command "SELECT * FROM suscripciones"
npx wrangler d1 execute tasita --remote --command "SELECT * FROM eventos_mp ORDER BY id DESC LIMIT 10"
```

## Activar a mano una suscripción

Si alguien pagó y el webhook falló:

```bash
npx wrangler d1 execute tasita --remote --command "INSERT INTO suscripciones (codigo, activa, hasta, actualizado) VALUES ('tas_xxxxxxxxxx', 1, '2026-09-30', datetime('now')) ON CONFLICT(codigo) DO UPDATE SET activa=1, hasta='2026-09-30'"
```
