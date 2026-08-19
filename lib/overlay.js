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

module.exports = { getAllOverlays, getOverlay, setOverlay, defaultOverlay, normalize, OVERLAY_KEY };
