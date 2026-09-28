// ============================================================================
// Postulantes que salen del BACK OFFICE (modulo de cobertura de comisiones)
// ============================================================================
// Hasta ahora el tablero sabia de un solo origen de postulantes: el formulario
// publico, que cae en una planilla de Google Sheets (ver lib/postulacionesSync.js).
// Desde setiembre de 2026 el back office maneja su propio circuito para
// cubrir las comisiones, y este archivo lo lee.
//
// QUE ES CADA COSA EN EL BACK OFFICE (importante para no confundir los datos):
//
//   "caso de cobertura" (coverage case) = una vacante. Hay uno por comision
//   que necesita gente. Puede estar SEARCHING (buscando), OFFERED (ya hay
//   alguien pensandolo), FILLED (cubierta), etc.
//
//   "oferta" (offer) = una persona puesta en juego para esa vacante. Cada
//   oferta tiene el estado de esa persona en particular: OFFERED (le llego y
//   todavia no contesto), WON (acepto y quedo asignada), REJECTED (dijo que
//   no), CLOSED (la vacante siguio por otro lado), INELIGIBLE (el sistema la
//   descarto sola).
//
// OJO CON LEER ESTO COMO "SE POSTULO" (revisado con Andrea, set. 2026): las
// ofertas NO las crea la persona anotandose. Las crea el motor de asignacion
// automatica que arranco tech: cada registro trae el motivo por el que la
// eligio ("product" = ranking de candidatos para ese curso, "reconcile" =
// carga masiva), y se ven claramente en tandas (el 19/09 se crearon 1106 de
// una y el 23/09 otras 704, hasta 82 en el mismo segundo). Lo que SI pone la
// persona es la RESPUESTA. Por eso en el tablero estas aparecen marcadas con
// origen 'bo' y la pantalla las muestra como "propuesto por el sistema", para
// no mezclarlas con quien efectivamente lleno un formulario.
//
// Ademas, las personas que aparecen aca son siempre staff que ya existe en el
// back office. Los candidatos externos (gente que todavia no trabaja en
// Coderhouse) solo llegan por el formulario - por eso los dos origenes
// conviven en vez de reemplazarse.
// ============================================================================

const { getRedis } = require('./redis');
const { personKey, getAllPostulaciones } = require('./overlay');
const { rolPorEmail } = require('./elegibilidad');

// El resultado se guarda armado en Redis un rato: reconstruirlo cuesta varias
// decenas de pedidos al back office, y lo pide CADA pestaña que abre el
// tablero. Con esto, solo el primero en abrir despues de 15 minutos paga ese
// costo y el resto lo lee hecho.
const CACHE_KEY = 'postulaciones:bo-cache';
const CACHE_TTL_MS = 15 * 60 * 1000;

const TZ = 'America/Argentina/Buenos_Aires';

// Estados de vacante que vale la pena mirar. Se dejan afuera CANCELLED y
// EXPIRED: esas vacantes ya no existen, y quien figuraba en ellas no es un
// postulante de nada.
const ESTADOS_CASO = ['SEARCHING', 'OFFERED', 'PENDING_SIGNATURE', 'FILLED'];

// Como se traduce el estado de la oferta al vocabulario que ya usa el tablero
// para las postulaciones del formulario (pendiente / aprobada / rechazada).
const ESTADO_POR_OFERTA = {
  OFFERED: 'pendiente',           // le llego y todavia no contesto
  PENDING_SIGNATURE: 'pendiente', // dijo que si, falta que firme el anexo
  WON: 'aprobada',                // acepto y quedo asignada
  REJECTED: 'rechazada',          // dijo que no
};

// Solo esos cuatro entran al tablero. Quedan afuera a proposito:
//   CLOSED     -> la vacante se cubrio con otra persona; son 1347 registros
//                 que no aportan nada para decidir y taparian todo lo demas.
//   EXPIRED    -> se le vencio el plazo sin contestar.
//   INELIGIBLE -> el propio sistema la descarto antes de ofrecersela.
const ESTADOS_OFERTA = Object.keys(ESTADO_POR_OFERTA);

