// ============================================================================
// Sincroniza las postulaciones que llegan del formulario publico
// (postulaciones.coderhouse.com) y caen en una planilla de Google Sheets,
// hacia la base propia del tablero (Redis), para que se vean reflejadas en
// el perfil de cada persona y en cada comision.
//
// Como llegan los datos de la planilla: Andrea eligio que sea Claude quien
// lee la planilla (ya tiene acceso a traves de Google Drive) y se la manda
// al tablero una vez por hora, en vez de que el propio tablero se conecte
// solo a Google (esa segunda forma tambien esta soportada mas abajo, por si
// en algun momento se prefiere pasar a esa - ver getSheetEnv/getSheetValues
// - pero hoy no se esta usando).
// api/postulaciones-sync.js recibe eso por POST y llama a
// syncPostulacionesFromSheet() pasandole los datos ya leidos.
//
// Que hace, paso a paso:
//   1. Recibe las filas de la planilla (como texto markdown, o ya separadas
//      en filas - ver parseMarkdownTable/normalizeRowsInput).
//   2. Por cada fila, busca a que comision real del back office corresponde
//      el "N° Comision" que puso la persona, para sacar el cohortId y el
//      nombre "oficial" del curso (asi coincide con como esta guardado en
//      "Cursos habilitados" de cada perfil, en vez de usar el texto libre
//      que haya en la planilla).
//   3. Si la misma persona aparece varias veces postulada a la MISMA
//      comision (ej. mando el formulario dos veces sin querer), se queda
//      solo con la mas reciente.
//   4. Guarda todo con lib/overlay.js -> upsertPostulacionesFromSheet(), que
//      no pisa el estado (pendiente/aprobada/rechazada) de una postulacion
//      que Andrea ya haya revisado desde el tablero.
//
// El "Rol" (Profesor / Tutor Adjunto) NO se guarda aca: el formulario
// publico no lo pregunta. Se completa mas adelante, al mostrarlo en el
// perfil o en la comision, con el rol que la persona ya tenga cargado para
// ese mismo curso (si tiene) - ver api/staff-profile.js y
// api/comision-postulantes.js.
// ============================================================================

const crypto = require('crypto');
const { personKey, upsertPostulacionesFromSheet } = require('./overlay');
const { getRedis } = require('./redis');

// Marca en Redis cuando fue la ultima vez que se sincronizo de verdad contra
// la planilla, para poder hacerlo "solo" cuando alguien abre el tablero (ver
// ensureFreshSync mas abajo) sin tener que llamar a Google en CADA apertura.
const SYNC_STATUS_KEY = 'postulaciones:sync-status';
const SYNC_STALE_MS = 55 * 60 * 1000; // un poco menos de 1 hora, con margen

function getBackofficeEnv() {
  const BASE = process.env.BACKOFFICE_API_URL;
  const STUDENT_KEY = process.env.CLAUDE_STUDENT_API_KEY;
  const FINANCE_KEY = process.env.CLAUDE_FINANCE_API_KEY;
  if (!BASE || !STUDENT_KEY || !FINANCE_KEY) {
    throw new Error('Faltan Environment Variables en Vercel (BACKOFFICE_API_URL / CLAUDE_STUDENT_API_KEY / CLAUDE_FINANCE_API_KEY).');
  }
  return { BASE, STUDENT_KEY, FINANCE_KEY };
}

// El ID y el gid de la planilla no son datos secretos (son parte de la URL
// que cualquiera con el enlace ya puede ver), asi que se dejan como
// respaldo fijo aca adentro - asi esto funciona sin tener que cargar
// Environment Variables en Vercel. Si en algun momento cambia la planilla,
// alcanza con cargar GOOGLE_SHEET_ID / GOOGLE_SHEET_GID en Vercel para
// pisar estos valores por defecto, sin tocar el codigo.
function getSheetEnv() {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID || '19nP64oDQIqG57nj1dPaYHJyLrOoUzk2fkkLYAthCoVs';
  const gid = process.env.GOOGLE_SHEET_GID || '1850372057';
  return { spreadsheetId, gid };
}

// Parser de CSV simple (soporta campos entre comillas con comas, saltos de
// linea y comillas escapadas como "" - lo minimo que hace falta para leer
// lo que exporta Google Sheets, sin agregar una dependencia nueva).
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

// Lee la planilla directo desde el enlace publico de exportacion de Google
// Sheets (funciona porque la planilla esta compartida como "Cualquiera con
// el enlace puede ver" - sin esto, Google devuelve una pagina de login en
// vez del CSV). No necesita ninguna credencial ni cuenta de servicio.
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

