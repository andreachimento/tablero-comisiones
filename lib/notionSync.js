// ============================================================================
// Integracion con la base de Notion "Tablero de seguimiento Académico de
// Perfiles" (CRM Relaciones Laborales) - migracion + sincronizacion de
// comentarios hacia el perfil de Staff.
// ============================================================================
// Necesita dos Environment Variables en Vercel:
//   NOTION_API_KEY      -> el "Internal Integration Secret" de una
//                          integracion interna creada en
//                          https://www.notion.so/my-integrations, COMPARTIDA
//                          con la base de datos "Tablero de seguimiento
//                          Académico de Perfiles" (Compartir -> Conexiones).
//   NOTION_DATABASE_ID  -> 13515000-c791-816d-8530-000bccafa46e (la base
//                          confirmada por Andrea). Se puede pasar con o sin
//                          guiones, se normaliza solo.
//
// Sin esas dos variables cargadas, todo lo de este archivo devuelve
// "no configurado" en vez de tirar error, para que el resto del perfil
// siga funcionando igual.
// ============================================================================

const NOTION_VERSION = '2022-06-28';

function getEnv() {
  const key = process.env.NOTION_API_KEY;
  const rawId = process.env.NOTION_DATABASE_ID || '13515000c791816d8530000bccafa46e';
  const databaseId = String(rawId).replace(/-/g, '');
  if (!key) return null;
  return { key, databaseId };
}

