// ============================================================================
// Datos "propios" del tablero de Staff (todo lo que no viene de la API de
// Coderhouse): estado del perfil, comentarios, cursos habilitados,
// calificaciones y datos de los perfiles "extraidos de Dash".
//
// Se guarda todo en un unico Hash de Redis (staff:overlay), donde cada campo
// es el mail (en minusculas) de la persona y el valor es un JSON con su
// informacion. Un Hash permite traer TODO de una sola consulta (HGETALL),
// cosa clave porque la pestaña Staff necesita cruzar esto con cientos de
// perfiles del back office cada vez que se abre.
// ============================================================================

const { getRedis } = require('./redis');

const OVERLAY_KEY = 'staff:overlay';
// Hash separado que guarda, para cada "persona unificada" (personKey), la
// lista de cuentas reales del back office que le pertenecen. Lo arma y lo
// mantiene al dia api/staff-list.js cada vez que corre (siempre con datos
// frescos de Coderhouse), y lo lee api/staff-profile.js para saber de que
// cuentas traer el historial en vivo sin tener que re-escanear toda la
// plataforma en cada click.
const ACCOUNTS_KEY = 'staff:accounts-by-personkey';

function defaultOverlay() {
  return {
    estado: 'aprobado',
    comentarios: [],
    cursosHabilitados: [],
    ratings: {},
    esDash: false,
    nombre: '',
    apellido: '',
  };
}

function normalize(email) {
  return String(email || '').toLowerCase().trim();
}

// ----------------------------------------------------------------------------
// Unificacion de perfiles: en el back office de Coderhouse, la MISMA persona
// suele tener varias cuentas separadas con el mismo mail base pero un
// "+tag" distinto antes de la arroba (ej. leiva.rodrigo@outlook.es,
// leiva.rodrigo+tutor@outlook.es, leiva.rodrigo+profesor@outlook.es son las
// 3 cuentas de la misma persona). personKey() saca ese mail base, que se usa
// como identidad unica de la persona en todo el tablero (para agrupar
// cuentas, y como clave unica de guardado en la base propia).
// ----------------------------------------------------------------------------
function personKey(email) {
  const norm = normalize(email);
  const at = norm.indexOf('@');
  if (at === -1) return norm;
  const domain = norm.slice(at);
  let local = norm.slice(0, at);
  const plus = local.indexOf('+');
  if (plus !== -1) local = local.slice(0, plus);
  return local + domain;
}

function parseValue(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v; // el cliente de Upstash a veces ya lo deserializa solo
  try { return JSON.parse(v); } catch (e) { return null; }
}

async function getAllOverlays() {
  const redis = getRedis();
  const raw = await redis.hgetall(OVERLAY_KEY);
  const out = {};
  if (raw) {
    Object.keys(raw).forEach(email => {
      const parsed = parseValue(raw[email]);
      out[email] = parsed || defaultOverlay();
    });
  }
  return out;
}

async function getOverlay(email) {
  const redis = getRedis();
  const v = await redis.hget(OVERLAY_KEY, normalize(email));
  const parsed = parseValue(v);
  return parsed || defaultOverlay();
}

async function setOverlay(email, overlay) {
  const redis = getRedis();
  await redis.hset(OVERLAY_KEY, { [normalize(email)]: JSON.stringify(overlay) });
}

// Junta varios overlays (de distintos mails de la misma persona) en uno
// solo. Comentarios se juntan todos (mas nuevo primero), cursos habilitados
// se juntan sin duplicar el mismo curso+rol, ratings se combinan (las claves
// son ids de comision, siempre unicas), y estado/nombre/apellido toman el
// primer valor "no default" que encuentren.
function mergeOverlays(overlays) {
  const merged = defaultOverlay();
  const seenCursos = new Set();
  const allComentarios = [];
  let estadoSet = false;
  (overlays || []).forEach(ov => {
    if (!ov) return;
    (ov.comentarios || []).forEach(c => allComentarios.push(c));
    (ov.cursosHabilitados || []).forEach(c => {
      const k = String(c.curso || '').toLowerCase() + '|' + c.rol;
      if (!seenCursos.has(k)) { seenCursos.add(k); merged.cursosHabilitados.push(c); }
    });
    Object.assign(merged.ratings, ov.ratings || {});
    if (!estadoSet && ov.estado && ov.estado !== 'aprobado') { merged.estado = ov.estado; estadoSet = true; }
    if (!merged.nombre && ov.nombre) merged.nombre = ov.nombre;
    if (!merged.apellido && ov.apellido) merged.apellido = ov.apellido;
  });
  allComentarios.sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')));
  merged.comentarios = allComentarios;
  return merged;
}

async function getAccountsForPerson(key) {
  const redis = getRedis();
  const v = await redis.hget(ACCOUNTS_KEY, key);
  const parsed = parseValue(v);
  return Array.isArray(parsed) ? parsed : null; // null = todavia no se indexo (cache frio)
}

// Guarda en tandas de 200 campos por llamada, igual que la importacion del
// Excel, para que esto ande rapido aunque sean cientos de personas.
async function setAccountsIndexBulk(map) {
  const redis = getRedis();
  const entries = Object.entries(map).map(([k, v]) => [k, JSON.stringify(v)]);
  const BATCH = 200;
  for (let i = 0; i < entries.length; i += BATCH) {
    const chunk = Object.fromEntries(entries.slice(i, i + BATCH));
    await redis.hset(ACCOUNTS_KEY, chunk);
  }
}

async function deleteOverlayEntries(emails) {
  if (!emails || !emails.length) return;
  const redis = getRedis();
  const CHUNK = 200;
  for (let i = 0; i < emails.length; i += CHUNK) {
    await redis.hdel(OVERLAY_KEY, ...emails.slice(i, i + CHUNK));
  }
}

module.exports = {
  getAllOverlays, getOverlay, setOverlay, defaultOverlay, normalize, OVERLAY_KEY,
  personKey, mergeOverlays, getAccountsForPerson, setAccountsIndexBulk, deleteOverlayEntries, ACCOUNTS_KEY,
};
