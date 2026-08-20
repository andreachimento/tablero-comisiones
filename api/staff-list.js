// ============================================================================
// FUNCION SERVERLESS: listado de Staff
// ============================================================================
// Trae a TODOS los profesores/tutores que existen como usuarios reales en el
// back office de Coderhouse (rol INSTRUCTOR, mas los que tienen asignaciones
// reales aunque su "role" este mal cargado) y les suma la info que se guarda
// en la base de datos propia del tablero (estado, cursos habilitados,
// rating). Tambien agrega los perfiles "extraidos de Dash" (gente que esta en
// la base de habilitados de Andrea pero todavia no participo en el back
// office).
//
// PERFILES UNIFICADOS: una misma persona suele tener varias cuentas en el
// back office con el mismo mail base pero un "+tag" distinto (ej.
// fulano@x.com, fulano+tutor@x.com, fulano+profesor@x.com). Aca
// agrupamos todas las cuentas que comparten ese mail base (personKey) en UNA
// sola fila del listado, y de paso vamos migrando los datos propios
// (comentarios, cursos habilitados, etc.) que hubiera cargados en cualquiera
// de esas cuentas hacia una unica clave canonica, para que de aca en mas
// todo se guarde y lea en un solo lugar por persona.
//
// Esta consulta SI vuelve a pedir la lista de instructores y el indice de
// asignaciones a Coderhouse cada vez, asi que siempre refleja altas/bajas
// reales de cuentas. Lo que puede tardar un poquito mas es el historial de
// comisiones de cada persona: eso se trae aparte, solo cuando se abre su
// perfil (api/staff-profile.js), para no tener que traer miles de
// asignaciones acá.
// ============================================================================

const { getAllOverlays, defaultOverlay, personKey, mergeOverlays, setAccountsIndexBulk, deleteOverlayEntries, OVERLAY_KEY } = require('../lib/overlay');
const { getRedis } = require('../lib/redis');
const { getPostHogRatings } = require('../lib/posthog');

const TZ = 'America/Argentina/Buenos_Aires';

function getEnv() {
  const BASE = process.env.BACKOFFICE_API_URL;
  const STUDENT_KEY = process.env.CLAUDE_STUDENT_API_KEY;
  if (!BASE || !STUDENT_KEY) {
    throw new Error('Faltan Environment Variables en Vercel (BACKOFFICE_API_URL / CLAUDE_STUDENT_API_KEY).');
  }
  return { BASE, STUDENT_KEY };
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
  return {};
}

async function fetchAllInstructors(env) {
  const first = await apiGet(env.BASE, '/platform/user/m2m/admin/users?role=INSTRUCTOR&page=1&limit=100', env.STUDENT_KEY);
  let all = (first.items || []).slice();
  const totalPages = Math.min(first.totalPages || 1, 30);
  if (totalPages > 1) {
    const proms = [];
    for (let p = 2; p <= totalPages; p++) {
      proms.push(apiGet(env.BASE, `/platform/user/m2m/admin/users?role=INSTRUCTOR&page=${p}&limit=100`, env.STUDENT_KEY));
    }
    const results = await Promise.all(proms);
    results.forEach(d => { all = all.concat(d.items || []); });
  }
  return all;
}

// ----------------------------------------------------------------------------
// IMPORTANTE: el filtro ?role=INSTRUCTOR del back office NO alcanza a todo el
// mundo. Se detecto que el campo "role" de la cuenta de una persona puede
// quedar en "STUDENT" (o directamente vacio) aunque esa cuenta tenga
// comisiones reales y activas asignadas - el dato confiable de si da clases
// vive en publicMetadata.role, que ese endpoint de listado no usa para
// filtrar. Para no perder a esa gente del tablero (se detectaron ~260 casos
// asi), ademas de pedir los INSTRUCTOR de siempre, recorremos TODAS las
// asignaciones de la plataforma, sacamos los ids de usuario que aparecen ahi
// y les buscamos el mail/nombre a los que todavia no esten en la lista de
// arriba.
// ----------------------------------------------------------------------------
async function fetchAssignmentUserIds(env) {
  const first = await apiGet(env.BASE, '/platform/staff/m2m/admin/assignments?page=1&limit=100', env.STUDENT_KEY);
  const ids = new Set();
  (first.items || []).forEach(a => { if (a.userId) ids.add(a.userId); });
  const totalPages = Math.min(first.totalPages || 1, 60);
  if (totalPages > 1) {
    const proms = [];
    for (let p = 2; p <= totalPages; p++) {
      proms.push(apiGet(env.BASE, `/platform/staff/m2m/admin/assignments?page=${p}&limit=100`, env.STUDENT_KEY));
    }
    const results = await Promise.all(proms);
    results.forEach(d => (d.items || []).forEach(a => { if (a.userId) ids.add(a.userId); }));
  }
  return ids;
}

