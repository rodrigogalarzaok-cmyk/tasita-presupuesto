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

// Estados en los que la plata volvió al bolsillo de la persona. Son los únicos
// que cortan el acceso en el acto: en todos los demás casos (canceló, se pausó,
// falló un cobro) el mes ya pagado se respeta hasta el final.
const DEVUELTO = ['charged_back', 'refunded', 'cancelled_by_chargeback'];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return responder(null, 204, env);

    // Solo cuenta como persona quien abre la app en su dirección real. Todo lo
    // que llega de otro lado —el archivo abierto desde la computadora, una
    // prueba en localhost, una herramienta— es nuestro, no un cliente: se anota
    // igual, pero marcado como interno, así que no ensucia ningún número.
    // El navegador siempre manda 'Origin' en un pedido a otro dominio, y este
    // Worker vive en un dominio distinto al de la app, así que el dato llega
    // siempre. Nada de esto se pierde: queda visible en el panel y se puede
    // devolver a la cuenta con un toque si alguna vez fuera un cliente real.
    const deAfuera = (request.headers.get('Origin') || '') !== env.ORIGEN_APP;

    // Anotar quién entró se hace SIEMPRE en segundo plano (waitUntil): la
    // respuesta a la app sale sin esperarlo y, si la anotación falla, no se
    // entera nadie. Nunca puede romper ni demorar lo que la persona está usando.
    // 'activo=1' lo manda la app cuando esa persona ya puso su nombre. Es lo que
    // permite contar personas y no navegadores. Si no viene, no cambia nada: la
    // app vieja que todavía no se actualizó sigue funcionando igual que siempre.
    const yaEntro = url.searchParams.get('activo') === '1';

    const visita = (codigo) => {
      if (codigo && ctx && ctx.waitUntil) ctx.waitUntil(marcarVisita(env, codigo, deAfuera, yaEntro));
    };

    // Revisión con Mercado Pago "de arrastre": cualquier pedido que llega (alguien
    // abre la app, el panel, el reloj externo de GitHub) la dispara en segundo
    // plano si la última tiene más de un minuto. Así no depende de un solo reloj:
    // el cron de Cloudflare quedó configurado pero el 2026-09-16 no se ejecutaba.
    if (ctx && ctx.waitUntil && url.pathname !== '/webhook-mp' && url.pathname !== '/panel') {
      ctx.waitUntil(revisarSiHaceFalta(env).catch(e => console.error('revisión de arrastre:', e)));
    }

    try {
      if (url.pathname === '/revisar') {
        // Lo llama el reloj externo (GitHub Actions). No devuelve datos de nadie.
        return responder({ ok: true }, 200, env);
      }
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
  },

  // Cron de Cloudflare (cada minuto). Es uno de los disparadores; ver revisarSiHaceFalta.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(revisarSiHaceFalta(env));
  }
};