function addMonthsISO(months, TZ) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const p = {};
  parts.forEach(x => { p[x.type] = x.value; });
  let year = parseInt(p.year, 10);
  let month = parseInt(p.month, 10) - 1 + months;
  const day = parseInt(p.day, 10);
  year += Math.floor(month / 12);
  month = ((month % 12) + 12) % 12;
  const lastDayOfTargetMonth = new Date(year, month + 1, 0).getDate();
  const safeDay = Math.min(day, lastDayOfTargetMonth);
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(safeDay).padStart(2, '0')}`;
}

// Todas las comisiones cuya fecha de inicio cae en una ventana amplia
// (bastante para atras, para las postulaciones a comisiones que ya
// arrancaron, y bastante para adelante) - es la misma logica que usa
// api/dashboard-data.js, con una ventana mas amplia porque las postulaciones
// pueden llegar en cualquier momento.
async function fetchCohortsWindow(env) {
  const TZ = 'America/Argentina/Buenos_Aires';
  const from = addMonthsISO(-6, TZ);
  const to = addMonthsISO(12, TZ);
  const qs = `startDateFrom=${from}&startDateTo=${to}&limit=100`;
  const first = await apiGet(env.BASE, `/student/enrollment/m2m/admin/cohorts?${qs}&page=1`, env.STUDENT_KEY);
  if (!first) return [];
  let all = (first.data || []).slice();
  const totalPages = Math.min((first.pagination && first.pagination.totalPages) || 1, 20);
  if (totalPages > 1) {
    const proms = [];
    for (let p = 2; p <= totalPages; p++) {
      proms.push(apiGet(env.BASE, `/student/enrollment/m2m/admin/cohorts?${qs}&page=${p}`, env.STUDENT_KEY));
    }
    (await Promise.all(proms)).forEach(d => { if (d) all = all.concat(d.data || []); });
  }
  return all;
}

async function fetchProductTitles(productIds, env) {
  const entries = await Promise.all(productIds.map(async pid => {
    try {
      const d = await apiGet(env.BASE, `/finance/product/m2m/products/${pid}`, env.FINANCE_KEY);
      let title = null;
      ((d && d.localizations) || []).forEach(loc => { if (loc.isDefault) title = loc.title; });
      if (!title && d && d.localizations && d.localizations.length) title = d.localizations[0].title;
      if (!title && d && d.program) title = d.program.name;
      return [pid, title || null];
    } catch (e) {
      return [pid, null];
    }
  }));
  return Object.fromEntries(entries);
}

// Cuando Claude lee la planilla por Google Drive, la devuelve como una
// tabla en formato markdown (una fila en blanco, la fila de guiones que
// separa el encabezado, y despues una fila por linea, con las celdas
// separadas por "|"). Esta funcion la convierte en la misma matriz de
// filas/columnas que se usaria si se leyera directo con la API de Google
// Sheets, para que el resto del codigo no tenga que saber de donde vino.
function parseMarkdownTable(markdown) {
  const lines = String(markdown || '').split('\n').map(l => l.trim()).filter(l => l.startsWith('|'));
  const isSeparator = l => /^\|(\s*:?-{2,}:?\s*\|)+$/.test(l);
  const rows = lines.filter(l => !isSeparator(l)).map(l => {
    const raw = l.replace(/^\|/, '').replace(/\|$/, '').split('|');
    return raw.map(cell => cell.trim()
      // Al convertir a markdown, algunos caracteres especiales (sobre todo
      // el guion bajo, muy comun en mails) quedan "escapados" con una barra
      // invertida adelante (ej. "fran\_obholz@..."). Se saca esa barra para
      // recuperar el texto original.
      .replace(/\\([_*[\]()#+\-.!`~])/g, '$1'));
  });
  return rows;
}

// Acepta lo que haya llegado como datos de la planilla, sea cual sea la
// forma: ya una matriz de filas, o el texto markdown crudo que devuelve
// Google Drive al leer el archivo.
function normalizeRowsInput(input) {
  if (Array.isArray(input)) return input;
  if (typeof input === 'string' && input.trim()) return parseMarkdownTable(input);
  return null;
}

// Busca la columna cuyo encabezado contiene alguna de las palabras clave
// dadas (sin importar mayusculas/tildes), en vez de una posicion fija - asi
// no se rompe si en algun momento se agrega o reordena una columna.
function findCol(headers, keywords) {
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const idx = headers.findIndex(h => keywords.some(k => norm(h).includes(k)));
  return idx;
}

