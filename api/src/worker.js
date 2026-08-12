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
      if (url.pathname === '/datos' && request.method === 'GET') {
        return await getDatos(url, env);
      }
      if (url.pathname === '/datos' && request.method === 'PUT') {
        return await putDatos(request, env);
      }
      if (url.pathname === '/email' && request.method === 'POST') {
        return await registrarEmail(request, env);
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
  const codigo = codigoValido(url.searchParams.get('codigo'));
  if (!codigo) return responder({ error: 'código inválido' }, 400, env);

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

// ── La app se trae los movimientos guardados.
//    Si manda la versión que ya tiene y no cambió nada, no se le devuelve el
//    contenido: se ahorra el tráfico y la app usa lo que tiene en el celular.
async function getDatos(url, env) {
  const codigo = codigoValido(url.searchParams.get('codigo'));
  if (!codigo) return responder({ error: 'código inválido' }, 400, env);

  const version = parseInt(url.searchParams.get('version') || '0', 10) || 0;

  const fila = await env.DB
    .prepare('SELECT contenido, version FROM datos WHERE codigo = ?')
    .bind(codigo)
    .first();

  if (!fila) return responder({ version: 0, contenido: null }, 200, env);
  if (version && fila.version <= version) {
    return responder({ sinCambios: true, version: fila.version }, 200, env);
  }
  return responder({ version: fila.version, contenido: fila.contenido }, 200, env);
}

// ── La app guarda sus movimientos. Una fila por persona, se pisa entera.
async function putDatos(request, env) {
  let cuerpo;
  try { cuerpo = await request.json(); } catch { return responder({ error: 'cuerpo inválido' }, 400, env); }

  const codigo = codigoValido(cuerpo && cuerpo.codigo);
  if (!codigo) return responder({ error: 'código inválido' }, 400, env);

  const contenido = typeof cuerpo.contenido === 'string' ? cuerpo.contenido : null;
  if (!contenido) return responder({ error: 'falta contenido' }, 400, env);

  // Tope de tamaño: Tasita guarda ingresos y egresos, nada pesado. Sin este
  // límite, un error en la app (o alguien de mala fe) podría llenar la base.
  if (contenido.length > 1_000_000) return responder({ error: 'demasiado grande' }, 413, env);

  const base = parseInt(cuerpo.base, 10) || 0;   // versión que la app vio por última vez

  const fila = await env.DB
    .prepare('SELECT contenido, version FROM datos WHERE codigo = ?')
    .bind(codigo)
    .first();
  const actual = fila ? fila.version : 0;

  // Otro celular guardó primero: no se pisa nada. Se le devuelve lo que hay
  // para que la app junte los dos lados y vuelva a intentar.
  if (base !== actual) {
    return responder({ conflicto: true, version: actual, contenido: fila ? fila.contenido : null }, 409, env);
  }

  const nueva = actual + 1;
  await env.DB.prepare(`
    INSERT INTO datos (codigo, contenido, version, actualizado)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(codigo) DO UPDATE SET
      contenido   = excluded.contenido,
      version     = excluded.version,
      actualizado = excluded.actualizado
  `).bind(codigo, contenido, nueva, new Date().toISOString()).run();

  return responder({ ok: true, version: nueva }, 200, env);
}

function codigoValido(c) {
  const s = String(c || '').trim();
  return /^tas_[a-z0-9]{4,20}$/i.test(s) ? s : null;
}

function emailValido(e) {
  const s = String(e || '').trim().toLowerCase();
  return s.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) ? s : null;
}