// ── La app pregunta: ¿este código tiene la suscripción al día?
async function getSuscripcion(url, env) {
  const codigo = codigoValido(url.searchParams.get('codigo'));
  if (!codigo) return responder({ error: 'código inválido' }, 400, env);

  const fila = await env.DB
    .prepare('SELECT activa, hasta, estado FROM suscripciones WHERE codigo = ?')
    .bind(codigo)
    .first();

  // Sin pago, o con el mes vencido: si dejó su email (pasó por el camino de
  // pago) se le pregunta a Mercado Pago directamente antes de decir que no.
  // El aviso de MP puede no llegar nunca (pasó el 2026-09-16 con el primer pago
  // real), y una renovación puede cobrarse entre dos revisiones de cada hora.
  const sinAcceso = !fila || !fila.activa || !fila.hasta || (fila.estado !== LIBRE && fila.hasta < hoyISO());
  if (sinAcceso) {
    const email = await env.DB.prepare('SELECT email FROM suscripciones WHERE codigo = ?').bind(codigo).first('email');
    if (email && puedeConsultarMP(codigo)) {
      const hasta = await buscarPagoPorEmail(env, codigo, email);
      if (hasta && hasta >= hoyISO()) return responder({ activa: true, hasta }, 200, env);
    }
    return responder(fila && fila.hasta ? { activa: false, hasta: fila.hasta } : { activa: false }, 200, env);
  }

  // Cuenta libre de por vida (los equipos de Marc, los creadores de contenido
  // de una promo). No paga nunca y no cuenta como pago en el panel.
  if (fila.estado === LIBRE) {
    return responder({ activa: true, libre: true, hasta: fila.hasta }, 200, env);
  }

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

// ── Cuentas libres de por vida.
//
//    'suscripciones.estado = libre' significa: esta persona entra siempre y
//    nunca ve el cartel de pago. Es para los equipos de Marc y para los
//    creadores de contenido a los que les regala la app a cambio de difusión.
//    Se dan de alta a mano, un comando por código (ver api/README.md).
//
//    No cuentan como pago en NINGÚN número del panel: si contaran, el día que
//    empiecen a entrar los pagos de verdad no se sabría cuáles son plata.
//    Tienen su propia tarjeta ahí.
const LIBRE = 'libre';

// Para las consultas del panel: "esta suscripción no es una cuenta libre".
const NO_LIBRE = `(s.estado IS NULL OR s.estado <> '${LIBRE}')`;

// Códigos reservados para nuestras propias pruebas (las de Claude).
// Cualquier código que empiece con 'tas_claude' queda marcado como interno
// entre por donde entre, incluso desde la dirección real de la app. Así una
// prueba nuestra no aparece nunca como una persona nueva en el panel.
// El código que se usa siempre es  tas_claudeprueba  (ver api/README.md).
const PREFIJO_PRUEBA = /^tas_claude/i;

function esCodigoDePrueba(c) {
  return PREFIJO_PRUEBA.test(String(c || ''));
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

  // Si no quedó anotado, se le pregunta a MP en el momento. Sin esto, quien
  // corrige el email después de haber pagado con otro (antes de la revisión de
  // cada hora) recibe "no pagó" y la app lo manda a pagar DE NUEVO: cobro doble.
  const hasta = await buscarPagoPorEmail(env, codigo, email);
  if (hasta && hasta >= hoyISO()) return responder({ activa: true, hasta }, 200, env);
  return responder({ activa: false }, 200, env);
}

// Deja la suscripción paga y vigente. Nunca acorta una vigencia ya dada.
async function activarSuscripcion(env, codigo, hasta, mpId, email) {
  await env.DB.prepare(`
    INSERT INTO suscripciones (codigo, activa, hasta, email, mp_id, estado, actualizado)
    VALUES (?, 1, ?, ?, ?, 'al dia', ?)
    ON CONFLICT(codigo) DO UPDATE SET
      activa      = 1,
      hasta       = MAX(COALESCE(suscripciones.hasta, ''), COALESCE(excluded.hasta, '')),
      email       = COALESCE(excluded.email, suscripciones.email),
      mp_id       = excluded.mp_id,
      estado      = 'al dia',
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
    } else if (DEVUELTO.includes(estado)) {
      // Le devolvieron la plata (contracargo o reembolso): ese mes ya no está
      // pagado, así que el acceso se corta en el momento.
      await env.DB.prepare(
        'UPDATE suscripciones SET activa = 0, estado = ?, actualizado = ? WHERE codigo = ?'
      ).bind(estado || 'devuelto', new Date().toISOString(), codigo).run();
    } else {
      // Canceló, la pausó, o falló un cobro.
      //
      // NO se corta el acceso: el mes que pagó le corresponde entero. La fila
      // queda con su 'hasta' y se vence sola el día que termina lo pagado,
      // porque al no haber más cobros nada la va a extender. Es lo que hace
      // cualquier suscripción, y evita el reclamo de quien pagó un mes, canceló
      // a los dos días y se quedó afuera.
      await env.DB.prepare(
        'UPDATE suscripciones SET estado = ?, actualizado = ? WHERE codigo = ?'
      ).bind(estado || 'sin estado', new Date().toISOString(), codigo).run();
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

// ── Sin depender del aviso: se le pregunta a Mercado Pago quién está suscripto.
//
//    El webhook es la vía rápida, pero si MP no avisa (evento sin tildar, plan
//    creado desde el panel, caída) la persona pagó y queda afuera. Esto lo tapa
//    por dos lados: cuando una persona bloqueada que dejó su email abre la app
//    (buscarPagoPorEmail), y cada hora para todo el plan (sincronizarPlan, que
//    además trae las renovaciones mensuales).
const PLAN_MP = '95ec6d894b0a489888a142c56659f844';

// Una persona bloqueada consulta varias veces seguidas al volver de pagar
// (3, 8, 15 y 30 s). Con una consulta a MP cada 10 s por código alcanza.
const ultimaConsultaMP = new Map();
function puedeConsultarMP(codigo) {
  const ahora = Date.now();
  if (ahora - (ultimaConsultaMP.get(codigo) || 0) < 10000) return false;
  ultimaConsultaMP.set(codigo, ahora);
  return true;
}

async function buscarPagoPorEmail(env, codigo, email) {
  if (!env.MP_ACCESS_TOKEN) return null;
  const q = new URLSearchParams({ payer_email: email, preapproval_plan_id: PLAN_MP, limit: '20' });
  const { recurso, http } = await pedirAMP(`https://api.mercadopago.com/preapproval/search?${q}`, env);
  if (!recurso) { console.error('Búsqueda por email falló, MP', http); return null; }

  const pagas = (recurso.results || []).filter(s => s.status === 'authorized');
  console.log('Búsqueda por email', codigo, '→', (recurso.results || []).length, 'resultados,', pagas.length, 'autorizadas');
  let mejor = null;
  for (const s of pagas) {
    const hasta = calcularHasta(s);
    if (!mejor || hasta > mejor.hasta) mejor = { hasta, id: s.id };
  }
  if (!mejor) return null;

  await registrar(env, 'consulta_directa', mejor.id, codigo, email, 'authorized', mejor.hasta, '');
  await activarSuscripcion(env, codigo, mejor.hasta, mejor.id, email);
  return mejor.hasta;
}

// Recorre todas las suscripciones del plan y deja la base igual a lo que dice MP.
//
// Cada pasada deja anotado en 'control_mp' cómo le fue. Eso es lo que muestra
// el panel arriba de todo: si la revisión dejó de correr, o si hay alguien que
// pagó en MP y no tiene acceso, se ve en rojo sin tener que esperar un reclamo.
async function sincronizarPlan(env) {
  const control = { revisado: new Date().toISOString(), ok: 0, en_mp: 0, autorizadas: 0, activadas: 0, sin_duenio: [], error: null };
  if (!env.MP_ACCESS_TOKEN) { control.error = 'falta MP_ACCESS_TOKEN'; return guardarControl(env, control); }

  let offset = 0, total = 0;
  do {
    const q = new URLSearchParams({ preapproval_plan_id: PLAN_MP, limit: '100', offset: String(offset) });
    const { recurso, http } = await pedirAMP(`https://api.mercadopago.com/preapproval/search?${q}`, env);
    if (!recurso) {
      console.error('Sincronización falló, MP', http);
      control.error = `Mercado Pago no respondió (${http})`;
      return guardarControl(env, control);
    }
    const lista = recurso.results || [];
    total = (recurso.paging && recurso.paging.total) || lista.length;
    control.en_mp = total;

    for (const s of lista) {
      if (s.status !== 'authorized') {
        // Se dio de baja (cancelled) o la pausó (paused). Como MP no avisa, es la
        // única forma de enterarnos. NO se le corta el acceso: el mes que pagó
        // se respeta y se vence solo. Solo se anota el estado para el panel.
        // Se busca por el id de ESTA suscripción: si la persona se volvió a
        // suscribir, su fila ya apunta a la nueva y la vieja cancelada no la pisa.
        if (s.status) {
          await env.DB.prepare(`
            UPDATE suscripciones SET estado = ?, actualizado = ?
            WHERE mp_id = ? AND (estado IS NULL OR estado <> ?) AND estado IS NOT '${LIBRE}'
          `).bind(s.status, new Date().toISOString(), String(s.id), s.status).run();
        }
        continue;
      }
      control.autorizadas++;
      let email = emailValido(s.payer_email);
      const hasta = calcularHasta(s);
      let codigo = codigoValido(s.external_reference);
      // La búsqueda por plan suele venir SIN payer_email (verificado 2026-09-16),
      // así que a quien ya se activó alguna vez se lo reconoce por el id de su
      // suscripción. Es lo que mantiene al día las renovaciones mensuales.
      if (!codigo) {
        codigo = await env.DB.prepare(
          'SELECT codigo FROM suscripciones WHERE mp_id = ? ORDER BY activa DESC, actualizado DESC LIMIT 1'
        ).bind(String(s.id)).first('codigo');
      }
      // Alguien nuevo que no reconocemos por id: la búsqueda no trae el email,
      // pero la suscripción de a una sí. Solo se pide para estos casos.
      if (!codigo && !email) {
        const det = await pedirAMP(`https://api.mercadopago.com/preapproval/${s.id}`, env);
        if (det.recurso) email = emailValido(det.recurso.payer_email);
      }
      if (!codigo && email) {
        codigo = await env.DB.prepare(
          'SELECT codigo FROM suscripciones WHERE email = ? ORDER BY activa DESC, actualizado DESC LIMIT 1'
        ).bind(email).first('codigo');
      }
      if (!codigo) {
        // Pagó pero no sabemos de quién es (lo más probable: en la app escribió un
        // email distinto al de su cuenta de MP). Queda anotado para que se active
        // solo si carga el email correcto, y el panel lo muestra en rojo.
        control.sin_duenio.push({ mp_id: s.id, email, desde: soloFecha(s.date_created || ''), hasta });
        const ya = await env.DB.prepare('SELECT id FROM eventos_mp WHERE mp_id = ? AND hasta = ?').bind(s.id, hasta).first();
        if (!ya) await registrar(env, 'sincronizacion', s.id, null, email, 'authorized', hasta, JSON.stringify({ payer_id: s.payer_id }));
        continue;
      }
      control.ok++;
      // Solo se escribe si cambia algo: sin esto, cada hora sería una escritura por suscriptor.
      const fila = await env.DB.prepare('SELECT activa, hasta FROM suscripciones WHERE codigo = ?').bind(codigo).first();
      if (fila && fila.activa && fila.hasta && fila.hasta >= hasta) continue;
      await activarSuscripcion(env, codigo, hasta, s.id, email);
      control.activadas++;
    }
    offset += lista.length;
    if (!lista.length) break;
  } while (offset < total);
  console.log('Sincronización con MP:', JSON.stringify(control));
  return guardarControl(env, control);
}

// Corre la revisión solo si la última tiene más de SEGUNDOS_ENTRE_REVISIONES.
// Primero "reserva" el turno con un UPDATE condicional: si llegan diez pedidos
// juntos, uno solo gana y los demás no le pegan a Mercado Pago.
const SEGUNDOS_ENTRE_REVISIONES = 60;
async function revisarSiHaceFalta(env) {
  const ahora = new Date();
  const limite = new Date(ahora.getTime() - SEGUNDOS_ENTRE_REVISIONES * 1000).toISOString();
  let r = await env.DB.prepare('UPDATE control_mp SET revisado = ? WHERE id = 1 AND revisado < ?')
    .bind(ahora.toISOString(), limite).run();
  if (!r.meta || !r.meta.changes) {
    // Puede que la fila todavía no exista (base nueva).
    r = await env.DB.prepare("INSERT OR IGNORE INTO control_mp (id, revisado) VALUES (1, ?)").bind(ahora.toISOString()).run();
    if (!r.meta || !r.meta.changes) return null;
  }
  return sincronizarPlan(env);
}

async function guardarControl(env, c) {
  try {
    await env.DB.prepare(`
      INSERT INTO control_mp (id, revisado, en_mp, autorizadas, ok, activadas, sin_duenio, error)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET revisado = excluded.revisado, en_mp = excluded.en_mp,
        autorizadas = excluded.autorizadas, ok = excluded.ok, activadas = excluded.activadas,
        sin_duenio = excluded.sin_duenio, error = excluded.error
    `).bind(c.revisado, c.en_mp, c.autorizadas, c.ok, c.activadas, JSON.stringify(c.sin_duenio), c.error).run();
  } catch (e) {
    console.error('No se pudo guardar el control:', e);
  }
  return c;
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
  // Suscripción: un mes desde el último cobro que MP efectivamente hizo.
  // No se usa 'next_payment_date' si hay cobro registrado: esa fecha dice cuándo
  // MP VA a intentar cobrar, no que cobró. Así, si la renovación falla, el
  // acceso termina al mes (más la gracia) y vuelve solo cuando MP logra cobrar.
  const cobro = recurso.summarized && recurso.summarized.last_charged_date;
  if (cobro) return sumarDias(sumarUnMes(soloFecha(cobro)), DIAS_GRACIA);
  if (recurso.next_payment_date) return sumarDias(soloFecha(recurso.next_payment_date), DIAS_GRACIA);
  // Pago suelto: un mes desde que se aprobó.
  const base = soloFecha(recurso.date_approved || recurso.date_created || new Date().toISOString());
  return sumarDias(base, 30 + DIAS_GRACIA);
}

function soloFecha(iso) { return String(iso).slice(0, 10); }

// '2026-09-15' → '2026-10-15'. Si el mes siguiente no tiene ese día (31/01), cae en el último.
function sumarUnMes(iso) {
  const [a, m, d] = iso.split('-').map(Number);
  const ultimo = new Date(Date.UTC(a, m + 1, 0)).getUTCDate();
  const f = new Date(Date.UTC(a, m, Math.min(d, ultimo)));
  return [f.getUTCFullYear(), String(f.getUTCMonth() + 1).padStart(2, '0'), String(f.getUTCDate()).padStart(2, '0')].join('-');
}

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
//    'deAfuera' = el pedido no vino de la dirección real de la app, así que
//    somos nosotros probando. Se anota marcado como interno y no cuenta en
//    ningún número. Al que YA existe no se le toca esa marca: si un cliente
//    real llegara alguna vez por un camino raro, no se lo saca de la cuenta.
async function marcarVisita(env, codigo, deAfuera, yaEntro) {
  const hoy = hoyISO();
  const nuestro = deAfuera || esCodigoDePrueba(codigo);
  try {
    await env.DB.prepare(`
      INSERT INTO usuarios (codigo, creado, visto, dias, origen, interno, activo)
      VALUES (?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(codigo) DO UPDATE SET
        dias  = usuarios.dias + 1,
        visto = excluded.visto
      WHERE usuarios.visto < excluded.visto
    `).bind(codigo, hoy, hoy, nuestro ? 'prueba' : 'vivo', nuestro ? 1 : 0, yaEntro ? 1 : 0).run();

    // Un código reservado nunca puede quedar contando como cliente, ni siquiera
    // si la fila se creó antes de existir esta regla o si se entró por la
    // dirección real de la app. Es una sola escritura, y solo para los nuestros.
    if (esCodigoDePrueba(codigo)) {
      await env.DB
        .prepare("UPDATE usuarios SET interno = 1, origen = 'prueba' WHERE codigo = ? AND interno = 0")
        .bind(codigo).run();
    }

    // El nombre se puede poner en cualquier momento, incluso un rato después de
    // haber abierto la app, así que la marca va aparte del INSERT de arriba (que
    // solo corre una vez por día). El 'AND activo = 0' hace que se escriba una
    // sola vez en la vida de esa persona: después es lectura y nada más.
    if (yaEntro) {
      await env.DB
        .prepare('UPDATE usuarios SET activo = 1 WHERE codigo = ? AND activo = 0')
        .bind(codigo).run();
    }
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

  // Al abrir el panel se revisa con Mercado Pago ANTES de mostrar nada (si la
  // última revisión tiene más de un minuto): Marc siempre ve lo del momento.
  try { await revisarSiHaceFalta(env); } catch (e) { console.error('revisión al abrir el panel:', e); }

  // 'now' es UTC; Argentina está tres horas atrás. Mismo criterio que el resto.
  const HOY = "date('now','-3 hours')";

  // 'interno = 0' en todos lados: los equipos nuestros no cuentan como clientes.
  const [resumen, altas, vencen, ultimos, eventos, control, pagos] = await env.DB.batch([
    env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM usuarios WHERE interno = 0)                                AS total,
        (SELECT COUNT(*) FROM usuarios WHERE interno = 1)                                AS internos,
        -- Personas, no navegadores: las que llegaron a poner su nombre.
        (SELECT COUNT(*) FROM usuarios WHERE interno = 0 AND activo = 1)                 AS personas,
        (SELECT COUNT(*) FROM usuarios WHERE interno = 0 AND activo = 1 AND creado = ${HOY})              AS personas_hoy,
        (SELECT COUNT(*) FROM usuarios WHERE interno = 0 AND activo = 1 AND creado >= date(${HOY},'-6 days')) AS personas_7,
        (SELECT COUNT(*) FROM usuarios WHERE interno = 0 AND creado = ${HOY})             AS altas_hoy,
        (SELECT COUNT(*) FROM usuarios WHERE interno = 0 AND creado >= date(${HOY},'-6 days'))  AS altas_7,
        (SELECT COUNT(*) FROM usuarios WHERE interno = 0 AND creado >= date(${HOY},'-29 days')) AS altas_30,
        (SELECT COUNT(*) FROM usuarios WHERE interno = 0 AND visto  = ${HOY})             AS activos_hoy,
        (SELECT COUNT(*) FROM usuarios WHERE interno = 0 AND visto  >= date(${HOY},'-6 days'))  AS activos_7,
        (SELECT COUNT(*) FROM usuarios WHERE interno = 0 AND visto  >= date(${HOY},'-29 days')) AS activos_30,
        (SELECT COUNT(*) FROM suscripciones s WHERE s.activa = 1 AND s.hasta >= ${HOY}
           AND ${NO_LIBRE}
           AND s.codigo NOT IN (SELECT codigo FROM usuarios WHERE interno = 1))          AS pagando,
        -- Las regaladas de por vida van aparte: entran gratis, no son plata.
        (SELECT COUNT(*) FROM suscripciones s WHERE s.estado = '${LIBRE}')               AS libres,
        (SELECT COUNT(*) FROM suscripciones s WHERE s.email IS NOT NULL
           AND ${NO_LIBRE}
           AND s.codigo NOT IN (SELECT codigo FROM usuarios WHERE interno = 1))          AS con_email,
        (SELECT COUNT(*) FROM suscripciones s WHERE s.email IS NOT NULL
           AND (s.activa = 0 OR s.hasta < ${HOY})
           AND ${NO_LIBRE}
           AND s.codigo NOT IN (SELECT codigo FROM usuarios WHERE interno = 1))          AS email_sin_pagar,
        -- Cancelaron pero el mes que pagaron sigue corriendo: son las bajas que
        -- vienen, y el día que se les vence bajan solas de 'pagando ahora'.
        (SELECT COUNT(*) FROM suscripciones s WHERE s.activa = 1 AND s.hasta >= ${HOY}
           AND s.estado IS NOT NULL AND s.estado NOT IN ('al dia', '${LIBRE}')
           AND s.codigo NOT IN (SELECT codigo FROM usuarios WHERE interno = 1))          AS cancelaron
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
             (s.activa = 1 AND s.hasta >= ${HOY} AND ${NO_LIBRE}) AS paga,
             (s.estado = '${LIBRE}') AS libre,
             (SELECT COUNT(*) FROM json_each(json_extract(d.contenido,'$.txs'))) AS movs
      FROM usuarios u
      LEFT JOIN suscripciones s ON s.codigo = u.codigo
      LEFT JOIN datos d ON d.codigo = u.codigo
      ORDER BY u.interno, u.creado DESC, u.visto DESC
    `),
    // 'recibido' se guarda en hora universal (UTC), que es la del servidor. Acá
    // se pasa a la hora de Argentina, que es la que Marc mira el reloj: si no,
    // un aviso de las 23:56 del jueves aparece como las 02:56 del viernes.
    env.DB.prepare(`
      SELECT substr(datetime(recibido,'-3 hours'),1,16) AS cuando, tipo, email, estado, hasta
      FROM eventos_mp ORDER BY id DESC LIMIT 8
    `),
    env.DB.prepare('SELECT * FROM control_mp WHERE id = 1'),
    // Los que pagan: cuándo se les termina el mes pagado. Si MP cobra la
    // renovación, la revisión de cada hora corre esta fecha un mes para adelante.
    env.DB.prepare(`
      SELECT s.codigo, s.email, s.hasta, s.estado FROM suscripciones s
      WHERE s.activa = 1 AND s.hasta >= date(${HOY},'-7 days') AND ${NO_LIBRE}
        AND s.codigo NOT IN (SELECT codigo FROM usuarios WHERE interno = 1)
      ORDER BY s.hasta
    `)
  ]);

  const r = (resumen.results && resumen.results[0]) || {};
  const datos = {
    resumen: r,
    altas:   altas.results   || [],
    vencen:  vencen.results  || [],
    ultimos: ultimos.results || [],
    eventos: eventos.results || [],
    control: (control.results && control.results[0]) || null,
    pagos:   pagos.results   || []
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
// Siempre a la red, y sin pasar por la caché del navegador: el panel muestra
// números que cambian a cada rato, guardarlos sería mostrar información vieja.
self.addEventListener('fetch', (e) => {
  e.respondWith(
    fetch(e.request, { cache: 'no-store' }).catch(() => fetch(e.request))
  );
});`,
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

// Lo que informa Mercado Pago, dicho como lo diría Marc.
const ESTADOS_MP = {
  cancelled: 'se dio de baja',
  paused: 'pausó la suscripción',
  pending: 'pago pendiente',
  charged_back: 'contracargo',
  refunded: 'le devolvieron la plata',
  cancelled_by_chargeback: 'contracargo'
};

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
    if (u.libre) return '<span class="ok">libre</span>';
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
  const ficha = (u) => `<div class="p${u.interno ? ' i' : ''}">
      <div class="pd">
        <code>${esc(u.codigo)}</code>
        ${u.interno ? '<span class="mio">nuestro</span>'
                    : (u.libre ? '<span class="ok">libre</span>'
                    : (u.paga ? '<span class="ok">paga</span>' : ''))}
        <span class="pm">se sumó ${u.origen === 'reconstruido' ? '≈' : ''}${esc(dm(u.creado))}
          · última vez ${esc(dm(u.visto))}
          · ${esc(u.movs || 0)} mov.${u.interno ? '' : ' · ' + esc(prueba(u).replace(/<[^>]+>/g, ''))}
          ${u.email ? '· ' + esc(u.email) : ''}</span>
      </div>
      <button class="marcar" data-codigo="${esc(u.codigo)}" data-interno="${u.interno ? 0 : 1}"
        >${u.interno ? 'es cliente' : 'es nuestro'}</button>
    </div>`;

  const reales   = d.ultimos.filter(u => !u.interno);
  const nuestros = d.ultimos.filter(u => u.interno);

  const listaReales = reales.length
    ? `<div class="gente">${reales.map(ficha).join('')}</div>`
    : '<p class="vacio">Todavía no hay ningún cliente.</p>';

  const listaNuestros = nuestros.length
    ? `<div class="gente">${nuestros.map(ficha).join('')}</div>`
    : '<p class="vacio">No hay ninguno marcado.</p>';

  // 'cuando' llega como '2026-09-04 23:56' (ya en hora de Argentina) → '04/09 23:56'.
  const fechaHora = (s) => {
    const [f, h] = String(s).split(' ');
    return `${dm(f)} ${h || ''}`.trim();
  };

  const filasEventos = d.eventos.length
    ? d.eventos.map(e => `<tr><td>${esc(fechaHora(e.cuando))}</td><td>${esc(e.email || '—')}</td>
        <td>${esc(e.estado || '—')}</td><td class="g">${e.hasta ? esc(dm(e.hasta)) : ''}</td></tr>`).join('')
    : '<tr><td colspan="4" class="g">Mercado Pago todavía no avisó de ningún pago.</td></tr>';

  // Hora de Argentina, para que se vea de cuándo son los números que está mirando.
  const ahora = new Date(Date.now() - 3 * 3600000).toISOString().slice(11, 16);

  // ── ¿Los cobros de Mercado Pago están llegando bien?
  //    Verde = la revisión de cada hora corrió hace poco y todo el que paga en MP
  //    tiene acceso en la app. Rojo = hay que mirar, con el motivo en criollo.
  const c = d.control;
  const minutos = c ? Math.round((Date.now() - Date.parse(c.revisado)) / 60000) : null;
  const sinDuenio = c ? JSON.parse(c.sin_duenio || '[]') : [];
  const problemas = [];
  if (!c) problemas.push('La revisión con Mercado Pago todavía no corrió nunca.');
  else {
    // La disparan el reloj externo (cada ~5 min), cada apertura de la app y
    // cada vez que se abre este panel. Media hora sin correr ya es un problema.
    if (minutos > 30) problemas.push(`La revisión con Mercado Pago no corre desde hace ${minutos < 120 ? minutos + ' minutos' : Math.round(minutos / 60) + ' horas'}.`);
    if (c.error) problemas.push(`La última revisión falló: ${c.error}.`);
    for (const p of sinDuenio) {
      problemas.push(`Alguien pagó en Mercado Pago el ${dm(p.desde)}${p.email ? ` (${p.email})` : ''} y no sabemos cuál es su app: seguramente escribió otro email. Pasáselo a Claude para activarlo.`);
    }
  }
  const hace = minutos === null ? '' : minutos < 2 ? 'recién' : minutos < 60 ? `hace ${minutos} min` : `hace ${Math.round(minutos / 60)} h`;
  const estadoCobros = problemas.length
    ? `<div class="estado mal"><b>Hay que revisar</b>${problemas.map(esc).join('<br>')}</div>`
    : `<div class="estado bien"><b>Cobros en orden</b>Revisado con Mercado Pago ${esc(hace)}: ${esc(c.autorizadas)} ${c.autorizadas === 1 ? 'suscripción activa' : 'suscripciones activas'} en MP, todas con acceso en la app.</div>`;

  const filasPagos = d.pagos.length
    ? d.pagos.map(p => `<tr><td>${esc(p.email || p.codigo)}</td><td>${esc(dm(p.hasta))}</td>
        <td class="g">${p.hasta < hoy ? '<span class="fin">venció</span>' : (p.estado && p.estado !== 'al dia' ? `<span class="fin">${esc(ESTADOS_MP[p.estado] || p.estado)}</span>` : 'al día')}</td></tr>`).join('')
    : '<tr><td colspan="3" class="g">Todavía no paga nadie.</td></tr>';

  return `
  <h1>Tasita Presupuesto</h1>
  <p class="fecha">Datos del ${esc(dm(hoy))} a las ${esc(ahora)}
    <button class="refrescar" id="refrescar">Actualizar</button></p>

  ${estadoCobros}

  <h2>Personas</h2>
  <div class="cards">
    ${tarjeta(r.personas, 'entraron de verdad', 'pusieron su nombre — este es el número de personas')}
    ${tarjeta(r.personas_7, 'en 7 días', `${r.personas_hoy} hoy`)}
  </div>
  <p class="nota">Este es el número que cuenta <b>gente</b>. El de abajo cuenta
  <b>aperturas</b>: una misma persona que mira desde Instagram, después abre en
  su navegador y después instala la app aparece hasta tres veces ahí, porque cada
  navegador guarda su propio código. El nombre, en cambio, se pone una sola vez.</p>

  <h2>Aperturas</h2>
  <div class="cards">
    <button class="c cb" id="verGente">
      <b>${esc(r.total)}</b><span>en total</span><i>tocá para ver quiénes son ›</i>
    </button>
    ${tarjeta(r.activos_7, 'la usaron esta semana', `${r.activos_hoy} hoy`)}
    ${tarjeta(r.activos_30, 'la usaron este mes')}
  </div>
  <div id="gente" hidden>
    ${listaReales}
    <p class="nota">Si alguno es un equipo nuestro, tocá <b>"es nuestro"</b> y sale
    de todos los números. El <b>≈</b> marca a los que ya estaban antes de que
    empezáramos a registrar: su fecha de alta salió del primer movimiento que
    cargaron.</p>
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
    ${tarjeta(r.cancelaron, 'se dieron de baja', 'siguen entrando hasta que se les termine el mes que pagaron')}
    ${tarjeta(r.libres, 'cuentas libres', 'regaladas de por vida: no pagan nunca y no cuentan como plata')}
  </div>
  <p class="nota"><b>Quiénes pagan y hasta cuándo.</b> La fecha es el fin del mes
  pagado más 3 días de margen. Cuando Mercado Pago cobra la renovación, en menos
  de una hora esa fecha pasa al mes siguiente. Si llega el día del cobro y no
  cambió, es que MP no pudo cobrarle.</p>
  <div class="tabla"><table><tr><th>Quién</th><th>Paga hasta</th><th></th></tr>${filasPagos}</table></div>

  <h2>Pruebas que se terminan</h2>
  <p class="nota">Estimado: el reloj de los 20 días corre en el celular de cada
  persona, acá se calcula desde el día que la vimos por primera vez.
  ${vencidos ? `Ya se les venció a <b>${esc(vencidos)}</b>.` : ''}</p>
  <div class="tabla"><table><tr><th>Día</th><th>Cuántos</th><th></th></tr>${filasVence}</table></div>

  <h2>Últimos avisos de Mercado Pago</h2>
  <div class="tabla"><table><tr><th>Cuándo</th><th>Mail</th><th>Estado</th><th>Paga hasta</th></tr>${filasEventos}</table></div>

  <button class="link" id="verNuestros">Ver los ${esc(r.internos)} equipos nuestros ›</button>
  <div id="nuestros" hidden>
    <p class="nota">Estos no cuentan en ningún número de arriba. Son los que se
    sumaron antes del lanzamiento (${esc(dm(LANZAMIENTO))}) más los que fuiste
    marcando. Si alguno resulta ser un cliente de verdad, tocá <b>"es cliente"</b>
    y vuelve a la cuenta.</p>
    ${listaNuestros}
  </div>`;
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
// ── Que los números estén frescos sin tener que pensarlo.
//
//    El panel es una página común: los números son los del momento en que se
//    abrió. Si queda abierta en una pestaña o en la app del teléfono, se va
//    quedando vieja sin avisar. Por eso se recarga sola al volver a ella, que es
//    justo cuando la persona va a mirar los números.
const abiertoDesde = Date.now();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - abiertoDesde > 20000) {
    location.reload();
  }
});
document.addEventListener('click', (e) => {
  if (e.target.closest('#refrescar')) location.reload();
});

// Las listas largas arrancan cerradas: el panel se lee de un vistazo y se abren
// solo cuando hacen falta.
document.addEventListener('click', (e) => {
  const b = e.target.closest('#verGente, #verNuestros');
  if (!b) return;
  const caja = document.getElementById(b.id === 'verGente' ? 'gente' : 'nuestros');
  caja.hidden = !caja.hidden;
  const flecha = caja.hidden ? '›' : '⌄';
  const donde = b.querySelector('i') || b;
  donde.textContent = donde.textContent.replace(/[›⌄]$/, flecha);
});

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
.fecha{color:#6b7280;margin:6px 0 0;font-size:14px;display:flex;align-items:center;gap:10px}
.refrescar{font:inherit;font-size:13px;padding:4px 12px;border:1px solid #d7dae0;background:#fff;
           color:#2f7d5d;border-radius:20px;cursor:pointer;font-weight:600}
.refrescar:active{background:#eef0f3}
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
/* La tarjeta del total es un botón: abre la lista de quiénes son. */
.cb{font:inherit;text-align:left;cursor:pointer;color:inherit}
.cb i{color:#2f7d5d}
#gente,#nuestros{margin-top:10px}
.link{font:inherit;font-size:14px;background:none;border:0;padding:14px 0 0;
      color:#2f7d5d;cursor:pointer;display:block}
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
.estado{border-radius:12px;padding:12px 14px;font-size:14px;line-height:1.45;border:1px solid}
.estado b{display:block;font-size:16px;margin-bottom:2px}
.estado.bien{background:#e7f4ee;color:#1f5c43;border-color:#c5e6d6}
.estado.mal{background:#fdeceb;color:#8f2a22;border-color:#f5c9c5}
@media (prefers-color-scheme:dark){
  .estado.bien{background:#16301f;color:#9fdcbc;border-color:#24503a}
  .estado.mal{background:#341c1a;color:#f2aaa3;border-color:#5a2d29}
  body{background:#0f1115;color:#e8eaed}
  .c,.tabla,.barras,.gente{background:#181b21;border-color:#2a2f38}
  .p{border-color:#242832}
  th{background:#1d212a}th,td{border-color:#242832}
  .b em{color:#e8eaed}code{background:#242832}
  .ok{background:#16301f;color:#5fbf8d}.fin{background:#341c1a;color:#e8837a}
  .mio,.chip{background:#242832;color:#9aa1ad}
  .marcar{background:#242832;color:#e8eaed;border-color:#343a45}
  .marcar:active{background:#2d323d}
  .cb i,.link{color:#5fbf8d}
  .refrescar{background:#242832;color:#5fbf8d;border-color:#343a45}
  .refrescar:active{background:#2d323d}
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
