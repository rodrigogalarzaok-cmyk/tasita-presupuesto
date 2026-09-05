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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return responder(null, 204, env);

    // Anotar quién entró se hace SIEMPRE en segundo plano (waitUntil): la
    // respuesta a la app sale sin esperarlo y, si la anotación falla, no se
    // entera nadie. Nunca puede romper ni demorar lo que la persona está usando.
    const visita = (codigo) => {
      if (codigo && ctx && ctx.waitUntil) ctx.waitUntil(marcarVisita(env, codigo));
    };

    try {
      if (url.pathname === '/suscripcion' && request.method === 'GET') {
        visita(codigoValido(url.searchParams.get('codigo')));
        return await getSuscripcion(url, env);
      }
      if (url.pathname === '/webhook-mp' && request.method === 'POST') {
        return await webhookMP(request, url, env);
      }
      if (url.pathname === '/datos' && request.method === 'GET') {
        visita(codigoValido(url.searchParams.get('codigo')));
        return await getDatos(url, env);
      }
      if (url.pathname === '/datos' && request.method === 'PUT') {
        return await putDatos(request, env, visita);
      }
      if (url.pathname === '/panel' && request.method === 'GET') {
        return await panel(url, env);
      }
      // Lo que el teléfono necesita para dejarlo instalar como app.
      if (url.pathname === '/panel/manifest.json' && request.method === 'GET') {
        return manifestPanel(url, env);
      }
      if (url.pathname === '/panel/sw.js' && request.method === 'GET') {
        return swPanel();
      }
      if (url.pathname === '/panel/interno' && request.method === 'POST') {
        return await marcarInterno(request, url, env);
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
async function putDatos(request, env, visita) {
  let cuerpo;
  try { cuerpo = await request.json(); } catch { return responder({ error: 'cuerpo inválido' }, 400, env); }

  const codigo = codigoValido(cuerpo && cuerpo.codigo);
  if (!codigo) return responder({ error: 'código inválido' }, 400, env);
  if (visita) visita(codigo);   // el código viene en el cuerpo, así que se anota acá

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

  const { recurso, httpMP } = await traerDeMP(tipo, mpId, env);
  if (!recurso) {
    // Se anota QUÉ contestó Mercado Pago: 401 es token vencido o mal cargado,
    // 404 es que ese pago no existe. Sin este dato hay que adivinar.
    await registrar(env, tipo, mpId, null, null, `no se pudo consultar (MP ${httpMP})`, null, crudo);
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

  const primero = await pedirAMP(endpoint, env);
  if (!primero.recurso) return { recurso: null, httpMP: primero.http };

  // Un cobro mensual apunta a la suscripción de la persona. Se usa esa, que es
  // la que trae el email y hasta cuándo queda paga.
  const idSub = primero.recurso.preapproval_id;
  if (idSub) {
    const sub = await pedirAMP(`https://api.mercadopago.com/preapproval/${idSub}`, env);
    if (sub.recurso) return { recurso: sub.recurso, httpMP: sub.http };
  }
  return { recurso: primero.recurso, httpMP: primero.http };
}

async function pedirAMP(endpoint, env) {
  try {
    const r = await fetch(endpoint, { headers: { Authorization: `Bearer ${env.MP_ACCESS_TOKEN}` } });
    if (!r.ok) {
      console.error('MP respondió', r.status, 'para', endpoint);
      return { recurso: null, http: r.status };
    }
    return { recurso: await r.json(), http: r.status };
  } catch (e) {
    console.error('No se pudo llegar a MP:', e);
    return { recurso: null, http: 'sin respuesta' };
  }
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

// ── Anota que esta persona abrió la app hoy.
//
//    Escribe UNA sola vez por día por persona: si ya la vimos hoy, el UPDATE no
//    corre (por el WHERE del final) y no se gasta escritura en la base. Abrir la
//    app veinte veces en el día cuesta lo mismo que abrirla una.
//
//    Si algo falla acá, se ignora: es un registro para nosotros, no puede dejar
//    a nadie sin poder usar Tasita.
async function marcarVisita(env, codigo) {
  const hoy = hoyISO();
  try {
    await env.DB.prepare(`
      INSERT INTO usuarios (codigo, creado, visto, dias, origen)
      VALUES (?, ?, ?, 1, 'vivo')
      ON CONFLICT(codigo) DO UPDATE SET
        dias  = usuarios.dias + 1,
        visto = excluded.visto
      WHERE usuarios.visto < excluded.visto
    `).bind(codigo, hoy, hoy).run();
  } catch (e) {
    console.error('No se pudo anotar la visita:', e);
  }
}

// El día que se prendió el cobro. Antes de esta fecha nadie tenía el reloj de
// la prueba corriendo, así que para los de la beta los 20 días arrancan acá.
// Tiene que coincidir con PAGOS.DIAS_PRUEBA y COBRO_ACTIVO de la app.
const LANZAMIENTO = '2026-08-25';
const DIAS_PRUEBA = 20;

// ── Panel privado: los números del negocio en una página que se abre en el celular.
//    Se entra con  /panel?clave=...  y la clave vive como secret de Cloudflare.
async function panel(url, env) {
  if (!env.CLAVE_PANEL) {
    return pagina('Falta la clave', 'Cargala una sola vez desde la carpeta <code>api</code>:<br><br><code>npx wrangler secret put CLAVE_PANEL</code>', 503);
  }
  if ((url.searchParams.get('clave') || '') !== env.CLAVE_PANEL) {
    return pagina('Clave incorrecta', 'El link tiene que terminar en <code>?clave=…</code>', 401);
  }

  // 'now' es UTC; Argentina está tres horas atrás. Mismo criterio que el resto.
  const HOY = "date('now','-3 hours')";

  // 'interno = 0' en todos lados: los equipos nuestros no cuentan como clientes.
  const [resumen, altas, vencen, ultimos, eventos] = await env.DB.batch([
    env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM usuarios WHERE interno = 0)                                AS total,
        (SELECT COUNT(*) FROM usuarios WHERE interno = 1)                                AS internos,
        (SELECT COUNT(*) FROM usuarios WHERE interno = 0 AND creado = ${HOY})             AS altas_hoy,
        (SELECT COUNT(*) FROM usuarios WHERE interno = 0 AND creado >= date(${HOY},'-6 days'))  AS altas_7,
        (SELECT COUNT(*) FROM usuarios WHERE interno = 0 AND creado >= date(${HOY},'-29 days')) AS altas_30,
        (SELECT COUNT(*) FROM usuarios WHERE interno = 0 AND visto  = ${HOY})             AS activos_hoy,
        (SELECT COUNT(*) FROM usuarios WHERE interno = 0 AND visto  >= date(${HOY},'-6 days'))  AS activos_7,
        (SELECT COUNT(*) FROM usuarios WHERE interno = 0 AND visto  >= date(${HOY},'-29 days')) AS activos_30,
        (SELECT COUNT(*) FROM suscripciones s WHERE s.activa = 1 AND s.hasta >= ${HOY}
           AND s.codigo NOT IN (SELECT codigo FROM usuarios WHERE interno = 1))          AS pagando,
        (SELECT COUNT(*) FROM suscripciones s WHERE s.email IS NOT NULL
           AND s.codigo NOT IN (SELECT codigo FROM usuarios WHERE interno = 1))          AS con_email,
        (SELECT COUNT(*) FROM suscripciones s WHERE s.email IS NOT NULL
           AND (s.activa = 0 OR s.hasta < ${HOY})
           AND s.codigo NOT IN (SELECT codigo FROM usuarios WHERE interno = 1))          AS email_sin_pagar
    `),
    env.DB.prepare(`
      SELECT creado AS dia, COUNT(*) AS n FROM usuarios
      WHERE interno = 0 AND creado >= date(${HOY},'-20 days') GROUP BY creado ORDER BY dia
    `),
    // Cuándo se le termina la prueba a cada uno. Es una estimación: el reloj de
    // los 20 días corre en el celular de la persona, el servidor no lo ve. Se
    // calcula desde el día que la vimos por primera vez (o desde el lanzamiento,
    // lo que sea más tarde). Los que ya pagan no cuentan.
    env.DB.prepare(`
      SELECT date(max(creado,'${LANZAMIENTO}'),'+${DIAS_PRUEBA} days') AS vence, COUNT(*) AS n
      FROM usuarios
      WHERE interno = 0 AND visto >= '${LANZAMIENTO}'
        AND codigo NOT IN (SELECT codigo FROM suscripciones WHERE activa = 1 AND hasta >= ${HOY})
      GROUP BY vence ORDER BY vence
    `),
    // La lista sí trae a todos, internos incluidos: es donde se los marca.
    // 'movs' cuenta los movimientos cargados, que es lo que distingue a alguien
    // que usa la app de verdad de una prueba de dos toques.
    env.DB.prepare(`
      SELECT u.codigo, u.creado, u.visto, u.dias, u.origen, u.interno, s.email,
             (s.activa = 1 AND s.hasta >= ${HOY}) AS paga,
             (SELECT COUNT(*) FROM json_each(json_extract(d.contenido,'$.txs'))) AS movs
      FROM usuarios u
      LEFT JOIN suscripciones s ON s.codigo = u.codigo
      LEFT JOIN datos d ON d.codigo = u.codigo
      ORDER BY u.interno, u.creado DESC, u.visto DESC
    `),
    env.DB.prepare(`
      SELECT substr(recibido,1,16) AS cuando, tipo, email, estado, hasta
      FROM eventos_mp ORDER BY id DESC LIMIT 8
    `)
  ]);

  const r = (resumen.results && resumen.results[0]) || {};
  const datos = {
    resumen: r,
    altas:   altas.results   || [],
    vencen:  vencen.results  || [],
    ultimos: ultimos.results || [],
    eventos: eventos.results || []
  };

  if (url.searchParams.get('json') !== null) {
    return new Response(JSON.stringify(datos, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }
  return pagina('Tasita — panel', cuerpoPanel(datos), 200, env.CLAVE_PANEL);
}

// ── Marcar (o desmarcar) a alguien como "somos nosotros probando".
//    No borra nada: la fila queda, sus movimientos quedan, y simplemente deja de
//    contar en los números. Se puede volver atrás con otro toque.
async function marcarInterno(request, url, env) {
  if (!env.CLAVE_PANEL || url.searchParams.get('clave') !== env.CLAVE_PANEL) {
    return responder({ error: 'clave incorrecta' }, 401, env);
  }
  const codigo = codigoValido(url.searchParams.get('codigo'));
  if (!codigo) return responder({ error: 'código inválido' }, 400, env);

  const interno = url.searchParams.get('interno') === '1' ? 1 : 0;
  await env.DB.prepare('UPDATE usuarios SET interno = ? WHERE codigo = ?').bind(interno, codigo).run();
  return responder({ ok: true, codigo, interno }, 200, env);
}

// ── Para que el teléfono lo deje "guardar como aplicación".
//    El ícono es un dibujo hecho acá mismo (tres barras), distinto al de Tasita:
//    así en el teléfono no se confunde el panel con la app de los clientes.
function manifestPanel(url, env) {
  if (!env.CLAVE_PANEL || url.searchParams.get('clave') !== env.CLAVE_PANEL) {
    return new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  const icono = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">' +
    '<rect width="192" height="192" rx="42" fill="#2f7d5d"/>' +
    '<rect x="46" y="104" width="24" height="46" rx="6" fill="#fff"/>' +
    '<rect x="84" y="72" width="24" height="78" rx="6" fill="#fff"/>' +
    '<rect x="122" y="42" width="24" height="108" rx="6" fill="#fff"/></svg>'
  );
  const manifest = {
    name: 'Tasita — panel',
    short_name: 'Panel',
    // Con la clave adentro: al tocar el ícono entra derecho, sin escribir nada.
    start_url: `/panel?clave=${encodeURIComponent(env.CLAVE_PANEL)}`,
    scope: '/panel',
    display: 'standalone',
    background_color: '#0f1115',
    theme_color: '#0f1115',
    icons: [
      { src: icono, sizes: '192x192', type: 'image/svg+xml', purpose: 'any' },
      { src: icono, sizes: '512x512', type: 'image/svg+xml', purpose: 'maskable' }
    ]
  };
  return new Response(JSON.stringify(manifest), {
    status: 200,
    headers: { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

// El panel NO guarda nada en el teléfono: cada vez que se abre va a buscar los
// números del momento. Este archivo existe solo porque el teléfono lo pide para
// permitir instalarlo como app.
function swPanel() {
  return new Response(
    `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => { e.respondWith(fetch(e.request)); });`,
    {
      status: 200,
      headers: {
        'Content-Type': 'text/javascript; charset=utf-8',
        // Permite que el archivo, viviendo en /panel/, mande también sobre /panel.
        'Service-Worker-Allowed': '/panel',
        'Cache-Control': 'no-store'
      }
    }
  );
}

function esc(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function cuerpoPanel(d) {
  const r = d.resumen;
  const hoy = hoyISO();

  const tarjeta = (n, t, extra) =>
    `<div class="c"><b>${esc(n)}</b><span>${esc(t)}</span>${extra ? `<i>${esc(extra)}</i>` : ''}</div>`;

  // Barras de altas por día: el alto de cada una es relativo al mejor día.
  const tope = Math.max(1, ...d.altas.map(a => a.n));
  const barras = d.altas.length
    ? d.altas.map(a => `<div class="b" title="${esc(a.dia)}: ${esc(a.n)}">
         <u style="height:${Math.round((a.n / tope) * 60) + 4}px"></u>
         <em>${esc(a.n)}</em><s>${esc(a.dia.slice(8))}/${esc(a.dia.slice(5, 7))}</s></div>`).join('')
    : '<p class="vacio">Todavía no hay altas en estos días.</p>';

  // '2026-09-14' → '14/09'. Las fechas largas parten la tabla en dos en el celular.
  const dm = (iso) => `${String(iso).slice(8)}/${String(iso).slice(5, 7)}`;

  const proximos = d.vencen.filter(v => v.vence >= hoy).slice(0, 8);
  const vencidos = d.vencen.filter(v => v.vence < hoy).reduce((s, v) => s + v.n, 0);
  const filasVence = proximos.length
    ? proximos.map(v => `<tr><td>${esc(dm(v.vence))}</td><td class="n">${esc(v.n)}</td>
        <td class="g">${v.vence === hoy ? 'hoy' : 'en ' + Math.round((Date.parse(v.vence) - Date.parse(hoy)) / 86400000) + ' días'}</td></tr>`).join('')
    : '<tr><td colspan="3" class="g">No queda nadie con prueba por vencer.</td></tr>';

  // Cuánto le queda de prueba a cada uno. Mismo cálculo que la app: 20 días
  // desde que arrancó, y nadie arrancó antes del día que se prendió el cobro.
  const prueba = (u) => {
    if (u.paga) return '<span class="ok">paga</span>';
    const vence = sumarDias(u.creado > LANZAMIENTO ? u.creado : LANZAMIENTO, DIAS_PRUEBA);
    const quedan = Math.round((Date.parse(vence) - Date.parse(hoy)) / 86400000);
    if (quedan < 0)  return '<span class="fin">terminó</span>';
    if (quedan === 0) return '<span class="fin">termina hoy</span>';
    return `quedan ${quedan}`;
  };

  // Lista y no tabla: en un teléfono, seis columnas obligan a arrastrar de
  // costado para llegar al botón. Así cada persona entra entera en el ancho.
  // El ≈ va pegado a la fecha de alta, que es el dato que es aproximado.
  const filasUltimos = d.ultimos.map(u => `<div class="p${u.interno ? ' i' : ''}">
      <div class="pd">
        <code>${esc(u.codigo)}</code>
        ${u.interno ? '<span class="mio">nuestro</span>'
                    : (u.paga ? '<span class="ok">paga</span>' : '')}
        <span class="pm">se sumó ${u.origen === 'reconstruido' ? '≈' : ''}${esc(dm(u.creado))}
          · última vez ${esc(dm(u.visto))}
          · ${esc(u.movs || 0)} mov.${u.interno ? '' : ' · ' + esc(prueba(u).replace(/<[^>]+>/g, ''))}
          ${u.email ? '· ' + esc(u.email) : ''}</span>
      </div>
      <button class="marcar" data-codigo="${esc(u.codigo)}" data-interno="${u.interno ? 0 : 1}"
        >${u.interno ? 'es cliente' : 'es nuestro'}</button>
    </div>`).join('');

  const filasEventos = d.eventos.length
    ? d.eventos.map(e => `<tr><td>${esc(String(e.cuando).slice(5).replace('T', ' '))}</td><td>${esc(e.email || '—')}</td>
        <td>${esc(e.estado || '—')}</td><td class="g">${e.hasta ? esc(dm(e.hasta)) : ''}</td></tr>`).join('')
    : '<tr><td colspan="4" class="g">Mercado Pago todavía no avisó de ningún pago.</td></tr>';

  return `
  <h1>Tasita Presupuesto</h1>
  <p class="fecha">Al ${esc(hoy)}</p>

  <h2>Gente adentro</h2>
  <div class="cards">
    ${tarjeta(r.total, 'en total')}
    ${tarjeta(r.activos_7, 'la usaron esta semana', `${r.activos_hoy} hoy`)}
    ${tarjeta(r.activos_30, 'la usaron este mes')}
  </div>

  <h2>Se sumaron</h2>
  <div class="cards">
    ${tarjeta(r.altas_hoy, 'hoy')}
    ${tarjeta(r.altas_7, 'en 7 días')}
    ${tarjeta(r.altas_30, 'en 30 días')}
  </div>
  <div class="barras">${barras}</div>

  <h2>Plata</h2>
  <div class="cards">
    ${tarjeta(r.pagando, 'pagando ahora')}
    ${tarjeta(r.email_sin_pagar, 'dejaron el mail sin pagar', 'fueron a pagar y no terminaron')}
    ${tarjeta(r.con_email, 'dejaron el mail en total')}
  </div>

  <h2>Pruebas que se terminan</h2>
  <p class="nota">Estimado: el reloj de los 20 días corre en el celular de cada
  persona, acá se calcula desde el día que la vimos por primera vez.
  ${vencidos ? `Ya se les venció a <b>${esc(vencidos)}</b>.` : ''}</p>
  <div class="tabla"><table><tr><th>Día</th><th>Cuántos</th><th></th></tr>${filasVence}</table></div>

  <h2>Toda la gente${r.internos ? ` <span class="chip">${esc(r.internos)} nuestros, afuera de la cuenta</span>` : ''}</h2>
  <p class="nota">Tocá <b>"es nuestro"</b> en los equipos de prueba: dejan de contar
  en todos los números de arriba, sin borrar nada. Se vuelve atrás con otro toque.
  <b>Mov.</b> es cuántos movimientos cargó — el que cargó dos y no volvió más
  difícilmente sea un cliente.</p>
  <div class="gente">${filasUltimos}</div>
  <p class="nota">El <b>≈</b> marca a los que ya estaban antes de que empezáramos
  a registrar: su fecha de alta salió del primer movimiento que cargaron.</p>

  <h2>Últimos avisos de Mercado Pago</h2>
  <div class="tabla"><table><tr><th>Cuándo</th><th>Mail</th><th>Estado</th><th>Paga hasta</th></tr>${filasEventos}</table></div>`;
}

function pagina(titulo, cuerpo, status, clave) {
  // El manifiesto y el service worker solo se enganchan si ya entró con la clave
  // correcta. En la pantalla de "clave incorrecta" no hay nada que instalar.
  const comoApp = clave ? `
<link rel="manifest" href="/panel/manifest.json?clave=${esc(encodeURIComponent(clave))}">
<meta name="theme-color" content="#0f1115">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Panel">` : '';

  const registro = clave ? `<script>
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/panel/sw.js', { scope: '/panel' }).catch(() => {});
}
// Marcar un equipo como nuestro (o devolverlo a la cuenta) y recargar los números.
document.addEventListener('click', async (e) => {
  const b = e.target.closest('.marcar');
  if (!b) return;
  b.disabled = true;
  const antes = b.textContent;
  b.textContent = '…';
  try {
    const r = await fetch('/panel/interno?clave=${esc(encodeURIComponent(clave))}'
      + '&codigo=' + encodeURIComponent(b.dataset.codigo)
      + '&interno=' + b.dataset.interno, { method: 'POST' });
    if (!r.ok) throw new Error();
    location.reload();
  } catch {
    b.disabled = false;
    b.textContent = antes;
    alert('No se pudo guardar. Probá de nuevo.');
  }
});
<\/script>` : '';

  return new Response(`<!doctype html><html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(titulo)}</title>${comoApp}<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;padding:18px 16px 60px;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;
     background:#f6f7f9;color:#15181d;max-width:760px;margin-inline:auto}
h1{font-size:22px;margin:0}
h2{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:#6b7280;margin:28px 0 10px}
.fecha{color:#6b7280;margin:2px 0 0;font-size:14px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(105px,1fr));gap:10px}
.c{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:12px}
.c b{display:block;font-size:28px;line-height:1.1}
.c span{display:block;font-size:13px;color:#6b7280;margin-top:2px}
.c i{display:block;font-size:12px;color:#9aa1ad;font-style:normal;margin-top:4px}
.barras{display:flex;align-items:flex-end;gap:3px;background:#fff;border:1px solid #e5e7eb;
        border-radius:12px;padding:12px 10px;overflow-x:auto}
.b{flex:1;min-width:22px;text-align:center}
.b u{display:block;background:#2f7d5d;border-radius:3px 3px 0 0;margin:0 auto;width:70%}
.b em{display:block;font-style:normal;font-size:11px;color:#15181d;margin-top:3px}
.b s{display:block;text-decoration:none;font-size:10px;color:#9aa1ad}
/* La tabla scrollea sola de costado si no entra; la página nunca se mueve. */
.tabla{overflow-x:auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font-size:12px;color:#6b7280;font-weight:600;background:#fafbfc}
th,td{padding:8px 10px;border-bottom:1px solid #f0f1f3;white-space:nowrap}
tr:last-child td{border-bottom:0}
td.n{font-weight:600}
.g{color:#6b7280}
.ok{background:#e7f4ee;color:#2f7d5d;border-radius:5px;padding:1px 5px;font-size:11px}
.fin{background:#fdeceb;color:#b4342a;border-radius:5px;padding:1px 5px;font-size:11px}
.mio{background:#eef0f3;color:#6b7280;border-radius:5px;padding:1px 5px;font-size:11px}
.chip{background:#eef0f3;color:#6b7280;border-radius:6px;padding:2px 7px;font-size:11px;
      text-transform:none;letter-spacing:0;font-weight:500}
.gente{background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden}
.p{display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid #f0f1f3}
.p:last-child{border-bottom:0}
.p.i{opacity:.55}
.pd{min-width:0;flex:1}
.pm{display:block;font-size:12px;color:#6b7280;margin-top:3px}
.marcar{font:inherit;font-size:12px;padding:4px 9px;border:1px solid #d7dae0;background:#fff;
        color:#15181d;border-radius:7px;cursor:pointer}
.marcar:active{background:#eef0f3}
.marcar:disabled{opacity:.5}
code{font-size:12px;background:#f0f1f3;border-radius:4px;padding:1px 4px}
.nota{font-size:13px;color:#6b7280;margin:8px 0}
.vacio{color:#6b7280;margin:0;font-size:14px}
@media (prefers-color-scheme:dark){
  body{background:#0f1115;color:#e8eaed}
  .c,.tabla,.barras,.gente{background:#181b21;border-color:#2a2f38}
  .p{border-color:#242832}
  th{background:#1d212a}th,td{border-color:#242832}
  .b em{color:#e8eaed}code{background:#242832}
  .ok{background:#16301f;color:#5fbf8d}.fin{background:#341c1a;color:#e8837a}
  .mio,.chip{background:#242832;color:#9aa1ad}
  .marcar{background:#242832;color:#e8eaed;border-color:#343a45}
  .marcar:active{background:#2d323d}
}
</style></head><body>${cuerpo}${registro}</body></html>`, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
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
