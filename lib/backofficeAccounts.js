// ============================================================================
// Chequeo EN VIVO de "¿existe una cuenta real en el back office para este
// mail?" - usado exclusivamente por la migracion/sincronizacion del CRM de
// Relaciones Laborales de Notion (api/admin-import-notion-comments.js y,
// si hiciera falta, api/staff-comments-sync.js).
//
// Por que existe este archivo aparte (y no se reusa tal cual api/staff-list.js):
// la regla de seguridad que aprobo Andrea para la migracion es "solo se
// escribe un comentario en un perfil si se confirma que existe una cuenta
// real en el back office para ese mail - nunca se adivina, y nunca alcanza
// con que el mail haya aparecido en la planilla vieja de Notion". La lista
// local data/seed-staff.json (usada para la auditoria previa) es una FOTO
// vieja armada a mano; ESTE archivo en cambio pega en vivo contra el back
// office de Coderhouse (los mismos endpoints que ya usa api/staff-list.js
// para armar la pestaña Staff), cada vez que se corre la migracion, para que
// la decision de escribir o no sea siempre con datos actuales.
//
// Necesita las mismas Environment Variables que ya usa api/staff-list.js:
// BACKOFFICE_API_URL y CLAUDE_STUDENT_API_KEY. Si no estan configuradas,
// getLiveAccountsIndex() devuelve { error: '...' } en vez de tirar excepcion,
// y quien lo llama debe tratarlo como "no se pudo confirmar nada en vivo" ->
// FALLAR CERRADO (no escribir nada), nunca asumir que las cuentas existen.
// ============================================================================

const { personKey } = require('./overlay');

function getEnv() {
  const BASE = process.env.BACKOFFICE_API_URL;
  const STUDENT_KEY = process.env.CLAUDE_STUDENT_API_KEY;
  if (!BASE || !STUDENT_KEY) return null;
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

// Igual criterio que api/staff-list.js: el filtro ?role=INSTRUCTOR no
// alcanza a todo el mundo (hay cuentas con "role" mal cargado pero
// asignaciones reales), asi que tambien escaneamos las asignaciones.
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

// Devuelve { indexByPersonKey: Map<personKey, [{id,email,firstName,lastName}]>, error: string|null }
// El Map SOLO tiene entradas para personas con al menos una cuenta real
// confirmada en vivo en este mismo momento. Si personKey no esta en el Map
// (o el Map tiene 0 elementos para esa clave), NO hay que escribir nada para
// esa persona.
async function getLiveAccountsIndex() {
  const env = getEnv();
  if (!env) {
    return { indexByPersonKey: null, error: 'Faltan BACKOFFICE_API_URL / CLAUDE_STUDENT_API_KEY en las Environment Variables de Vercel - no se puede confirmar en vivo ninguna cuenta.' };
  }
  try {
    const [instructors, assignmentIdsResult] = await Promise.all([
      fetchAllInstructors(env),
      fetchAssignmentUserIds(env).catch(() => null),
    ]);

    const rawAccounts = [];
    const byId = {};
    instructors.forEach(u => {
      const email = String(u.email || '').toLowerCase().trim();
      if (!email || !u.id) return;
      rawAccounts.push({ id: u.id, email, firstName: u.firstName || '', lastName: u.lastName || '' });
      byId[u.id] = true;
    });

    if (assignmentIdsResult instanceof Set) {
      const missingIds = Array.from(assignmentIdsResult).filter(id => !byId[id]);
      if (missingIds.length) {
        const extraUsers = await fetchUsersByIds(env, missingIds);
        extraUsers.forEach(u => {
          const email = String(u.email || '').toLowerCase().trim();
          if (!email || !u.id) return;
          rawAccounts.push({ id: u.id, email, firstName: u.firstName || '', lastName: u.lastName || '' });
        });
      }
    }

    const indexByPersonKey = new Map();
    rawAccounts.forEach(acc => {
      const key = personKey(acc.email);
      if (!indexByPersonKey.has(key)) indexByPersonKey.set(key, []);
      indexByPersonKey.get(key).push(acc);
    });

    return { indexByPersonKey, error: null };
  } catch (e) {
    return { indexByPersonKey: null, error: 'Fallo consultando el back office en vivo: ' + String(e && e.message ? e.message : e) };
  }
}

module.exports = { getLiveAccountsIndex };