async function notionApi(path, env, method, body) {
  const resp = await fetch('https://api.notion.com/v1' + path, {
    method: method || 'GET',
    headers: {
      Authorization: 'Bearer ' + env.key,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  if (!resp.ok) {
    const msg = (json && json.message) || text || ('HTTP ' + resp.status);
    throw new Error('Notion API: ' + msg);
  }
  return json;
}

// ----------------------------------------------------------------------------
// Extraccion de propiedades de una pagina (tarjeta) de la base, tolerante a
// que cada propiedad venga como title/rich_text/url/select/multi_select/date
// - la base tiene entradas cargadas a mano de formas bien distintas.
// ----------------------------------------------------------------------------
function plainTextFromRichArray(arr) {
  return (arr || []).map(r => r.plain_text != null ? r.plain_text : (r.text && r.text.content) || '').join('');
}

function propToText(prop) {
  if (!prop) return '';
  switch (prop.type) {
    case 'title': return plainTextFromRichArray(prop.title);
    case 'rich_text': return plainTextFromRichArray(prop.rich_text);
    case 'url': return prop.url || '';
    case 'select': return (prop.select && prop.select.name) || '';
    case 'status': return (prop.status && prop.status.name) || '';
    case 'multi_select': return (prop.multi_select || []).map(o => o.name);
    case 'date': return (prop.date && prop.date.start) || null;
    default: return '';
  }
}

function extractProperties(page) {
  const p = page.properties || {};
  return {
    pageId: page.id,
    url: page.url,
    staffTitle: propToText(p['Staff (Nombre y Apellido - Mail)']),
    perfilDash: propToText(p['Perfil Dash']),
    rol: propToText(p['Rol']),
    estado: propToText(p['Estado']),
    motivos: propToText(p['Motivos']) || [],
    cursos: propToText(p['Cursos']) || [],
    comisiones: propToText(p['Comisiones']),
    fechaCreacion: propToText(p['Fecha de creación']),
    fechaBaja: propToText(p['Fecha de Baja']),
    cierreComision: propToText(p['Cierre de Comisión']),
  };
}

async function queryAllPages(env) {
  const pages = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const resp = await notionApi('/databases/' + env.databaseId + '/query', env, 'POST', body);
    (resp.results || []).forEach(pg => pages.push(extractProperties(pg)));
    cursor = resp.has_more ? resp.next_cursor : null;
  } while (cursor);
  return pages;
}

// ----------------------------------------------------------------------------
// Extraccion de mail: prioridad "Perfil Dash" (query ?email=..., o el mail
// directo en el path) y despues el titulo de la tarjeta (Staff). Nunca se
// adivina: si no aparece ningun mail en ningun lado, se descarta.
// ----------------------------------------------------------------------------
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function cleanEmail(e) {
  if (!e) return null;
  let s = e.trim().replace(/^[.,;:()<>[\]"']+|[.,;:()<>[\]"']+$/g, '');
  s = s.replace(/%40/gi, '@');
  return s.toLowerCase();
}

function emailsFromText(text) {
  if (!text) return [];
  let decoded;
  try { decoded = decodeURIComponent(text); } catch (e) { decoded = text; }
  const found = decoded.match(EMAIL_RE) || [];
  const out = [];
  found.forEach(f => {
    const c = cleanEmail(f);
    if (c && !out.includes(c)) out.push(c);
  });
  return out;
}

function emailsFromPerfilDash(url) {
  if (!url) return [];
  let clean = url.trim().replace(/^#\s*/, '');
  const candidates = [];
  try {
    const parsed = new URL(clean);
    const qEmail = parsed.searchParams.get('email');
    if (qEmail) {
      const c = cleanEmail(decodeURIComponent(qEmail));
      if (c) candidates.push(c);
    }
  } catch (e) { /* no era una URL valida, seguimos con el regex de abajo */ }
  emailsFromText(clean).forEach(e => { if (!candidates.includes(e)) candidates.push(e); });
  return candidates;
}

function personKeyLocal(email) {
  const norm = String(email || '').toLowerCase().trim();
  const at = norm.indexOf('@');
  if (at === -1) return norm;
  const domain = norm.slice(at);
  let local = norm.slice(0, at);
  const plus = local.indexOf('+');
  if (plus !== -1) local = local.slice(0, plus);
  return local + domain;
}

// Devuelve { finalEmail, source: 'PerfilDash'|'Staff'|null, conflict: bool }
function detectEmail(card) {
  const pdEmails = emailsFromPerfilDash(card.perfilDash);
  const staffEmails = emailsFromText(card.staffTitle);
  let finalEmail = null;
  let source = null;
  if (pdEmails.length) { finalEmail = pdEmails[0]; source = 'PerfilDash'; }
  else if (staffEmails.length) { finalEmail = staffEmails[0]; source = 'Staff'; }
  let conflict = false;
  if (pdEmails.length && staffEmails.length) {
    const same = pdEmails.some(a => staffEmails.some(b => a === b));
    if (!same) conflict = true;
  }
  return { finalEmail, source, conflict, pdEmails, staffEmails };
}

// ----------------------------------------------------------------------------
// Cuerpo de la tarjeta -> entradas fechadas. El equipo viene marcando cada
// fecha como un run de texto en NEGRITA + SUBRAYADO (ej. "12/11/2024"): eso
// es lo que se usa como separador entre comentarios dentro de una misma
// tarjeta, para poder subir cada uno por separado tal como pidio Andrea. Si
// no se encuentra ningun marcador de fecha pero la tarjeta tiene contenido,
// se sube como UNA sola entrada sin fecha propia (se completa despues con la
// fecha de la propiedad mas relevante de la tarjeta).
// ----------------------------------------------------------------------------
const DATE_MARKER_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/;

function isDateMarkerRun(run) {
  const ann = run.annotations || {};
  if (!ann.bold || !ann.underline) return false;
  const t = (run.plain_text || '').trim();
  return DATE_MARKER_RE.test(t);
}

function normalizeDateDMY(t) {
  const m = t.trim().match(DATE_MARKER_RE);
  if (!m) return null;
  let [, d, mo, y] = m;
  if (y.length === 2) y = '20' + y;
  return y + '-' + mo.padStart(2, '0') + '-' + d.padStart(2, '0');
}

async function getAllBlocks(pageId, env) {
  const blocks = [];
  let cursor;
  do {
    const qs = cursor ? ('?start_cursor=' + cursor + '&page_size=100') : '?page_size=100';
    const resp = await notionApi('/blocks/' + pageId + '/children' + qs, env, 'GET');
    (resp.results || []).forEach(b => blocks.push(b));
    cursor = resp.has_more ? resp.next_cursor : null;
  } while (cursor);
  return blocks;
}

function blockRichText(block) {
  const data = block[block.type] || {};
  return data.rich_text || [];
}

// blocks: resultado de getAllBlocks(). Devuelve [{ fecha: 'YYYY-MM-DD'|null, texto: '...' }]
function splitDatedEntries(blocks) {
  const entries = [];
  let current = { fecha: null, parts: [] };
  let sawAnyMarker = false;

  function pushCurrentIfAny() {
    const texto = current.parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (texto) entries.push({ fecha: current.fecha, texto });
  }

  blocks.forEach(block => {
    const runs = blockRichText(block);
    if (!runs.length) {
      // bloque sin texto propio (imagen, divider, bloque vacio): si es un
      // bloque de texto vacio lo saltamos; no corta una entrada en curso.
      return;
    }
    // Buscamos si ESTE bloque arranca con un marcador de fecha (lo normal:
    // el bloque completo es "**12/11/2024**" o similar, a veces con mas
    // texto pegado despues del marcador en el mismo bloque).
    let idx = 0;
    let markerHere = null;
    if (isDateMarkerRun(runs[0])) {
      markerHere = normalizeDateDMY(runs[0].plain_text);
      idx = 1;
    }
    if (markerHere) {
      pushCurrentIfAny();
      sawAnyMarker = true;
      current = { fecha: markerHere, parts: [] };
    }
    const restText = runs.slice(idx).map(r => r.plain_text || '').join('');
    const prefix = block.type === 'bulleted_list_item' || block.type === 'numbered_list_item' ? '- ' : '';
    if (restText.trim()) current.parts.push(prefix + restText.trim());
  });
  pushCurrentIfAny();

  return { entries, hadDateMarkers: sawAnyMarker };
}

// ----------------------------------------------------------------------------
// Comentarios NATIVOS de Notion: el panel de charla/discusion de la pagina
// (el icono de comentario arriba a la derecha), DISTINTO del cuerpo de la
// tarjeta. Pedido de Andrea (set. 2026): traer tambien lo que se escribe ahi,
// no solo lo que se escribe en el cuerpo.
//
// Requiere que la integracion de Notion ("Tablero asignaciones") tenga
// habilitada la capacidad "Read comments" (notion.so/my-integrations ->
// la integracion -> pestaña Capacidades). Si no esta habilitada, o falla
// por lo que sea, esta funcion NUNCA corta la importacion: devuelve lista
// vacia para esa tarjeta y se sigue solo con lo del cuerpo, como antes.
// ----------------------------------------------------------------------------
async function getAllPageComments(pageId, env) {
  const comments = [];
  let cursor;
  do {
    const qs = '?block_id=' + pageId + '&page_size=100' + (cursor ? ('&start_cursor=' + cursor) : '');
    const resp = await notionApi('/comments' + qs, env, 'GET');
    (resp.results || []).forEach(c => comments.push(c));
    cursor = resp.has_more ? resp.next_cursor : null;
  } while (cursor);
  return comments;
}

// Nombre de quien escribio el comentario en Notion. Se cachea (el mismo
// puñado de personas del equipo escribe la mayoria de los comentarios) para
// no pedirlo de nuevo en cada tarjeta. Si la integracion no tiene permiso
// para leer usuarios (capacidad aparte de "Read comments"), o falla,
// devuelve null - el comentario se sigue subiendo, solo que sin el nombre
// antepuesto.
async function resolveUserName(userId, env, cache) {
  if (!userId) return null;
  if (cache.has(userId)) return cache.get(userId);
  let name = null;
  try {
    const user = await notionApi('/users/' + userId, env, 'GET');
    name = (user && (user.name || (user.person && user.person.email))) || null;
  } catch (e) { name = null; }
  cache.set(userId, name);
  return name;
}

// Convierte los comentarios nativos de UNA tarjeta al mismo formato
// {fecha, texto} que splitDatedEntries() (para que se procesen exactamente
// igual: mismo dedup por id estable, mismo orden). fecha queda en
// 'YYYY-MM-DD' (se recorta la hora - no hace falta tanta precision). Si se
// pudo identificar el autor, se lo antepone al texto entre corchetes (NUNCA
// se pierde el dato de quien lo escribio, ni se parafrasea el contenido) -
// si no se pudo, el texto queda solo, igual que las entradas migradas del
// cuerpo (que tampoco tienen autor real).
async function getCommentEntries(pageId, env, nameCache) {
  let raw = [];
  try { raw = await getAllPageComments(pageId, env); } catch (e) { return []; }
  const out = [];
  for (const c of raw) {
    const texto = plainTextFromRichArray(c.rich_text).trim();
    if (!texto) continue;
    const userId = c.created_by && c.created_by.id;
    const nombre = await resolveUserName(userId, env, nameCache);
    out.push({
      fecha: c.created_time ? c.created_time.slice(0, 10) : null,
      texto: nombre ? ('[' + nombre + '] ' + texto) : texto,
    });
  }
  return out;
}

// ----------------------------------------------------------------------------
// Comentario "resumen de propiedades": SIEMPRE se genera uno por tarjeta
// (ademas de las entradas fechadas del cuerpo, si las hay), porque en la
// mayoria de las tarjetas viejas TODA la informacion del caso esta en estas
// propiedades (Estado + Motivos) y el cuerpo esta vacio. No es una
// interpretacion ni un resumen "libre": son los mismos valores cargados en
// Notion, solo puestos en una linea de texto.
// ----------------------------------------------------------------------------
function bestDate(card) {
  return card.fechaBaja || card.cierreComision || card.fechaCreacion || null;
}

function buildSummaryComment(card) {
  const parts = [];
  if (card.estado) parts.push('Estado: ' + card.estado);
  const motivos = Array.isArray(card.motivos) ? card.motivos : (card.motivos ? [card.motivos] : []);
  if (motivos.length) parts.push('Motivo(s): ' + motivos.join(', '));
  const cursos = Array.isArray(card.cursos) ? card.cursos : (card.cursos ? [card.cursos] : []);
  if (cursos.length) parts.push('Curso: ' + cursos.join(', ') + (card.comisiones ? (' (Comisión ' + card.comisiones + ')') : ''));
  if (card.rol) parts.push('Rol: ' + card.rol);
  if (!parts.length) return null;
  return '[Resumen de propiedades de Notion] ' + parts.join(' · ');
}

module.exports = {
  getEnv, notionApi, queryAllPages, extractProperties,
  emailsFromPerfilDash, emailsFromText, detectEmail, personKeyLocal,
  getAllBlocks, splitDatedEntries, buildSummaryComment, bestDate,
  getAllPageComments, resolveUserName, getCommentEntries,
};