// Trae el usuario por id, con concurrencia limitada para no saturar el back
// office cuando son varios cientos de ids sueltos.
async function fetchUsersByIds(env, ids) {
  const out = [];
  const CONCURRENCY = 30;
  let i = 0;
  async function worker() {
    while (i < ids.length) {
      const idx = i++;
      const id = ids[idx];
      const u = await apiGet(env.BASE, `/platform/user/m2m/admin/users/${id}`, env.STUDENT_KEY, 1);
      if (u && u.id) out.push(u);
    }
  }
  const workers = [];
  for (let w = 0; w < CONCURRENCY; w++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

function avgRating(ratings) {
  const vals = Object.values(ratings || {}).filter(v => typeof v === 'number' && v > 0);
  if (!vals.length) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
}

module.exports = async function handler(req, res) {
  try {
    const env = getEnv();
    const [instructors, overlays, assignmentUserIdsResult] = await Promise.all([
      fetchAllInstructors(env),
      getAllOverlays().catch(err => {
        // Si todavia no esta conectada la base de datos, seguimos mostrando
        // el listado del back office igual (sin estado/cursos/rating), en
        // vez de romper toda la pestaña.
        return { __error: String(err && err.message ? err.message : err) };
      }),
      fetchAssignmentUserIds(env).catch(err => ({ __error: String(err && err.message ? err.message : err) })),
    ]);

    const overlayError = overlays && overlays.__error ? overlays.__error : null;
    const overlayMap = overlayError ? {} : overlays;

    // rawAccounts: TODAS las cuentas reales del back office (una por mail),
    // vengan del filtro ?role=INSTRUCTOR o del escaneo de asignaciones.
    const rawAccounts = [];
    const byId = {};
    instructors.forEach(u => {
      const email = String(u.email || '').toLowerCase().trim();
      if (!email || !u.id) return;
      rawAccounts.push({ id: u.id, email, firstName: u.firstName || '', lastName: u.lastName || '' });
      byId[u.id] = true;
    });

    // Gente con asignaciones reales cuyo "role" no la marca como INSTRUCTOR
    // (ver comentario en fetchAssignmentUserIds) - se agrega aparte para no
    // perderla del tablero.
    let assignmentScanError = null;
    if (assignmentUserIdsResult instanceof Set) {
      const missingIds = Array.from(assignmentUserIdsResult).filter(id => !byId[id]);
      if (missingIds.length) {
        const extraUsers = await fetchUsersByIds(env, missingIds);
        extraUsers.forEach(u => {
          const email = String(u.email || '').toLowerCase().trim();
          if (!email || !u.id) return;
          rawAccounts.push({ id: u.id, email, firstName: u.firstName || '', lastName: u.lastName || '' });
        });
      }
    } else if (assignmentUserIdsResult && assignmentUserIdsResult.__error) {
      // No pudimos escanear las asignaciones para completar la lista: seguimos
      // mostrando lo que ya tenemos (los INSTRUCTOR de siempre) en vez de
      // romper toda la pestaña, pero avisamos del problema.
      assignmentScanError = assignmentUserIdsResult.__error;
    }

    // ------------------------------------------------------------------
    // PERFILES UNIFICADOS: agrupamos todas las cuentas reales (rawAccounts)
    // y todas las entradas de la base propia (overlayMap) por su mail base
    // (personKey), para que una misma persona con varias cuentas del back
    // office aparezca en UNA sola fila.
    // ------------------------------------------------------------------
    const groups = {}; // personKey -> { accounts: [...], overlayEmails: Set }
    function getGroup(key) {
      if (!groups[key]) groups[key] = { accounts: [], overlayEmails: new Set() };
      return groups[key];
    }
    rawAccounts.forEach(acc => {
      getGroup(personKey(acc.email)).accounts.push(acc);
    });
    Object.keys(overlayMap).forEach(email => {
      getGroup(personKey(email)).overlayEmails.add(email);
    });

    // Migracion (automatica, unica por persona): si una persona tiene datos
    // propios cargados en mas de un mail (o en un mail que no es su
    // personKey), los unificamos en una sola entrada canonica (la del
    // personKey) y borramos las entradas viejas, para que de aca en mas
    // quede todo guardado en un solo lugar. Si ya estaba todo unificado, no
    // se toca nada.
    const overlayUpdates = {};
    const overlayEmailsToDelete = [];
    const accountsIndexUpdates = {};
    const finalOverlayByKey = {};

    Object.keys(groups).forEach(key => {
      const g = groups[key];
      const relevantEmails = Array.from(g.overlayEmails);
      const alreadyCanonical = relevantEmails.length <= 1 && (relevantEmails.length === 0 || relevantEmails[0] === key);

      if (alreadyCanonical) {
        finalOverlayByKey[key] = overlayMap[key] || null;
      } else {
        const merged = mergeOverlays(relevantEmails.map(e => overlayMap[e]));
        finalOverlayByKey[key] = merged;
        if (!overlayError) {
          overlayUpdates[key] = merged;
          relevantEmails.forEach(e => { if (e !== key) overlayEmailsToDelete.push(e); });
        }
      }

      if (g.accounts.length) {
        accountsIndexUpdates[key] = g.accounts.map(a => ({ id: a.id, email: a.email, firstName: a.firstName, lastName: a.lastName }));
      }
    });

    // Escribimos la migracion y el indice de cuentas en tandas, sin que un
    // fallo de escritura rompa la respuesta (la migracion se va a reintentar
    // sola la proxima vez que se cargue el listado).
    if (!overlayError) {
      try {
        if (Object.keys(overlayUpdates).length) {
          const redis = getRedis();
          const entries = Object.entries(overlayUpdates).map(([k, v]) => [k, JSON.stringify(v)]);
          const BATCH = 200;
          for (let i = 0; i < entries.length; i += BATCH) {
            const chunk = Object.fromEntries(entries.slice(i, i + BATCH));
            await redis.hset(OVERLAY_KEY, chunk);
          }
        }
        if (overlayEmailsToDelete.length) await deleteOverlayEntries(overlayEmailsToDelete);
      } catch (e) { /* se reintenta solo en la proxima carga */ }
    }
    try {
      if (Object.keys(accountsIndexUpdates).length) await setAccountsIndexBulk(accountsIndexUpdates);
    } catch (e) { /* se reintenta solo en la proxima carga */ }

    const staffBase = Object.keys(groups).map(key => {
      const g = groups[key];
      const ov = finalOverlayByKey[key] || defaultOverlay();
      const cursos = ov.cursosHabilitados || [];
      const roles = Array.from(new Set(cursos.map(c => c.rol).filter(Boolean)));
      const ratingVals = Object.values(ov.ratings || {}).filter(v => typeof v === 'number' && v > 0);

      let nombre = '';
      const withName = g.accounts.find(a => a.firstName || a.lastName);
      if (withName) nombre = `${withName.firstName || ''} ${withName.lastName || ''}`.trim();
      if (!nombre) nombre = `${ov.nombre || ''} ${ov.apellido || ''}`.trim();
      if (!nombre) nombre = key.split('@')[0];

      return {
        email: key,
        nombre,
        source: g.accounts.length ? 'backoffice' : 'dash',
        cuentas: g.accounts.length, // cantidad de cuentas del back office unificadas en esta fila
        estado: ov.estado || 'aprobado',
        cursosHabilitados: cursos,
        roles,
        ratingManualPromedio: avgRating(ov.ratings),
        ratingManualCount: ratingVals.length,
        _accountEmails: g.accounts.map(a => a.email),
      };
    });

    // Rating real (PostHog), para todo el listado en una sola consulta
    // (cacheada 15 min en lib/posthog.js). OJO: aca solo se puede cruzar por
    // mail (filas nuevas de la encuesta, que ya traen el mail del profesor) -
    // el puente por numero de comision (filas viejas de la encuesta) no esta
    // disponible en este listado porque, a proposito, no se trae el
    // historial de comisiones de cada persona aca (es lo que tarda mas y por
    // eso se pide aparte, solo al abrir el perfil - ver comentario arriba).
    // Quien todavia no tenga ninguna respuesta "nueva" en PostHog sigue
    // viendo su rating manual (si lo tenia) hasta que entre a su perfil,
    // donde si se hace el cruce completo.
    let postHogRatings = {};
    try {
      postHogRatings = await getPostHogRatings(staffBase.map(s => ({
        key: s.email,
        emails: Array.from(new Set([s.email].concat(s._accountEmails))),
        commissionNumbers: [],
      })));
    } catch (e) { /* seguimos con el rating manual de cada uno */ }

    const staff = staffBase.map(s => {
      const ph = postHogRatings[s.email];
      const usaPostHog = ph && ph.ratingCount > 0;
      const { _accountEmails, ratingManualPromedio, ratingManualCount, ...rest } = s;
      return {
        ...rest,
        ratingPromedio: usaPostHog ? ph.ratingPromedio : ratingManualPromedio,
        ratingCount: usaPostHog ? ph.ratingCount : ratingManualCount,
        ratingSource: usaPostHog ? 'posthog' : (ratingManualPromedio != null ? 'manual' : null),
      };
    });

    staff.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));

    res.status(200).json({
      staff,
      total: staff.length,
      overlayError,
      assignmentScanError,
      lastUpdate: new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()).replace(',', ''),
    });
  } catch (err) {
    res.status(200).json({ error: String(err && err.message ? err.message : err) });
  }
};
