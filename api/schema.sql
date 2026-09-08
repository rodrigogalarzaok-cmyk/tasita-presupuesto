-- Base de datos de Tasita Presupuesto (Cloudflare D1)
-- Aplicar con:  npx wrangler d1 execute tasita --remote --file=./schema.sql

-- Una fila por usuario (el código anónimo que genera la app: tas_xxxxxxxxxx).
-- 'email' es el que la persona deja al ir a pagar. Mercado Pago identifica a
-- quien paga por su email y no deja pegarle nuestro código al link del plan,
-- así que es la única forma de reconocer el pago y activar la cuenta sola.
CREATE TABLE IF NOT EXISTS suscripciones (
  codigo      TEXT PRIMARY KEY,   -- tas_xxxxxxxxxx
  activa      INTEGER NOT NULL DEFAULT 0,  -- 1 = paga y vigente
  hasta       TEXT,               -- 'YYYY-MM-DD' hasta cuándo tiene acceso
  email       TEXT,               -- el que declaró para pagar
  mp_id       TEXT,               -- id del pago/suscripción en Mercado Pago
  actualizado TEXT,               -- ISO del último cambio
  -- Lo último que informó Mercado Pago ('al dia', 'cancelled', 'paused'…).
  -- Cancelar NO corta el acceso: el mes pagado se respeta y la fila se vence
  -- sola. Esto es solo para saber quiénes se van a ir cuando se les termine.
  estado      TEXT
);

CREATE INDEX IF NOT EXISTS idx_sub_email ON suscripciones (email);

-- Registro crudo de todo lo que manda Mercado Pago.
-- Guarda el email y la vigencia calculada para poder activar a alguien que
-- pagó antes de dejar su email, o a mano si algo falla.
CREATE TABLE IF NOT EXISTS eventos_mp (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  recibido  TEXT NOT NULL,
  tipo      TEXT,
  mp_id     TEXT,
  codigo    TEXT,
  email     TEXT,
  estado    TEXT,
  hasta     TEXT,
  crudo     TEXT
);

CREATE INDEX IF NOT EXISTS idx_eventos_email ON eventos_mp (email);

CREATE INDEX IF NOT EXISTS idx_eventos_codigo ON eventos_mp (codigo);

-- Los movimientos del usuario, guardados como UNA SOLA FILA por persona.
--
-- Por qué una fila y no una por movimiento: D1 gratis cobra por filas leídas
-- y escritas, no por tamaño. La app siempre carga todos los movimientos juntos
-- (filtra por mes en el celular), así que no gana nada teniéndolos separados.
-- Así, abrir la app = 1 fila leída y guardar = 1 fila escrita, tenga la persona
-- 10 movimientos o 10.000. Con 1000 usuarios activos esto usa una fracción
-- mínima del plan gratis (5 millones de lecturas y 100.000 escrituras por día).
--
-- 'version' sube en cada guardado: sirve para que la app no se traiga los datos
-- si no cambiaron, y para detectar que dos celulares editaron lo mismo.
CREATE TABLE IF NOT EXISTS datos (
  codigo      TEXT PRIMARY KEY,
  contenido   TEXT NOT NULL,               -- JSON: { txs: [...], borrados: [...] }
  version     INTEGER NOT NULL DEFAULT 1,
  actualizado TEXT
);

-- Quién entró y cuándo. Tabla aparte a propósito: no toca ni la suscripción ni
-- los movimientos, así que si algo de acá falla la app sigue andando igual.
--
-- Se llena sola: cada vez que alguien abre la app, el Worker anota el día. No
-- guarda nada de la persona (ni nombre, ni movimientos, ni plata), solo el
-- código anónimo y fechas — lo justo para saber cuánta gente hay y quién sigue
-- usando la app.
CREATE TABLE IF NOT EXISTS usuarios (
  codigo TEXT PRIMARY KEY,
  creado TEXT,                          -- 'YYYY-MM-DD': el primer día que se lo vio
  visto  TEXT,                          -- 'YYYY-MM-DD': el último día que abrió la app
  dias   INTEGER NOT NULL DEFAULT 1,    -- cuántos días distintos la abrió (retención)
  origen TEXT,                          -- 'vivo' | 'reconstruido' (los de antes del cambio)
  -- 1 = somos nosotros probando, no un cliente. Se marca desde el panel y queda
  -- afuera de todos los números. Nunca se borra la fila: los movimientos de esos
  -- equipos son reales y sirven para probar.
  interno INTEGER NOT NULL DEFAULT 0,
  -- 1 = esta persona ya puso su nombre en la app, o sea que entró de verdad y no
  -- pasó de largo. Es el número que cuenta personas: alguien puede abrir la app
  -- en el navegador de Instagram, después en Chrome y después instalada, y eso
  -- son tres códigos distintos para un solo ser humano — pero el nombre lo pone
  -- una sola vez, donde se queda. Nunca vuelve a 0.
  activo INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_usuarios_creado ON usuarios (creado);

CREATE INDEX IF NOT EXISTS idx_usuarios_visto ON usuarios (visto);

-- ── Migraciones aplicadas sobre la base que ya estaba en producción.
--    Arriba están dentro del CREATE TABLE (para una base nueva); acá quedan
--    anotadas como referencia de lo que se corrió a mano y cuándo. SQLite no
--    tiene "ADD COLUMN IF NOT EXISTS": si se corre este archivo entero sobre la
--    base que ya existe, estas dos líneas dan "duplicate column name" y se
--    pueden ignorar, no rompen nada.
--
--    2026-09-04:  ALTER TABLE suscripciones ADD COLUMN estado TEXT;
--    2026-09-08:  ALTER TABLE usuarios ADD COLUMN activo INTEGER NOT NULL DEFAULT 0;
