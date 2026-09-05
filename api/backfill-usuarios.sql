-- Rellena la tabla 'usuarios' con la gente que ya estaba adentro antes de que
-- existiera el registro de visitas. Se corre UNA sola vez:
--
--   npx wrangler d1 execute tasita --remote --file=./backfill-usuarios.sql
--
-- De dónde sale la fecha de alta de alguien de quien nunca anotamos nada:
-- el id de cada movimiento arranca con el timestamp del momento exacto en que
-- se cargó ("1756...-a3f9"). O sea que el movimiento más viejo de una persona
-- dice cuándo empezó a usar Tasita. No es el día que instaló la app, es el día
-- que cargó su primer movimiento — que para el negocio es lo mismo o mejor.
--
-- 'visto' sale de la última sincronización, que es lo último que sabemos de esa
-- persona. Quedan marcados como 'reconstruido' para no confundirlos con los que
-- se registran solos de acá en adelante.
--
-- No pisa nada: si el código ya está en la tabla, lo deja como está.

-- 'OR IGNORE': si el código ya está en la tabla, se saltea esa fila y sigue.
INSERT OR IGNORE INTO usuarios (codigo, creado, visto, dias, origen)
SELECT
  d.codigo,
  COALESCE(
    date(MIN(CAST(json_extract(j.value, '$.id') AS INTEGER)) / 1000, 'unixepoch'),
    substr(d.actualizado, 1, 10)
  ),
  substr(d.actualizado, 1, 10),
  1,
  'reconstruido'
FROM datos d
LEFT JOIN json_each(json_extract(d.contenido, '$.txs')) j
  ON CAST(json_extract(j.value, '$.id') AS INTEGER) > 1600000000000
GROUP BY d.codigo;

-- Los que dejaron su email para pagar pero todavía no habían guardado
-- movimientos: también son gente adentro y no hay que perderlos.
INSERT OR IGNORE INTO usuarios (codigo, creado, visto, dias, origen)
SELECT s.codigo, substr(s.actualizado, 1, 10), substr(s.actualizado, 1, 10), 1, 'reconstruido'
FROM suscripciones s;
