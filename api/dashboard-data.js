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

// Rango de comisiones NOT_STARTED a traer (ambas fechas fijas). Cuando quieras
// otro rango, pedile a Claude que las cambie.
const START_DATE_FROM = '2026-08-18';
const START_DATE_TO = '2027-03-01';
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

async function apiGet(base, path, key) {
  const resp = await fetch(base + path, { headers: { 'X-API-Key': key } });
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    return {};
  }
}

function todayISO() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: TZ }); // yyyy-MM-dd
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
  const from = START_DATE_FROM;
  const to = START_DATE_TO;
  const qs = `status=NOT_STARTED&startDateFrom=${from}&startDateTo=${to}&limit=100`;
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
  return all;
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
