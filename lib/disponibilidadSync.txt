// ============================================================================
// Sincroniza las respuestas de la encuesta de disponibilidad horaria de
// profesores/tutores (planilla de Google Sheets "Disponibilidad horaria -
// Profesores y Tutores Coderhouse") hacia el apartado "Disponibilidad" de
// cada perfil del tablero.
//
// Funciona igual que lib/postulacionesSync.js: la planilla esta compartida
// como "Cualquiera con el enlace puede ver", asi que el tablero la lee
// directo por el enlace publico de exportacion a CSV, sin necesitar ninguna
// credencial ni cuenta de servicio.
//
// A diferencia de postulaciones, aca SI se pisa el campo "disponibilidad" de
// cada perfil con lo que diga la planilla en cada sincronizacion (se toma
// como la fuente de verdad de esa encuesta) - el resto del perfil
// (comentarios, cursos habilitados, estado, ratings) nunca se toca.
// ============================================================================

const { setDisponibilidadBulk } = require('./overlay');
const { getRedis } = require('./redis');

const SPREADSHEET_ID = '1rheOA3i38TgsaRRL_vxTPW9nGwOgelvdRKyTSDbq20s';
const GID = '0';

const DIAS_DISPONIBLES = ['Lunes', 'Martes', 'Miercoles', 'Jueves', 'Viernes', 'Sabado'];
const FRANJAS_DISPONIBLES = ['7:30-10:00hs', '10:00-12:00hs', '11:00-13:00hs', '18:30-21:00hs', '19:00-21:00hs', '20:30-22:30hs'];

const SYNC_STATUS_KEY = 'disponibilidad:sync-status';
const SYNC_STALE_MS = 55 * 60 * 1000;

function getSheetEnv() {
  return {
    spreadsheetId: process.env.DISPONIBILIDAD_SHEET_ID || SPREADSHEET_ID,
    gid: process.env.DISPONIBILIDAD_SHEET_GID || GID,
  };
}

// Mismo parser de CSV que postulacionesSync.js (duplicado a proposito para
// no depender de ese archivo ni arriesgar romper algo que ya funciona).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const normalized = String(text || '').replace(/\r\n/g, '\n');
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i];
    if (inQuotes) {
      if (c === '"') {
        if (normalized[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else {
      field += c;
    }
  }
  row.push(field);
  rows.push(row);
  return rows.filter(r => r.some(c => String(c || '').trim() !== ''));
}

async function fetchPublicSheetRows(spreadsheetId, gid) {
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`;
  const resp = await fetch(url, { redirect: 'follow' });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Google devolvio un error al descargar la planilla publica (HTTP ${resp.status}).`);
  }
  if (/^\s*<(!doctype|html)/i.test(text)) {
    throw new Error('Google devolvio una pagina de login en vez del CSV - revisar que la planilla siga compartida como "Cualquiera con el enlace puede ver".');
  }
  return parseCsv(text);
}

function findCol(headers, keywords) {
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return headers.findIndex(h => keywords.some(k => norm(h).includes(k)));
}

