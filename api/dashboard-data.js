// ============================================================================
// FUNCION SERVERLESS DE VERCEL
// ============================================================================
// Esto corre en los servidores de Vercel (no en el navegador de quien usa el
// tablero), asi que las claves de la API de Coderhouse nunca viajan al
// navegador de nadie. Las claves se configuran como "Environment Variables"
// en el panel de Vercel (Project Settings > Environment Variables), NUNCA
// escritas en este archivo:
//   BACKOFFICE_API_URL
//   CLAUDE_STUDENT_API_KEY
//   CLAUDE_FINANCE_API_KEY
//
// El archivo index.html (la pagina que ve la gente) llama a esta funcion
// haciendo fetch('/api/dashboard-data') y recibe el JSON con las comisiones.
// ============================================================================

// Rango de comisiones NOT_STARTED a traer: siempre "desde hoy" (se recalcula
// solo, cada vez que se consulta) hasta esta cantidad de meses hacia adelante.
// Si en el futuro queres cambiar el horizonte, pedile a Claude que cambie
// este numero.
const MONTHS_AHEAD = 4;
const DAYS_MAP = { 1: 'Lun', 2: 'Mar', 3: 'Mie', 4: 'Jue', 5: 'Vie', 6: 'Sab', 7: 'Dom' };
const TZ = 'America/Argentina/Buenos_Aires';

function getEnv() {
  const BASE = process.env.BACKOFFICE_API_URL;
  const STUDENT_KEY = process.env.CLAUDE_STUDENT_API_KEY;
  const FINANCE_KEY = process.env.CLAUDE_FINANCE_API_KEY;
  if (!BASE || !STUDENT_KEY || !FINANCE_KEY) {
    throw new Error('Faltan Environment Variables en Vercel (BACKOFFICE_API_URL / CLAUDE_STUDENT_API_KEY / CLAUDE_FINANCE_API_KEY). Configuralas en Project Settings > Environment Variables y volve a desplegar.');
  }
  return { BASE, STUDENT_KEY, FINANCE_KEY };
}

// Hace la consulta a la API de Coderhouse. Como se disparan muchas consultas
// en paralelo (una por curso, una por profesor/tutor, etc.), a veces alguna
// falla por una cuestion momentanea de red/carga. Por eso reintenta un par de
// veces antes de rendirse (asi evitamos que un curso aparezca con el ID en
// vez del nombre, o un profesor sin nombre, por una falla pasajera).
async function apiGet(base, path, key, retries) {
  const maxRetries = retries == null ? 2 : retries;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(base + path, { headers: { 'X-API-Key': key } });
      const text = await resp.text();
      if (resp.ok) {
        try {
          return JSON.parse(text);
        } catch (e) {
          // respuesta no era JSON valido, se trata como fallo y reintenta
        }
      }
    } catch (e) {
      // error de red, se reintenta
    }
    if (attempt < maxRetries) {
      await new Promise(r => setTimeout(r, 350 * (attempt + 1)));
    }
  }
  return {};
}

function todayISO() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: TZ }); // yyyy-MM-dd
}

// Devuelve la fecha de "hoy" (en horario Argentina) mas `months` meses,
// como texto yyyy-MM-dd. Si el mes resultante tiene menos dias que el dia de
// hoy (ej: hoy es 31 y el mes destino tiene 30), lo ajusta al ultimo dia de
// ese mes.
function addMonthsISO(months) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const p = {};
  parts.forEach(x => { p[x.type] = x.value; });
  let year = parseInt(p.year, 10);
  let month = parseInt(p.month, 10) - 1 + months; // 0-indexado
  const day = parseInt(p.day, 10);
  year += Math.floor(month / 12);
  month = ((month % 12) + 12) % 12;
  const lastDayOfTargetMonth = new Date(year, month + 1, 0).getDate();
  const safeDay = Math.min(day, lastDayOfTargetMonth);
  const mm = String(month + 1).padStart(2, '0');
  const dd = String(safeDay).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

function fmtDate(dateObj, opts) {
  return new Intl.DateTimeFormat('es-AR', { timeZone: TZ, ...opts }).format(dateObj);
}

function dateISO(dateObj) {
  return dateObj.toLocaleDateString('sv-SE', { timeZone: TZ });
}

