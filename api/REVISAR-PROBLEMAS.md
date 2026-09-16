# Lista de revisión — "pagué y no me deja entrar" (y otros problemas de cobro)

Lista para Claude. Se usa cuando Marc trae un problema de un cliente.
**Se va agregando un punto cada vez que aparece un caso nuevo** (con la fecha y qué pasó).

Todos los comandos se corren desde `C:\Users\usuario\TasitaApp\api`, en PowerShell con `npx.cmd`
(no `npx`). Si wrangler pide login: Marc corre `npx.cmd wrangler login` y deja la ventana abierta.

---

## 0. Datos que hay que tener antes de empezar

- **El código de la persona** (`tas_…`). Aparece abajo de todo en el cartel de pago, o en Más → "Mi código".
- **El email con el que pagó en Mercado Pago** (o su nombre: se ve en MP → Planes de suscripción → Clientes).
- Captura de lo que ve, si hay.

Consulta de arranque (reemplazar el código y el email):

```
npx.cmd wrangler d1 execute tasita --remote --json --command "SELECT * FROM suscripciones WHERE codigo='tas_XXX'; SELECT * FROM suscripciones WHERE email='EMAIL'; SELECT * FROM usuarios WHERE codigo='tas_XXX'; SELECT * FROM control_mp; SELECT id, recibido, tipo, mp_id, codigo, email, estado, hasta FROM eventos_mp ORDER BY id DESC LIMIT 10;"
```

Y lo que le contesta el servidor a su app (tiene que decir `activa:true`):

```
curl -s -H "Origin: https://presupuesto.tasita.com.ar" "https://tasita-api.rodrigogalarzaok.workers.dev/suscripcion?codigo=tas_XXX"
```

---

## 1. ¿Mercado Pago avisó / nos enteramos del pago?

**Caso real 2026-09-16 (Walter):** pagó y no entraba. En `eventos_mp` no había ni un aviso real.
**Causa:** MP NO manda avisos de este plan. El plan se creó desde el panel de MP y las suscripciones
quedan en otra aplicación (`application_id` 3909856389923111; la nuestra es 5520349572995061).
El webhook no va a llegar nunca: **no perder tiempo buscando por ahí.**

Hoy nos enteramos por dos caminos propios:
- **Cron cada hora** (`sincronizarPlan`) → mirar `control_mp`:
  - `revisado` de hace más de 2 horas → el cron no está corriendo. Ver `[triggers]` en `wrangler.toml` y redeployar.
  - `error` con texto → MP no respondió o falta el token (`MP_ACCESS_TOKEN`: si dice 401, está vencido o mal cargado; Marc lo renueva en el panel de desarrolladores y lo carga con `npx.cmd wrangler secret put MP_ACCESS_TOKEN`).
- **Al abrir la app** una persona bloqueada que dejó email (`buscarPagoPorEmail`). En `eventos_mp` queda como `tipo = 'consulta_directa'` cuando activa a alguien.

Forzar una revisión ya mismo (usa la base real):
```
npx.cmd wrangler dev --remote --test-scheduled --port 8799      (en segundo plano)
curl http://127.0.0.1:8799/__scheduled
```
El resultado sale en la consola como `Sincronización con MP: {…}`.

## 2. ¿El email de Tasita coincide con el de Mercado Pago?

Cómo se reconoce un pago: al tocar "Suscribirme" la app guarda un email pegado al código del celular
(tabla `suscripciones`). MP dice "pagó la cuenta X" y se busca qué código dejó ese email.

- Si `control_mp.sin_duenio` tiene algo → **alguien pagó y no coincide con ningún email de Tasita**.
  Trae el email de MP y la fecha. Comparar con los emails de ese día que quedaron sin pagar:
  ```
  npx.cmd wrangler d1 execute tasita --remote --json --command "SELECT codigo, email, actualizado FROM suscripciones WHERE activa = 0 AND email IS NOT NULL ORDER BY actualizado DESC LIMIT 20;"
  ```
  Típico: una letra de menos, o hotmail en Tasita y gmail en MP.
- Arreglo sin tocar nada: que la persona toque "Suscribirme" y escriba el email de MP → entra sola
  (el servidor le pregunta a MP en ese momento).
- Arreglo a mano (con el código correcto y confirmado con Marc):
  ```
  npx.cmd wrangler d1 execute tasita --remote --command "UPDATE suscripciones SET email='EMAIL_DE_MP' WHERE codigo='tas_XXX';"
  ```
  y después pedir `/suscripcion?codigo=tas_XXX`: se activa solo al consultar a MP.