function quitarAcentos(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizarDia(raw) {
  const s = quitarAcentos(raw).trim().toLowerCase();
  return DIAS_DISPONIBLES.find(d => quitarAcentos(d).toLowerCase() === s) || null;
}

function normalizarFranja(raw) {
  const s = String(raw || '').trim();
  return FRANJAS_DISPONIBLES.includes(s) ? s : null;
}

// La columna de mail puede traer mas de un mail (separados por "/", cuando
// la persona puso su cuenta de profesor Y de tutor, o hay errores de tipeo
// comunes en la encuesta - espacio despues del "+", dos "@", el "+tag"
// pegado despues del dominio en vez de antes). Se intenta recuperar el mail
// valido en cada caso; si no se puede, se descarta esa fila (sin romper el
// resto de la sincronizacion).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
function extraerEmails(raw) {
  const out = [];
  String(raw || '').split('/').forEach(tokRaw => {
    let tok = tokRaw.trim().toLowerCase();
    tok = tok.replace(/\+\s+/, '+'); // "x+ profesor@.." -> "x+profesor@.."
    const m = tok.match(/^([^\s@]+@[^\s@]+\.[a-zA-Z]{2,})\+/); // "x@dominio.com+tag" -> "x@dominio.com"
    if (m) tok = m[1];
    if ((tok.match(/@/g) || []).length > 1) {
      const first = tok.indexOf('@');
      tok = tok.slice(0, first) + tok.slice(first + 1);
    }
    if (EMAIL_RE.test(tok)) out.push(tok);
  });
  return out;
}

async function syncDisponibilidadFromSheet() {
  const sheetEnv = getSheetEnv();
  const rows = await fetchPublicSheetRows(sheetEnv.spreadsheetId, sheetEnv.gid);
  if (!rows.length) return { ok: true, leidas: 0, procesadas: 0, sinEmail: 0 };

  const headerRowIdx = rows.findIndex(r => (r || []).some(c => String(c || '').toLowerCase().includes('submitted')));
  if (headerRowIdx === -1) throw new Error('No se encontro la fila de encabezados ("Submitted at") en la planilla de disponibilidad.');
  const headers = rows[headerRowIdx];
  const dataRows = rows.slice(headerRowIdx + 1);

  const col = {
    fecha: findCol(headers, ['submitted']),
    nombre: findCol(headers, ['nombre']),
    email: findCol(headers, ['mail']),
    dias: findCol(headers, ['dia']),
    franjas: findCol(headers, ['franja']),
  };
  if (col.email === -1) throw new Error('No se encontro la columna de Email en la planilla de disponibilidad.');

  let sinEmail = 0;
  const entries = [];
  dataRows.forEach(r => {
    const nombre = col.nombre !== -1 ? String(r[col.nombre] || '').trim() : '';
    const fecha = col.fecha !== -1 ? String(r[col.fecha] || '').trim() : '';
    const dias = col.dias !== -1
      ? Array.from(new Set(String(r[col.dias] || '').split(',').map(normalizarDia).filter(Boolean)))
      : [];
    const franjas = col.franjas !== -1
      ? Array.from(new Set(String(r[col.franjas] || '').split(',').map(normalizarFranja).filter(Boolean)))
      : [];
    const emails = extraerEmails(r[col.email]);
    if (!emails.length) { sinEmail++; return; }
    emails.forEach(email => entries.push({ email, nombre, dias, franjas, fecha }));
  });

  const resultado = await setDisponibilidadBulk(entries);
  return {
    ok: true,
    leidas: dataRows.length,
    procesadas: entries.length,
    personasActualizadas: resultado.personasActualizadas,
    perfilesNuevos: resultado.perfilesNuevos,
    sinEmail,
  };
}

// Se llama desde api/staff-list.js (la pestaña Staff, donde se ven los
// perfiles): si paso mas de una hora desde la ultima sincronizacion real,
// vuelve a leer la planilla antes de responder - mismo mecanismo que ya usa
// ensureFreshSync en lib/postulacionesSync.js para lograr el efecto de "una
// vez por hora" sin depender de un cron de Vercel.
async function ensureFreshDisponibilidadSync() {
  const redis = getRedis();
  let status = null;
  try {
    const raw = await redis.get(SYNC_STATUS_KEY);
    status = raw ? (typeof raw === 'object' ? raw : JSON.parse(raw)) : null;
  } catch (e) { /* si no se pudo leer el marcador, se vuelve a sincronizar */ }

  const isStale = !status || !status.ts || (Date.now() - status.ts) > SYNC_STALE_MS;
  if (!isStale) return { skipped: true, ...status };

  const resultado = await syncDisponibilidadFromSheet();
  const nuevoStatus = { ts: Date.now(), ...resultado };
  try { await redis.set(SYNC_STATUS_KEY, JSON.stringify(nuevoStatus)); } catch (e) { /* la proxima apertura vuelve a intentar */ }
  return { skipped: false, ...nuevoStatus };
}

module.exports = { syncDisponibilidadFromSheet, ensureFreshDisponibilidadSync };