function dateDMY(dateObj) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(dateObj);
  const p = {};
  parts.forEach(x => { p[x.type] = x.value; });
  return `${p.day}/${p.month}/${p.year}`;
}

function timeHM(dateObj) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(dateObj);
}

async function fetchAllCohorts(env) {
  const from = todayISO();
  const to = addMonthsISO(MONTHS_AHEAD);
  // OJO: no filtramos por status en la consulta. Coderhouse marca una comision
  // como IN_PROGRESS (deja de estar "NOT_STARTED") apenas se cierra la
  // inscripcion, que suele ser varios dias ANTES de que arranque la primera
  // clase. Si filtraramos por status=NOT_STARTED, las comisiones de la
  // semana mas proxima (que son justo las que hay que revisar con mas
  // urgencia si les falta staff) desaparecerian del tablero antes de tiempo.
  // Por eso traemos todo lo que arranca entre hoy y el horizonte, y despues
  // sacamos solo las CANCELLED / COMPLETED (esas si no corresponde mostrarlas).
  const qs = `startDateFrom=${from}&startDateTo=${to}&limit=100`;
  const first = await apiGet(env.BASE, `/student/enrollment/m2m/admin/cohorts?${qs}&page=1`, env.STUDENT_KEY);
  let all = (first.data || []).slice();
  const totalPages = Math.min((first.pagination && first.pagination.totalPages) || 1, 20);
  if (totalPages > 1) {
    const pagePromises = [];
    for (let p = 2; p <= totalPages; p++) {
      pagePromises.push(apiGet(env.BASE, `/student/enrollment/m2m/admin/cohorts?${qs}&page=${p}`, env.STUDENT_KEY));
    }
    const results = await Promise.all(pagePromises);
    results.forEach(d => { all = all.concat(d.data || []); });
  }
  return all.filter(c => c.status !== 'CANCELLED' && c.status !== 'COMPLETED');
}

async function fetchAllAssignments(env) {
  const first = await apiGet(env.BASE, '/platform/staff/m2m/admin/assignments?status=ACTIVE&page=1&limit=100', env.STUDENT_KEY);
  let all = (first.items || []).slice();
  const totalPages = first.totalPages || 1;
  if (totalPages > 1) {
    const pagePromises = [];
    for (let p = 2; p <= totalPages; p++) {
      pagePromises.push(apiGet(env.BASE, `/platform/staff/m2m/admin/assignments?status=ACTIVE&page=${p}&limit=100`, env.STUDENT_KEY));
    }
    const results = await Promise.all(pagePromises);
    results.forEach(d => { all = all.concat(d.items || []); });
  }
  return all;
}

async function fetchProducts(productIds, env) {
  const entries = await Promise.all(productIds.map(async pid => {
    try {
      const d = await apiGet(env.BASE, `/finance/product/m2m/products/${pid}`, env.FINANCE_KEY);
      let title = null;
      (d.localizations || []).forEach(loc => { if (loc.isDefault) title = loc.title; });
      if (!title && d.localizations && d.localizations.length) title = d.localizations[0].title;
      if (!title && d.program) title = d.program.name;
      return [pid, title || pid.substring(0, 8)];
    } catch (e) {
      return [pid, pid.substring(0, 8)];
    }
  }));
  return Object.fromEntries(entries);
}

async function fetchUsers(userIds, env) {
  const entries = await Promise.all(userIds.map(async uid => {
    try {
      const d = await apiGet(env.BASE, `/platform/user/m2m/admin/users/${uid}`, env.STUDENT_KEY);
      const fn = (d.firstName || '').trim();
      const ln = (d.lastName || '').trim();
      let name = `${fn} ${ln}`.trim();
      if (!name) {
        const email = d.email || '';
        name = email ? email.split('@')[0] : uid;
      }
      return [uid, name];
    } catch (e) {
      return [uid, String(uid).substring(0, 8)];
    }
  }));
  return Object.fromEntries(entries);
}

