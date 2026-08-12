/**
 * Tasita Presupuesto — API de suscripciones (Cloudflare Worker + D1)
 *
 * Dos endpoints:
 *   GET  /suscripcion?codigo=tas_xxx  → la app pregunta si ese código tiene acceso
 *   POST /webhook-mp                  → Mercado Pago avisa de un pago (fuente de verdad)
 *
 * Por qué un Worker y no pegarle a la base directo desde la app:
 * la única llave que toca la base vive acá adentro. La app solo consulta
 * endpoints públicos de lectura, así que no hay nada que robar del HTML.
 */

const DIAS_GRACIA = 3; // margen por si MP se demora en cobrar la renovación

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return responder(null, 204, env);

    try {
      if (url.pathname === '/suscripcion' && request.method === 'GET') {
        return await getSuscripcion(url, env);
      }
      if (url.pathname === '/webhook-mp' && request.method === 'POST') {
        return await webhookMP(request, url, env);
      }
      if (url.pathname === '/' || url.pathname === '/salud') {
        return responder({ ok: true, servicio: 'tasita-api' }, 200, env);
      }
    } catch (e) {
      console.error('Error no controlado:', e && e.stack || e);
      return responder({ error: 'error interno' }, 500, env);
    }

    return responder({ error: 'no encontrado' }, 404, env);
  }
};

// ── La app pregunta: ¿este código tiene la suscripción al día?
async function getSuscripcion(url, env) {
  const codigo = (url.searchParams.get('codigo') || '').trim();
  if (!/^tas_[a-z0-9]{4,20}$/i.test(codigo)) {
    return responder({ error: 'código inválido' }, 400, env);
  }

  const fila = await env.DB
    .prepare('SELECT activa, hasta FROM suscripciones WHERE codigo = ?')
    .bind(codigo)
    .first();

  if (!fila || !fila.activa || !fila.hasta) {
    return responder({ activa: false }, 200, env);
  }

  // Vencida: la fila queda, pero ya no da acceso.
  if (fila.hasta < hoyISO()) return responder({ activa: false, hasta: fila.hasta }, 200, env);

  return responder({ activa: true, hasta: fila.hasta }, 200, env);
}

// ── Mercado Pago avisa que pasó algo con un pago o una suscripción.
//    Nunca se confía en el cuerpo del aviso: se le vuelve a preguntar a MP
//    con el token secreto, porque cualquiera puede hacer POST a esta URL.
async function webhookMP(request, url, env) {
  const crudo = await request.text();
  let cuerpo = {};
  try { cuerpo = JSON.parse(crudo || '{}'); } catch { /* MP a veces avisa solo por query */ }

  const tipo = cuerpo.type || cuerpo.topic || url.searchParams.get('type') || url.searchParams.get('topic') || '';
  const mpId = String(
    (cuerpo.data && cuerpo.data.id) || cuerpo.id || url.searchParams.get('data.id') || url.searchParams.get('id') || ''
  );

  // Siempre se responde 200: si se devuelve error, MP reintenta el mismo aviso durante días.
  if (!mpId || !env.MP_ACCESS_TOKEN) {
    await registrar(env, tipo, mpId, null, 'ignorado', crudo);
    return responder({ ok: true }, 200, env);
  }

  const recurso = await traerDeMP(tipo, mpId, env);
  if (!recurso) {
    await registrar(env, tipo, mpId, null, 'no se pudo consultar', crudo);
    return responder({ ok: true }, 200, env);
  }

  const codigo = (recurso.external_reference || '').trim();
  const estado = recurso.status || '';

  if (!/^tas_[a-z0-9]{4,20}$/i.test(codigo)) {
    // Pago sin código: se guarda igual para poder activarlo a mano desde la base.
    await registrar(env, tipo, mpId, codigo || null, estado, crudo);
    return responder({ ok: true }, 200, env);
  }

  const paga = estado === 'approved' || estado === 'authorized';
  const hasta = paga ? calcularHasta(recurso) : null;

  await env.DB.prepare(`
    INSERT INTO suscripciones (codigo, activa, hasta, mp_id, actualizado)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(codigo) DO UPDATE SET
      activa      = excluded.activa,
      hasta       = MAX(COALESCE(suscripciones.hasta, ''), COALESCE(excluded.hasta, '')),
      mp_id       = excluded.mp_id,
      actualizado = excluded.actualizado
  `).bind(codigo, paga ? 1 : 0, hasta, mpId, new Date().toISOString()).run();

  await registrar(env, tipo, mpId, codigo, estado, crudo);
  return responder({ ok: true }, 200, env);
}

// ── Le pregunta a Mercado Pago por el pago/suscripción real.
async function traerDeMP(tipo, mpId, env) {
  const esSuscripcion = String(tipo).includes('preapproval') || String(tipo).includes('subscription');
  const endpoint = esSuscripcion
    ? `https://api.mercadopago.com/preapproval/${mpId}`
    : `https://api.mercadopago.com/v1/payments/${mpId}`;

  const r = await fetch(endpoint, { headers: { Authorization: `Bearer ${env.MP_ACCESS_TOKEN}` } });
  if (!r.ok) {
    console.error('MP respondió', r.status, 'para', endpoint);
    return null;
  }
  return await r.json();
}

// ── Hasta cuándo vale el acceso.
function calcularHasta(recurso) {
  // Suscripción: MP dice cuándo cobra la próxima cuota.
  if (recurso.next_payment_date) return sumarDias(soloFecha(recurso.next_payment_date), DIAS_GRACIA);
  // Pago suelto: un mes desde que se aprobó.
  const base = soloFecha(recurso.date_approved || recurso.date_created || new Date().toISOString());
  return sumarDias(base, 30 + DIAS_GRACIA);
}

function soloFecha(iso) { return String(iso).slice(0, 10); }

function sumarDias(iso, dias) {
  const [a, m, d] = iso.split('-').map(Number);
  const t = Date.UTC(a, m - 1, d) + dias * 86400000;
  const f = new Date(t);
  return [f.getUTCFullYear(), String(f.getUTCMonth() + 1).padStart(2, '0'), String(f.getUTCDate()).padStart(2, '0')].join('-');
}

// Fecha de hoy en Argentina (UTC-3), no en UTC — mismo criterio que la app.
function hoyISO() {
  const f = new Date(Date.now() - 3 * 3600000);
  return [f.getUTCFullYear(), String(f.getUTCMonth() + 1).padStart(2, '0'), String(f.getUTCDate()).padStart(2, '0')].join('-');
}

async function registrar(env, tipo, mpId, codigo, estado, crudo) {
  try {
    await env.DB.prepare(
      'INSERT INTO eventos_mp (recibido, tipo, mp_id, codigo, estado, crudo) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(new Date().toISOString(), tipo || null, mpId || null, codigo || null, estado || null, (crudo || '').slice(0, 4000)).run();
  } catch (e) {
    console.error('No se pudo registrar el evento:', e);
  }
}

function responder(datos, status, env) {
  return new Response(datos === null ? null : JSON.stringify(datos), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': env.ORIGEN_APP || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store'
    }
  });
}