// El Timestamp de Google Forms llega como "25/06/2026 1:29:50" (dia/mes/año
// hora, siempre en la zona horaria de quien armo el formulario - en este
// caso Argentina). Se arma a mano en vez de confiar en new Date(texto)
// porque ese formato es ambiguo para JavaScript (lo puede confundir con
// mes/dia/año).
function parseSheetTimestamp(raw) {
  const m = String(raw || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [, dd, mm, yyyy, hh, min, sec] = m;
  const iso = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T${hh.padStart(2, '0')}:${min}:${sec || '00'}-03:00`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function makeId(email, comisionNumber) {
  const raw = personKey(email) + '|' + comisionNumber;
  return 'sheet-' + crypto.createHash('md5').update(raw).digest('hex').slice(0, 16);
}

// `datosPlanilla` es opcional: puede ser la matriz de filas ya lista, el
// texto markdown crudo (lo que manda Claude por api/postulaciones-sync.js),
// o nada - en ese ultimo caso se intenta leer la planilla directo desde
// Google Sheets (necesita las Environment Variables GOOGLE_SHEET_ID /
// GOOGLE_SHEET_GID / GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_KEY
// - ver lib/googleSheet.js), que hoy Andrea no tiene configuradas.
async function syncPostulacionesFromSheet(datosPlanilla) {
  const env = getBackofficeEnv();

  let rows = normalizeRowsInput(datosPlanilla);
  if (!rows) {
    const sheetEnv = getSheetEnv();
    try {
      // Camino principal: leer el CSV publico de la planilla (no necesita
      // ninguna credencial, solo que este compartida como "Cualquiera con
      // el enlace puede ver").
      rows = await fetchPublicSheetRows(sheetEnv.spreadsheetId, sheetEnv.gid);
    } catch (publicErr) {
      // Respaldo: si en algun momento se configura una cuenta de servicio
      // de Google (GOOGLE_SERVICE_ACCOUNT_*), se intenta por ese camino
      // antes de darse por vencido.
      try {
        const { getSheetValues } = require('./googleSheet');
        rows = await getSheetValues(sheetEnv.spreadsheetId, sheetEnv.gid);
      } catch (saErr) {
        throw new Error('No se pudo leer la planilla (enlace publico: ' + publicErr.message + ')');
      }
    }
  }
  if (!rows.length) return { ok: true, leidas: 0, procesadas: 0, nuevas: 0, actualizadas: 0, sinComision: 0 };

  // El encabezado real puede no estar en la primera fila (hay una fila en
  // blanco antes en esta planilla) - se busca la fila que tenga "timestamp"
  // como para no depender de un numero de fila fijo.
  const headerRowIdx = rows.findIndex(r => (r || []).some(c => String(c || '').toLowerCase().trim() === 'timestamp'));
  if (headerRowIdx === -1) throw new Error('No se encontro la fila de encabezados (columna "Timestamp") en la planilla.');
  const headers = rows[headerRowIdx];
  const dataRows = rows.slice(headerRowIdx + 1);

  const col = {
    timestamp: findCol(headers, ['timestamp']),
    nombre: findCol(headers, ['nombre']),
    email: findCol(headers, ['mail']),
    telefono: findCol(headers, ['telefono', 'whatsapp']),
    linkedin: findCol(headers, ['linkedin']),
    comentarios: findCol(headers, ['coment', 'motivo', 'experiencia']),
    curso: findCol(headers, ['curso']),
    comision: findCol(headers, ['comision']),
  };
  if (col.email === -1 || col.comision === -1) {
    throw new Error('No se encontraron las columnas de Email y/o N° Comision en la planilla (revisar encabezados).');
  }

  // 1) Parseo crudo de cada fila.
  const crudas = dataRows.map(r => {
    const email = String((r[col.email] || '')).trim().toLowerCase();
    const comisionRaw = r[col.comision];
    const comisionNumber = comisionRaw != null ? parseInt(String(comisionRaw).replace(/[^\d]/g, ''), 10) : NaN;
    if (!email || !comisionNumber || isNaN(comisionNumber)) return null;
    return {
      email,
      nombre: col.nombre !== -1 ? String(r[col.nombre] || '').trim() : '',
      telefono: col.telefono !== -1 ? String(r[col.telefono] || '').trim() : '',
      linkedin: col.linkedin !== -1 ? String(r[col.linkedin] || '').trim() : '',
      comentarios: col.comentarios !== -1 ? String(r[col.comentarios] || '').trim() : '',
      cursoTexto: col.curso !== -1 ? String(r[col.curso] || '').trim() : '',
      comisionNumber,
      fecha: (col.timestamp !== -1 && parseSheetTimestamp(r[col.timestamp])) || new Date(0).toISOString(),
    };
  }).filter(Boolean);

  // 2) Si la misma persona se postulo varias veces a la MISMA comision, nos
  // quedamos con la mas reciente (evita duplicados por un doble-click en el
  // formulario).
  const porClave = new Map();
  crudas.forEach(c => {
    const clave = personKey(c.email) + '|' + c.comisionNumber;
    const previa = porClave.get(clave);
    if (!previa || c.fecha > previa.fecha) porClave.set(clave, c);
  });
  const unicas = Array.from(porClave.values());

  // 3) Resolver cada N° Comision contra el back office real, para sacar el
  // cohortId y el nombre oficial del curso.
  const cohorts = await fetchCohortsWindow(env);
  const cohortByNumber = {};
  cohorts.forEach(c => { if (c.commissionNumber != null) cohortByNumber[c.commissionNumber] = c; });
  const productIds = Array.from(new Set(cohorts.map(c => c.productId).filter(Boolean)));
  const productTitle = await fetchProductTitles(productIds, env);

  let sinComision = 0;
  const entries = unicas.map(u => {
    const cohort = cohortByNumber[u.comisionNumber];
    if (!cohort) {
      sinComision++;
      return {
        id: makeId(u.email, u.comisionNumber),
        source: 'sheet',
        email: u.email,
        nombre: u.nombre,
        telefono: u.telefono,
        linkedin: u.linkedin,
        comentarios: u.comentarios,
        cohortId: null,
        comisionNumber: u.comisionNumber,
        curso: u.cursoTexto || null,
        rol: null,
        fecha: u.fecha,
      };
    }
    return {
      id: makeId(u.email, u.comisionNumber),
      source: 'sheet',
      email: u.email,
      nombre: u.nombre,
      telefono: u.telefono,
      linkedin: u.linkedin,
      comentarios: u.comentarios,
      cohortId: cohort.id,
      comisionNumber: u.comisionNumber,
      curso: productTitle[cohort.productId] || cohort.name || u.cursoTexto || null,
      rol: null,
      fecha: u.fecha,
    };
  });

  const resultado = await upsertPostulacionesFromSheet(entries);
  return {
    ok: true,
    leidas: dataRows.length,
    procesadas: entries.length,
    nuevas: resultado.nuevas,
    actualizadas: resultado.actualizadas,
    sinComision,
  };
}

// El tablero ya sabe leer la planilla solo (por el enlace publico, sin
// credenciales - ver fetchPublicSheetRows), asi que esto siempre esta
// "configurado". Se deja la funcion (en vez de sacarla) por si en el
// futuro se quiere volver a exigir que se configure algo antes de intentar
// sincronizar.
function sheetEnvConfigured() {
  return true;
}

// Se llama desde api/dashboard-data.js (la pestaña que mas se abre): si el
// tablero esta configurado para leer la planilla el mismo (ver arriba),
// chequea "hace cuanto fue la ultima sincronizada de verdad" y vuelve a
// sincronizar solo si paso mas de una hora - asi se logra el efecto de "una
// vez por hora" sin necesitar un cron de Vercel (que en el plan gratuito no
// puede correr mas seguido que una vez por dia).
async function ensureFreshSync() {
  if (!sheetEnvConfigured()) return { skipped: true, reason: 'sheet-env-not-configured' };
  const redis = getRedis();
  let status = null;
  try {
    const raw = await redis.get(SYNC_STATUS_KEY);
    status = raw ? (typeof raw === 'object' ? raw : JSON.parse(raw)) : null;
  } catch (e) { /* si no se pudo leer el marcador, directamente se vuelve a sincronizar */ }

  const isStale = !status || !status.ts || (Date.now() - status.ts) > SYNC_STALE_MS;
  if (!isStale) return { skipped: true, ...status };

  const resultado = await syncPostulacionesFromSheet();
  const nuevoStatus = { ts: Date.now(), ...resultado };
  try { await redis.set(SYNC_STATUS_KEY, JSON.stringify(nuevoStatus)); } catch (e) { /* si no se pudo guardar el marcador, la proxima apertura vuelve a intentar sincronizar - no rompe nada */ }
  return { skipped: false, ...nuevoStatus };
}

module.exports = { syncPostulacionesFromSheet, ensureFreshSync, parseMarkdownTable };