async function buildRows() {
  const env = getEnv();

  const cohorts = await fetchAllCohorts(env);
  const productIds = Array.from(new Set(cohorts.map(c => c.productId)));
  const products = await fetchProducts(productIds, env);

  // Sincroniza (si ya paso mas de una hora desde la ultima vez) las
  // postulaciones nuevas que hayan llegado a la planilla de Google Sheets
  // del sitio publico de postulaciones. Se hace aca, y no con un cron por
  // hora, porque el plan gratuito de Vercel no permite crons mas seguido
  // que una vez por dia - abrir esta pestaña (la que mas se abre) hace de
  // "gatillo" en su lugar. Si falla (Google Sheets caido, faltan las
  // Environment Variables, etc.) no debe romper el resto del tablero.
  try {
    const { ensureFreshSync } = require('../lib/postulacionesSync');
    await ensureFreshSync();
  } catch (e) { /* seguimos mostrando el resto del tablero igual, con las postulaciones que ya hubiera */ }

  // Cuantas postulaciones tiene cada comision, para mostrar el numerito en
  // la columna "Postulantes" sin tener que pedir el detalle completo (con
  // el cruce de rating/superposicion) de todas las comisiones de una.
  let postulantesCountByCohort = {};
  try {
    const { getAllPostulaciones } = require('../lib/overlay');
    const todasPostulaciones = await getAllPostulaciones();
    todasPostulaciones.forEach(p => {
      if (!p.cohortId) return;
      postulantesCountByCohort[p.cohortId] = (postulantesCountByCohort[p.cohortId] || 0) + 1;
    });
  } catch (e) { /* si Redis falla, seguimos mostrando el resto del tablero igual, sin el numerito */ }

  const assignments = await fetchAllAssignments(env);
  const cohortIds = new Set(cohorts.map(c => c.id));
  const relevant = assignments.filter(a => cohortIds.has(a.cohortId));
  const userIds = Array.from(new Set(relevant.map(a => a.userId)));
  const users = await fetchUsers(userIds, env);

  const byCohort = {};
  relevant.forEach(a => {
    if (!byCohort[a.cohortId]) byCohort[a.cohortId] = [];
    byCohort[a.cohortId].push(a);
  });

  const rows = cohorts.map(c => {
    const course = products[c.productId] || c.name;
    const startAR = c.startDate ? new Date(c.startDate) : null;
    const endAR = c.endDate ? new Date(c.endDate) : null;
    const horaInicio = startAR ? timeHM(startAR) : '';
    const horaFin = startAR ? timeHM(new Date(startAR.getTime() + 2 * 3600 * 1000)) : '';

    const staffList = byCohort[c.id] || [];
    const profs = staffList.filter(s => s.cohortRole === 'INSTRUCTOR' || s.cohortRole === 'PROFESOR');
    const tutors = staffList.filter(s => s.cohortRole === 'TUTOR');
    const profNames = profs.map(s => users[s.userId] || String(s.userId).substring(0, 8));

    return {
      cohortId: c.id,
      commission: c.commissionNumber,
      course: course,
      isB2B: !!c.isB2B,
      profesor1: profNames[0] || '',
      profesor2: profNames[1] || '',
      profCount: profNames.length,
      tutorCount: tutors.length,
      startDate: startAR ? dateDMY(startAR) : '',
      startDateISO: startAR ? dateISO(startAR) : '',
      endDate: endAR ? dateDMY(endAR) : '',
      days: (c.weekDays || []).slice().sort().map(d => DAYS_MAP[d] || '').join('/'),
      horaInicio: horaInicio,
      horaFin: horaFin,
      isSoldOut: !!c.isSoldOut,
      students: c.currentStudents || 0,
      maxStudents: c.maxStudents || 0,
      modalidad: { ONLINE: 'Online', ON_SITE: 'Presencial', HYBRID: 'Hibrido' }[c.modality] || c.modality || '',
      pais: c.country || '',
      postulantesCount: postulantesCountByCohort[c.id] || 0,
    };
  });

  rows.sort((a, b) => a.startDateISO.localeCompare(b.startDateISO));

  return {
    rows,
    lastUpdate: new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()).replace(',', ''),
  };
}

module.exports = async function handler(req, res) {
  try {
    const data = await buildRows();
    res.status(200).json(data);
  } catch (err) {
    res.status(200).json({ error: String(err && err.message ? err.message : err) });
  }
};