function getEnv() {
  const BASE = process.env.BACKOFFICE_API_URL;
  const STUDENT_KEY = process.env.CLAUDE_STUDENT_API_KEY;
  const FINANCE_KEY = process.env.CLAUDE_FINANCE_API_KEY;
  if (!BASE || !STUDENT_KEY || !FINANCE_KEY) {
    throw new Error('Faltan Environment Variables en Vercel (BACKOFFICE_API_URL / CLAUDE_STUDENT_API_KEY / CLAUDE_FINANCE_API_KEY).');
  }
  return { BASE, STUDENT_KEY, FINANCE_KEY };
}

async function apiGet(base, path, key, retries) {
  const maxRetries = retries == null ? 2 : retries;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(base + path, { headers: { 'X-API-Key': key } });
      const text = await resp.text();
      if (resp.ok) {
        try { return JSON.parse(text); } catch (e) { /* reintenta */ }
      }
    } catch (e) { /* reintenta */ }
    if (attempt < maxRetries) await new Promise(r => setTimeout(r, 350 * (attempt + 1)));
  }
  return null;
}

// Corre muchos pedidos sin abrir cientos de conexiones de golpe.
async function enTandas(items, limite, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  const workers = [];
  for (let w = 0; w < Math.min(limite, items.length); w++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

// El endpoint de casos EXIGE que se le pase cohortId, staffId o status (si no,
// contesta 400). Como queremos todos, se pide una vez por cada estado que nos
// interesa y se junta. Devuelve un array pelado, sin paginado.
async function fetchCasos(env) {
  const porEstado = await Promise.all(ESTADOS_CASO.map(s =>
    apiGet(env.BASE, `/platform/staff/m2m/admin/coverage/cases?status=${s}`, env.STUDENT_KEY)
  ));
  const todos = [];
  porEstado.forEach(d => { if (Array.isArray(d)) todos.push(...d); });
  return todos;
}

// Las ofertas identifican a la persona por staffId, pero TODO el resto del
// tablero (perfiles, historial, asignaciones) la identifica por userId. El
// unico lugar donde conviven los dos numeros es la lista de asignaciones, que
// trae staffId y userId en la misma fila - asi que se arma el puente de ahi.
//
// Recorrer todas las asignaciones son ~30 pedidos, y es lo mas caro de todo
// este archivo. Como la pareja staffId/userId de una persona no cambia nunca,
// el puente se guarda en Redis y se rehace una vez por dia (o antes, si
// aparece un staffId que todavia no esta).
const PUENTE_KEY = 'postulaciones:bo-staffid-userid';
const PUENTE_TTL_MS = 24 * 60 * 60 * 1000;

async function escanearAsignaciones(env) {
  const mapa = {};
  const cargar = (items) => (items || []).forEach(a => {
    if (a && a.staffId && a.userId) mapa[a.staffId] = a.userId;
  });
  const first = await apiGet(env.BASE, '/platform/staff/m2m/admin/assignments?page=1&limit=100', env.STUDENT_KEY);
  cargar(first && first.items);
  const totalPages = Math.min((first && first.totalPages) || 1, 60);
  if (totalPages > 1) {
    const paginas = [];
    for (let p = 2; p <= totalPages; p++) paginas.push(p);
    const resultados = await enTandas(paginas, 15, p =>
      apiGet(env.BASE, `/platform/staff/m2m/admin/assignments?page=${p}&limit=100`, env.STUDENT_KEY)
    );
    resultados.forEach(d => cargar(d && d.items));
  }
  return mapa;
}

// `staffIdsNecesarios` es para no quedarse con un puente viejo cuando entra
// gente nueva: si alguno de los que hacen falta no esta, se vuelve a escanear
// aunque el guardado todavia no haya vencido.
async function fetchStaffIdToUserId(env, assignmentsYaLeidas, staffIdsNecesarios) {
  const semilla = {};
  (Array.isArray(assignmentsYaLeidas) ? assignmentsYaLeidas : []).forEach(a => {
    if (a && a.staffId && a.userId) semilla[a.staffId] = a.userId;
  });

  const faltaAlguno = (mapa) => (staffIdsNecesarios || []).some(id => !mapa[id]);

  const redis = (() => { try { return getRedis(); } catch (e) { return null; } })();
  if (redis) {
    try {
      const raw = await redis.get(PUENTE_KEY);
      const guardado = raw ? (typeof raw === 'object' ? raw : JSON.parse(raw)) : null;
      if (guardado && guardado.ts && (Date.now() - guardado.ts) < PUENTE_TTL_MS && guardado.mapa) {
        const mapa = { ...guardado.mapa, ...semilla };
        if (!faltaAlguno(mapa)) return mapa;
      }
    } catch (e) { /* puente ilegible -> se rehace */ }
  }

  const escaneado = await escanearAsignaciones(env);
  const mapa = { ...escaneado, ...semilla };
  if (redis) {
    try { await redis.set(PUENTE_KEY, JSON.stringify({ ts: Date.now(), mapa })); } catch (e) { /* si no se pudo guardar, la proxima vuelve a escanear */ }
  }
  return mapa;
}

function addMonthsISO(months) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const p = {};
  parts.forEach(x => { p[x.type] = x.value; });
  let year = parseInt(p.year, 10);
  let month = parseInt(p.month, 10) - 1 + months;
  const day = parseInt(p.day, 10);
  year += Math.floor(month / 12);
  month = ((month % 12) + 12) % 12;
  const ultimoDia = new Date(year, month + 1, 0).getDate();
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(Math.min(day, ultimoDia)).padStart(2, '0')}`;
}

// Las comisiones de una ventana amplia, de una sola pasada (mucho mas barato
// que pedir una por una las ~200 que aparecen en las vacantes). Las que caigan
// fuera de la ventana se buscan despues, sueltas.
async function fetchCohortsWindow(env) {
  const qs = `startDateFrom=${addMonthsISO(-6)}&startDateTo=${addMonthsISO(18)}&limit=100`;
  const first = await apiGet(env.BASE, `/student/enrollment/m2m/admin/cohorts?${qs}&page=1`, env.STUDENT_KEY);
  if (!first) return [];
  let all = (first.data || []).slice();
  const totalPages = Math.min((first.pagination && first.pagination.totalPages) || 1, 25);
  if (totalPages > 1) {
    const paginas = [];
    for (let p = 2; p <= totalPages; p++) paginas.push(p);
    const resultados = await enTandas(paginas, 10, p =>
      apiGet(env.BASE, `/student/enrollment/m2m/admin/cohorts?${qs}&page=${p}`, env.STUDENT_KEY)
    );
    resultados.forEach(d => { if (d) all = all.concat(d.data || []); });
  }
  return all;
}

async function fetchProductTitles(productIds, env) {
  const titulos = await enTandas(productIds, 20, async pid => {
    const d = await apiGet(env.BASE, `/finance/product/m2m/products/${pid}`, env.FINANCE_KEY, 1);
    let title = null;
    ((d && d.localizations) || []).forEach(loc => { if (loc.isDefault) title = loc.title; });
    if (!title && d && d.localizations && d.localizations.length) title = d.localizations[0].title;
    if (!title && d && d.program) title = d.program.name;
    return title || null;
  });
  const out = {};
  productIds.forEach((pid, i) => { out[pid] = titulos[i]; });
  return out;
}

// El nombre y el mail de cada persona salen primero del indice de cuentas que
// ya mantiene al dia la pestaña Staff (esta en Redis, sale gratis). Solo se le
// pregunta al back office por las que falten.
async function resolverPersonas(env, userIds) {
  const porUserId = {};
  try {
    const redis = getRedis();
    const raw = await redis.hgetall('staff:accounts-by-personkey');
    Object.values(raw || {}).forEach(v => {
      let cuentas = v;
      if (typeof cuentas === 'string') { try { cuentas = JSON.parse(cuentas); } catch (e) { cuentas = null; } }
      (Array.isArray(cuentas) ? cuentas : []).forEach(acc => {
        if (acc && acc.id) porUserId[acc.id] = { email: acc.email || '', firstName: acc.firstName || '', lastName: acc.lastName || '' };
      });
    });
  } catch (e) { /* si Redis no contesta, se pide todo al back office abajo */ }

  const faltantes = userIds.filter(id => !porUserId[id]);
  if (faltantes.length) {
    const users = await enTandas(faltantes, 20, id =>
      apiGet(env.BASE, `/platform/user/m2m/admin/users/${id}`, env.STUDENT_KEY, 1)
    );
    faltantes.forEach((id, i) => {
      const u = users[i];
      if (u && u.id) porUserId[id] = { email: String(u.email || '').toLowerCase(), firstName: u.firstName || '', lastName: u.lastName || '' };
    });
  }
  return porUserId;
}

// ----------------------------------------------------------------------------
// Lo de arriba junto: devuelve las postulaciones del back office con la MISMA
// forma que las que vienen de la planilla, para que el resto del tablero no
// tenga que saber de donde salio cada una.
// ----------------------------------------------------------------------------
async function construirPostulacionesBO(options) {
  const opts = options || {};
  const env = getEnv();

  const casos = await fetchCasos(env);

  // Vacante + persona, ya filtrado a lo que sirve para decidir.
  const enJuego = [];
  casos.forEach(caso => {
    (caso.offers || []).forEach(oferta => {
      if (!oferta || ESTADOS_OFERTA.indexOf(oferta.status) === -1) return;
      if (!caso.cohortId || !oferta.staffId) return;
      enJuego.push({ caso, oferta });
    });
  });
  if (!enJuego.length) return [];

  const staffIds = Array.from(new Set(enJuego.map(x => x.oferta.staffId)));
  const staffToUser = await fetchStaffIdToUserId(env, opts.assignments, staffIds);

  const userIds = Array.from(new Set(enJuego.map(x => staffToUser[x.oferta.staffId]).filter(Boolean)));
  const cohortIdsNecesarios = Array.from(new Set(enJuego.map(x => x.caso.cohortId)));

  // Si quien llama ya tenia las comisiones a mano (la pestaña Comisiones las
  // acaba de bajar para armar la tabla), se reusan en vez de volver a pedirlas.
  const cohortById = {};
  (Array.isArray(opts.cohorts) ? opts.cohorts : []).forEach(c => { if (c && c.id) cohortById[c.id] = c; });
  const faltanCohorts = cohortIdsNecesarios.some(id => !cohortById[id]);

  const [personas, cohortsVentana] = await Promise.all([
    resolverPersonas(env, userIds),
    faltanCohorts ? fetchCohortsWindow(env) : Promise.resolve([]),
  ]);
  cohortsVentana.forEach(c => { if (c && c.id && !cohortById[c.id]) cohortById[c.id] = c; });
  const sueltos = cohortIdsNecesarios.filter(id => !cohortById[id]);
  if (sueltos.length) {
    const extra = await enTandas(sueltos, 20, id =>
      apiGet(env.BASE, `/student/enrollment/m2m/admin/cohorts/${id}`, env.STUDENT_KEY, 1)
    );
    extra.forEach(c => { if (c && c.id) cohortById[c.id] = c; });
  }

  const productTitle = { ...(opts.productTitle || {}) };
  const productIds = Array.from(new Set(
    cohortIdsNecesarios.map(id => cohortById[id] && cohortById[id].productId).filter(pid => pid && !productTitle[pid])
  ));
  Object.assign(productTitle, await fetchProductTitles(productIds, env));

  const entradas = [];
  enJuego.forEach(({ caso, oferta }) => {
    const userId = staffToUser[oferta.staffId];
    const persona = userId ? personas[userId] : null;
    // Sin mail no hay forma de cruzarla con el resto del tablero (los perfiles
    // se identifican por mail), asi que se saltea en vez de inventar nada.
    if (!persona || !persona.email) return;

    const cohort = cohortById[caso.cohortId] || null;
    const nombre = `${persona.firstName} ${persona.lastName}`.trim() || persona.email.split('@')[0];

    entradas.push({
      id: 'bo-' + oferta.id,
      source: 'bo',
      origen: 'bo',
      email: persona.email,
      nombre,
      telefono: '',   // el back office no pide estos datos: solo los tiene el
      linkedin: '',   // formulario publico.
      comentarios: '',
      cohortId: caso.cohortId,
      comisionNumber: cohort ? cohort.commissionNumber : null,
      curso: (cohort && (productTitle[cohort.productId] || cohort.name)) || null,
      // El back office no guarda el rol en la oferta. Se deduce del +tag de la
      // cuenta (mismo criterio que usa el tablero para las asignaciones, ver
      // rolPorEmail en lib/elegibilidad.js); si el mail no lo dice, queda a
      // definir y el tablero lo completa con el rol que tenga cargado para ese
      // curso. Va en minusculas porque asi se guardan los roles del lado de
      // las postulaciones y de "Cursos habilitados" (PROFESOR/TUTOR en
      // mayusculas es el vocabulario de las ASIGNACIONES, otro juego de datos).
      rol: rolPorEmail(persona.email) ? rolPorEmail(persona.email).toLowerCase() : null,
      fecha: oferta.createdAt || caso.createdAt || null,
      estado: ESTADO_POR_OFERTA[oferta.status] || 'pendiente',
      // Datos que solo existen en este origen, para poder mostrarlos y para
      // dejar claro que esto NO es una postulacion espontanea.
      boEstadoOferta: oferta.status,
      boEstadoVacante: caso.status,
      boTipo: caso.kind, // ASSIGNMENT = vacante de la comision; REPLACEMENT/SUBSTITUTION = reemplazo
      boMotivo: (oferta.matchReasons || []).join(', ') || null,
      boRank: oferta.rank != null ? oferta.rank : null,
    });
  });

  return entradas;
}

// Version cacheada (15 min en Redis). Si Redis no esta, simplemente se
// reconstruye cada vez: mas lento, pero nunca deja de funcionar.
async function getPostulacionesBO(opts) {
  const options = opts || {};
  const redis = (() => { try { return getRedis(); } catch (e) { return null; } })();

  if (redis && !options.forzarRefresco) {
    try {
      const raw = await redis.get(CACHE_KEY);
      const cache = raw ? (typeof raw === 'object' ? raw : JSON.parse(raw)) : null;
      if (cache && cache.ts && (Date.now() - cache.ts) < CACHE_TTL_MS && Array.isArray(cache.entradas)) {
        return cache.entradas;
      }
    } catch (e) { /* cache ilegible -> se reconstruye */ }
  }

  const entradas = await construirPostulacionesBO(options);
  if (redis) {
    try { await redis.set(CACHE_KEY, JSON.stringify({ ts: Date.now(), entradas })); } catch (e) { /* si no se pudo cachear, la proxima vuelve a construir */ }
  }
  return entradas;
}

// ----------------------------------------------------------------------------
// LO QUE USA EL RESTO DEL TABLERO: las dos fuentes juntas, en una sola lista.
//
// Si la misma persona aparece en las dos para la misma comision (lleno el
// formulario Y ademas el sistema se la ofrecio), se muestra una sola vez, con
// los datos del formulario (que son mas completos) y marcada con origen
// 'ambos'. El estado que manda es el que se haya revisado desde el tablero,
// porque es una decision tomada por una persona.
//
// Si una de las dos fuentes falla (Redis caido, back office lento), se
// devuelve lo que si se pudo leer en vez de romper la pantalla entera.
// ----------------------------------------------------------------------------
async function getPostulacionesCombinadas(opts) {
  const [delFormulario, delBackOffice] = await Promise.all([
    getAllPostulaciones().catch(() => []),
    getPostulacionesBO(opts).catch(() => []),
  ]);

  const porPersonaYComision = new Map();
  const clave = (p) => personKey(p.email) + '|' + (p.cohortId || ('sin-cohort:' + p.comisionNumber));

  (delFormulario || []).forEach(p => {
    if (!p || !p.email) return;
    porPersonaYComision.set(clave(p), { ...p, origen: 'formulario' });
  });

  (delBackOffice || []).forEach(p => {
    if (!p || !p.email) return;
    const k = clave(p);
    const previa = porPersonaYComision.get(k);
    if (!previa) {
      porPersonaYComision.set(k, p);
      return;
    }
    // Ya se habia postulado por formulario: se conserva todo lo de ahi (datos
    // de contacto, estado revisado) y se le suma el detalle del back office.
    porPersonaYComision.set(k, {
      ...previa,
      origen: 'ambos',
      boEstadoOferta: p.boEstadoOferta,
      boEstadoVacante: p.boEstadoVacante,
      boTipo: p.boTipo,
      boMotivo: p.boMotivo,
      boRank: p.boRank,
    });
  });

  return Array.from(porPersonaYComision.values());
}

module.exports = { getPostulacionesBO, getPostulacionesCombinadas };
