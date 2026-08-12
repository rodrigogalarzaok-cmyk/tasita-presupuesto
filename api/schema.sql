-- Base de datos de Tasita Presupuesto (Cloudflare D1)
-- Aplicar con:  npx wrangler d1 execute tasita --remote --file=./schema.sql

-- Una fila por usuario (el código anónimo que genera la app: tas_xxxxxxxxxx).
CREATE TABLE IF NOT EXISTS suscripciones (
  codigo      TEXT PRIMARY KEY,   -- tas_xxxxxxxxxx
  activa      INTEGER NOT NULL DEFAULT 0,  -- 1 = paga y vigente
  hasta       TEXT,               -- 'YYYY-MM-DD' hasta cuándo tiene acceso
  mp_id       TEXT,               -- id del pago/suscripción en Mercado Pago
  actualizado TEXT                -- ISO del último cambio
);

-- Registro crudo de todo lo que manda Mercado Pago.
-- Sirve para reconstruir a mano un pago que no se haya podido procesar.
CREATE TABLE IF NOT EXISTS eventos_mp (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  recibido  TEXT NOT NULL,
  tipo      TEXT,
  mp_id     TEXT,
  codigo    TEXT,
  estado    TEXT,
  crudo     TEXT
);

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