**Walter NO tuvo este problema:** la búsqueda en MP con el email que dejó lo encontró al primer intento.

## 3. ¿Se cobró la renovación del mes?

- El acceso vale hasta **último cobro real de MP + 1 mes + 3 días** (`calcularHasta`). No se usa la "próxima fecha de cobro": si el cobro falla, no se regala el mes.
- En el panel, tabla "Quién / Paga hasta": al día siguiente del cobro la fecha tiene que haber pasado al mes siguiente.
- Si no cambió, ver en MP qué pasó. El token vive solo en el Worker: agregar **temporalmente** en `worker.js`
  una ruta que llame a `pedirAMP` con
  `https://api.mercadopago.com/preapproval/<mp_id>` y
  `https://api.mercadopago.com/authorized_payments/search?preapproval_id=<mp_id>`
  (ocultando email, nombre y tarjeta en la respuesta), correr `npx.cmd wrangler dev --remote --port 8799`,
  consultar con curl y **revertir con `git checkout -- api/src/worker.js`. Nunca deployar esa ruta.**
  - `summarized.last_charged_date` viejo, `semaphore` amarillo/rojo, cobro `rejected` → **MP no pudo cobrar** (tarjeta). No es nuestro: sigue entrando hasta la fecha + 3 días y se destraba solo cuando MP cobre.
  - `last_charged_date` nuevo pero la base no cambió → **es nuestro**: revisar punto 1 (cron) y forzar revisión.
- Primera renovación real: Walter, 15/10/2026 (tarea programada `tasita-renovacion-walter` lo revisa el 16/10).

## 4. Tiene la suscripción, pero en OTRO celular o navegador

El código vive en el navegador. Instagram → Chrome → app instalada pueden ser 3 códigos distintos.
Si pagó desde uno y abre otro, ese otro no tiene suscripción.
- Síntoma: al tocar "Suscribirme" con su email le sale *"Ese email ya tiene una suscripción activa en otro dispositivo"* (es el candado anti-robo, `409 ocupado`: **no sacarlo**).
- Verificar que es la misma persona (Marc habla con ella) y pasar la suscripción al código nuevo:
  ```
  npx.cmd wrangler d1 execute tasita --remote --command "UPDATE suscripciones SET codigo='tas_NUEVO' WHERE codigo='tas_VIEJO';"
  ```
  (si `tas_NUEVO` ya tiene fila, borrarla antes). Ojo: sus movimientos están en `datos` con el código viejo.
- iPhone: si paga desde la app instalada, MP la devuelve a Safari, que es otro almacenamiento. El pago se reconoce igual (el email quedó guardado desde la app) y al volver a la app entra.

## 5. El servidor dice activa:true pero la app sigue bloqueada

- La app guarda el estado en el celular y lo revalida al abrir y al volver a la pantalla (`verificarSuscripcion`, `revisarPagoAlVolver`). Primero: **cerrar la app del todo y abrirla con internet.**
- Si igual no: probar en el navegador con el código reservado `tas_claudeprueba` reproduciendo su estado (ver `feedback_tasita_codigo_pruebas`). Nunca entrar con el código del cliente (son sus datos).
- Si tocó "Ya pagué" varias veces seguidas: el servidor consulta a MP como mucho cada 10 s por código. Esperar y volver a abrir.

## 6. Le cobraron y se dio de baja / pidió devolución

- Canceló: **sigue entrando hasta que termina el mes pagado** (decisión de Marc). No es un error.
- **Cómo nos enteramos de una baja:** MP no avisa, así que la revisión de cada hora también mira las
  suscripciones que ya no están activas (`cancelled`, `paused`) y anota el estado en `suscripciones.estado`
  (buscando por `mp_id`, así una baja vieja no pisa una suscripción nueva). En el panel: tarjeta
  "se dieron de baja" y, en la tabla "Quién / Paga hasta", la etiqueta roja "se dio de baja".
  Tarda como mucho una hora en aparecer. Agregado el 2026-09-16.
- Contracargo o devolución (`charged_back`, `refunded`, `cancelled_by_chargeback`): se corta en el momento.

---

## Historial de casos

| Fecha | Quién | Qué pasó | Punto |
|---|---|---|---|
| 2026-09-16 | Walter (tas_u0f78j4zeh) | Pagó y no entraba: MP nunca avisa de este plan. Se agregó la consulta directa a MP y el cron. | 1 |
