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
