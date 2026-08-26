// ============================================================================
// Datos propios de "Certificaciones": el proceso por el cual alguien que ya
// da clases de un curso se postula a certificarse en OTRO curso (o en otro
// rol del mismo curso). Se guarda todo en Redis, en dos Hash separados:
//
//   staff:certificaciones   -> cada campo es el id de una certificacion, el
//                              valor es el registro completo (persona,
//                              curso, rol, nota, estado, fechas).
//   staff:cert-preguntas    -> cada campo es "curso|rol" (en minusculas), el
//                              valor es el array de preguntas de opcion
//                              multiple de esa evaluacion.
//
// Un Hash (en vez de una lista, como postulaciones) porque cada
// certificacion se tiene que poder actualizar por su id sin releer/reescribir
// todo (aprobar, desaprobar, habilitar de nuevo).
// ============================================================================

const { getRedis } = require('./redis');
const { personKey } = require('./overlay');

const CERT_KEY = 'staff:certificaciones';
const PREGUNTAS_KEY = 'staff:cert-preguntas';

function parseValue(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (e) { return null; }
}

function preguntasKey(curso, rol) {
  return String(curso || '').trim().toLowerCase() + '|' + String(rol || '').trim().toLowerCase();
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------------------------------------------------------------------------
// Certificaciones
// ---------------------------------------------------------------------------

async function getAllCertificaciones() {
  const redis = getRedis();
  const raw = await redis.hgetall(CERT_KEY);
  const out = [];
  if (raw) {
    Object.keys(raw).forEach(id => {
      const parsed = parseValue(raw[id]);
      if (parsed) out.push({ ...parsed, id });
    });
  }
  return out;
}

async function getCertificacion(id) {
  const redis = getRedis();
  const v = await redis.hget(CERT_KEY, id);
  return parseValue(v);
}

async function saveCertificacion(cert) {
  const redis = getRedis();
  await redis.hset(CERT_KEY, { [cert.id]: JSON.stringify(cert) });
  return cert;
}

// Ultimo intento (el de fecha mas reciente) de esta persona para este
// curso+rol exacto. Se usa para el bloqueo de 6 meses y para no permitir
// mandar dos evaluaciones a la vez para la misma combinacion.
async function getUltimoIntento(email, curso, rol) {
  const key = personKey(email);
  const todos = await getAllCertificaciones();
  const propios = todos.filter(c => personKey(c.email) === key && c.curso === curso && c.rol === rol);
  if (!propios.length) return null;
  propios.sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')));
  return propios[0];
}

function nuevaCertificacion({ nombre, email, curso, rol, nota, estado, cooldownHasta }) {
  return {
    id: genId(),
    nombre,
    email: String(email || '').toLowerCase().trim(),
    curso,
    rol,
    nota,
    estado, // 'pendiente' | 'aprobado' | 'desaprobado'
    fecha: new Date().toISOString(),
    fechaDecision: null,
    cooldownHasta: cooldownHasta || null,
  };
}

// ---------------------------------------------------------------------------
// Banco de preguntas por curso+rol
// ---------------------------------------------------------------------------

async function getAllPreguntas() {
  const redis = getRedis();
  const raw = await redis.hgetall(PREGUNTAS_KEY);
  const out = {};
  if (raw) {
    Object.keys(raw).forEach(key => {
      const parsed = parseValue(raw[key]);
      out[key] = Array.isArray(parsed) ? parsed : [];
    });
  }
  return out;
}

async function getPreguntas(curso, rol) {
  const redis = getRedis();
  const v = await redis.hget(PREGUNTAS_KEY, preguntasKey(curso, rol));
  const parsed = parseValue(v);
  return Array.isArray(parsed) ? parsed : [];
}

async function savePreguntas(curso, rol, lista) {
  const redis = getRedis();
  await redis.hset(PREGUNTAS_KEY, { [preguntasKey(curso, rol)]: JSON.stringify(lista) });
}

module.exports = {
  CERT_KEY, PREGUNTAS_KEY,
  genId, preguntasKey,
  getAllCertificaciones, getCertificacion, saveCertificacion, getUltimoIntento, nuevaCertificacion,
  getAllPreguntas, getPreguntas, savePreguntas,
};
