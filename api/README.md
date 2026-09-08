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

**Solo cuenta quien entra por la dirección real de la app.** El Worker mira el
`Origin` del pedido: si no es `ORIGEN_APP`, la visita se anota igual pero marcada
`interno = 1` con `origen = 'prueba'`, así que no aparece en ningún número. Eso
deja afuera automáticamente el archivo abierto desde la computadora
(`file:///…`, que manda `Origin: null`), las pruebas en `localhost` y cualquier
herramienta o `curl`. A quien ya existe no se le toca la marca: un cliente real
que un día entre por un camino raro no se cae de la cuenta, y un interno no
vuelve solo a la cuenta.

Lo que **no** se puede distinguir solo son los teléfonos propios usando la app de
verdad: esos hay que marcarlos a mano una vez con el botón del panel. El código
de cada equipo se ve en **Más → "Mi código"**.

### Personas vs. aperturas

El panel muestra dos números distintos y **no son lo mismo**:

- **Personas** (`usuarios.activo = 1`): las que llegaron a poner su nombre en la
  app. Es el número de gente. La app avisa con `&activo=1` colgado de la consulta
  de suscripción que ya hacía — ni una llamada de más. Nunca vuelve a 0, y si la
  app no manda el dato (versión vieja, sin internet) queda para la próxima vez.
- **Aperturas** (`usuarios` a secas): cuenta códigos, y **un código es un
  navegador, no una persona**. Quien mira desde Instagram, después abre en su
  navegador y después instala la app son tres códigos para un solo ser humano.
  Sirve para medir si un video funcionó, no para contar clientes.

Al implementarlo se marcaron con `activo = 1` los que ya tenían movimientos
cargados (cargar un movimiento exige haber puesto el nombre). Los que lo pusieron
pero nunca cargaron nada se van marcando solos al abrir la app, así que **el
número arranca bajo y sube unos días**.

### El código viaja al saltar de navegador

Cuando alguien llega desde Instagram y toca abrir en Chrome/Safari (o copia el
link), la dirección lleva `?id=<código>&t=<hora>` y el navegador destino lo
adopta en vez de inventar uno nuevo. Además de no contarlo dos veces, evita que
esa persona pierda los días de prueba y los movimientos que ya tenía.

Tres candados, en `index.html`: se adopta **solo si no hay ningún código
guardado** (la lógica vive dentro de `miCodigo()`, así que es imposible pisarle
el suyo a alguien), **vence a los 10 minutos** (`MINUTOS_TRASPASO`), y el código
**se borra de la barra** apenas se usa. Un link que quede pegado en un chat es,
para el que lo abra después, la dirección común y corriente.

⚠️ **Nunca limpiar por fecha.** El 2026-09-04 se corrió
`DELETE FROM usuarios WHERE … OR creado >= date('now','-3 hours')` para sacar
unos residuos de prueba y se llevó puestas **todas las altas reales de ese día**
(por eso no hay ni un alta con fecha 2026-09-04). Los que volvieron a abrir la
app reaparecieron con la fecha corrida; los que no, se perdieron del conteo. Para
limpiar, siempre por código exacto:
`DELETE FROM usuarios WHERE codigo IN ('tas_…','tas_…')`.

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
- **Cancelar no corta el acceso.** El mes que la persona pagó le corresponde entero: la
  suscripción se queda con su `hasta` y se vence sola, porque al no haber más cobros nada
  la va a extender. Lo mismo con un pago rechazado (MP reintenta). Lo único que corta en el
  acto es que le hayan devuelto la plata: los estados de `DEVUELTO` en `worker.js`
  (contracargo o reembolso). El estado que informó MP queda en `suscripciones.estado`, y el
  panel muestra cuántos se dieron de baja pero siguen entrando hasta que se les termine.
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