// ── La app avisa con qué email va a pagar esta persona.
//    Si resulta que ya había pagado antes de dejarlo, se activa en el momento.
async function registrarEmail(request, env) {
  let cuerpo;
  try { cuerpo = await request.json(); } catch { return responder({ error: 'cuerpo inválido' }, 400, env); }

  const codigo = codigoValido(cuerpo && cuerpo.codigo);
  const email  = emailValido(cuerpo && cuerpo.email);
  if (!codigo) return responder({ error: 'código inválido' }, 400, env);
  if (!email)  return responder({ error: 'email inválido' }, 400, env);

  // Un email pago no se le puede pegar a otro código. Sin esto, cualquiera que
  // conozca el email de un suscriptor lo carga en su app y se queda con la
  // suscripción ajena — y en la renovación el pago se le acreditaría al ladrón,
  // dejando afuera a quien paga.
  const duenio = await env.DB.prepare(
    'SELECT codigo, hasta FROM suscripciones WHERE email = ? AND activa = 1 LIMIT 1'
  ).bind(email).first();

  if (duenio && duenio.codigo !== codigo && duenio.hasta && duenio.hasta >= hoyISO()) {
    return responder({ error: 'email en uso', ocupado: true }, 409, env);
  }

  const ahora = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO suscripciones (codigo, activa, email, actualizado)
    VALUES (?, 0, ?, ?)
    ON CONFLICT(codigo) DO UPDATE SET email = excluded.email, actualizado = excluded.actualizado
  `).bind(codigo, email, ahora).run();

  // ¿Pagó antes de dejar el email? El aviso quedó guardado esperando.
  const ev = await env.DB.prepare(`
    SELECT mp_id, hasta FROM eventos_mp
    WHERE email = ? AND hasta IS NOT NULL AND estado IN ('approved', 'authorized')
    ORDER BY id DESC LIMIT 1
  `).bind(email).first();

  if (ev && ev.hasta >= hoyISO()) {
    await activarSuscripcion(env, codigo, ev.hasta, ev.mp_id, email);
    return responder({ activa: true, hasta: ev.hasta }, 200, env);
  }
  return responder({ activa: false }, 200, env);
}

// Deja la suscripción paga y vigente. Nunca acorta una vigencia ya dada.
async function activarSuscripcion(env, codigo, hasta, mpId, email) {
  await env.DB.prepare(`
    INSERT INTO suscripciones (codigo, activa, hasta, email, mp_id, actualizado)
    VALUES (?, 1, ?, ?, ?, ?)
    ON CONFLICT(codigo) DO UPDATE SET
      activa      = 1,
      hasta       = MAX(COALESCE(suscripciones.hasta, ''), COALESCE(excluded.hasta, '')),
      email       = COALESCE(excluded.email, suscripciones.email),
      mp_id       = excluded.mp_id,
      actualizado = excluded.actualizado
  `).bind(codigo, hasta, email || null, mpId || null, new Date().toISOString()).run();
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
    await registrar(env, tipo, mpId, null, null, 'ignorado', null, crudo);
    return responder({ ok: true }, 200, env);
  }

  const recurso = await traerDeMP(tipo, mpId, env);
  if (!recurso) {
    await registrar(env, tipo, mpId, null, null, 'no se pudo consultar', null, crudo);
    return responder({ ok: true }, 200, env);
  }

  const estado = recurso.status || '';
  // Las suscripciones traen 'payer_email'; los pagos sueltos lo traen anidado.
  const email  = emailValido(recurso.payer_email || (recurso.payer && recurso.payer.email));
  const paga   = estado === 'approved' || estado === 'authorized';
  const hasta  = paga ? calcularHasta(recurso) : null;

  // ¿De quién es este pago? Si vino el código, se usa; si no, se busca por el
  // email que la persona dejó al ir a pagar.
  let codigo = codigoValido(recurso.external_reference);
  if (!codigo && email) {
    // Si ya hay una suscripción activa con ese email, la renovación es de ella.
    // Recién si no hay ninguna se usa el registro más reciente.
    const fila = await env.DB.prepare(
      'SELECT codigo FROM suscripciones WHERE email = ? ORDER BY activa DESC, actualizado DESC LIMIT 1'
    ).bind(email).first();
    if (fila) codigo = fila.codigo;
  }

  // Se guarda SIEMPRE el aviso, tenga dueño o no: si la persona todavía no dejó
  // su email, queda esperando y se activa sola en cuanto lo haga.
  await registrar(env, tipo, mpId, codigo, email, estado, hasta, crudo);

  if (codigo) {
    if (paga && hasta) {
      await activarSuscripcion(env, codigo, hasta, mpId, email);
    } else {
      // Cancelada o pausada: se corta el acceso, pero la fila queda.
      await env.DB.prepare('UPDATE suscripciones SET activa = 0, actualizado = ? WHERE codigo = ?')
        .bind(new Date().toISOString(), codigo).run();
    }
  }
  return responder({ ok: true }, 200, env);
}

// ── Le pregunta a Mercado Pago por el pago/suscripción real.
//    Cada tipo de aviso vive en un endpoint distinto. Mandar el id de un cobro
//    mensual al endpoint de suscripciones devuelve 404 y la renovación se
//    perdería, así que se elige bien antes de preguntar.
async function traerDeMP(tipo, mpId, env) {
  const t = String(tipo);
  let endpoint;
  if (t.includes('authorized_payment')) {
    endpoint = `https://api.mercadopago.com/authorized_payments/${mpId}`;  // cobro mensual de una suscripción
  } else if (t.includes('preapproval') || t.includes('subscription')) {
    endpoint = `https://api.mercadopago.com/preapproval/${mpId}`;          // la suscripción en sí
  } else {
    endpoint = `https://api.mercadopago.com/v1/payments/${mpId}`;          // pago suelto
  }

  const recurso = await pedirAMP(endpoint, env);
  if (!recurso) return null;

  // Un cobro mensual apunta a la suscripción de la persona. Se usa esa, que es
  // la que trae el email y hasta cuándo queda paga.
  const idSub = recurso.preapproval_id;
  if (idSub) {
    const sub = await pedirAMP(`https://api.mercadopago.com/preapproval/${idSub}`, env);
    if (sub) return sub;
  }
  return recurso;
}

async function pedirAMP(endpoint, env) {
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

async function registrar(env, tipo, mpId, codigo, email, estado, hasta, crudo) {
  try {
    await env.DB.prepare(
      'INSERT INTO eventos_mp (recibido, tipo, mp_id, codigo, email, estado, hasta, crudo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      new Date().toISOString(), tipo || null, mpId || null, codigo || null,
      email || null, estado || null, hasta || null, (crudo || '').slice(0, 4000)
    ).run();
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
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store'
    }
  });
}
