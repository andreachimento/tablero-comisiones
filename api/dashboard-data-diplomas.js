// ============================================================================
// FUNCION SERVERLESS DE VERCEL: datos de la pestaña Diplomaturas
// ============================================================================
// Trae las diplomaturas (lo que en el Back Office esta en "Diplomaturas ->
// Comisiones", DIFERENTE de la lista de comisiones sueltas que ya usa la
// pestaña Comisiones). Cada diplomatura junta varios "modulos", y cada
// modulo tiene varias comisiones internas (una por materia), cada una con su
// propio profesor, fecha, dia y horario - por eso una fila de esta pestaña
// no es una sola comision, es un grupo de comisiones.
//
// El archivo index.html llama a esta funcion haciendo
// fetch('/api/dashboard-data-diplomas') y recibe el JSON con las diplomaturas.
// ============================================================================

const { DAYS_MAP, CLASS_DURATION_MS, dateDMY, timeHM } = require('../lib/elegibilidad');
const { getAllPostulaciones } = require('../lib/overlay');

const TZ = 'America/Argentina/Buenos_Aires';

function getEnv() {
  const BASE = process.env.BACKOFFICE_API_URL;
  const STUDENT_KEY = process.env.CLAUDE_STUDENT_API_KEY;
  const FINANCE_KEY = process.env.CLAUDE_FINANCE_API_KEY;
  if (!BASE || !STUDENT_KEY || !FINANCE_KEY) {
    throw new Error('Faltan Environment Variables en Vercel (BACKOFFICE_API_URL / CLAUDE_STUDENT_API_KEY / CLAUDE_FINANCE_API_KEY).');
  }
  return { BASE, STUDENT_KEY, FINANCE_KEY };
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

function dateISO(dateObj) {
  return dateObj.toLocaleDateString('sv-SE', { timeZone: TZ });
}

// El endpoint de diploma-commissions devuelve un array pelado (sin
// pagination.totalPages como el de /admin/cohorts) - se sabe que se llego al
// final cuando una pagina vuelve con menos items que el limite pedido.
async function fetchAllDiplomaCommissions(env) {
  let all = [];
  const limit = 100;
  for (let page = 1; page <= 20; page++) {
    const data = await apiGet(env.BASE, `/student/enrollment/m2m/diploma-commissions?page=${page}&limit=${limit}`, env.STUDENT_KEY);
    const items = Array.isArray(data) ? data : [];
    all = all.concat(items);
    if (items.length < limit) break;
  }
  return all.filter(d => d.status !== 'CANCELLED' && d.status !== 'COMPLETED');
}

async function fetchAllAssignments(env) {
  const first = await apiGet(env.BASE, '/platform/staff/m2m/admin/assignments?status=ACTIVE&page=1&limit=100', env.STUDENT_KEY);
  let all = (first && first.items) || [];
  const totalPages = (first && first.totalPages) || 1;
  if (totalPages > 1) {
    const pagePromises = [];
    for (let p = 2; p <= totalPages; p++) {
      pagePromises.push(apiGet(env.BASE, `/platform/staff/m2m/admin/assignments?status=ACTIVE&page=${p}&limit=100`, env.STUDENT_KEY));
    }
    const results = await Promise.all(pagePromises);
    results.forEach(d => { all = all.concat((d && d.items) || []); });
  }
  return all;
}

async function fetchProductTitles(productIds, env) {
  const entries = await Promise.all(productIds.map(async pid => {
    try {
      const d = await apiGet(env.BASE, `/finance/product/m2m/products/${pid}`, env.FINANCE_KEY);
      const locs = (d && d.localizations) || [];
      let title = null;
      locs.forEach(loc => { if (loc.isDefault) title = loc.title; });
      if (!title && locs.length) title = locs[0].title;
      return [pid, title || String(pid).substring(0, 8)];
    } catch (e) {
      return [pid, String(pid).substring(0, 8)];
    }
  }));
  return Object.fromEntries(entries);
}

async function fetchUsers(userIds, env) {
  const entries = await Promise.all(userIds.map(async uid => {
    try {
      const d = await apiGet(env.BASE, `/platform/user/m2m/admin/users/${uid}`, env.STUDENT_KEY);
      const fn = (d && d.firstName || '').trim();
      const ln = (d && d.lastName || '').trim();
      let name = `${fn} ${ln}`.trim();
      if (!name) {
        const email = (d && d.email) || '';
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
  const diplomas = await fetchAllDiplomaCommissions(env);

  // Postulantes reales (misma fuente que usa la pestaña Comisiones), para
  // poder mostrar el numerito por comision interna y el total por diplomatura.
  let postulantesCountByCohort = {};
  try {
    const todasPostulaciones = await getAllPostulaciones();
    todasPostulaciones.forEach(p => {
      if (!p.cohortId) return;
      postulantesCountByCohort[p.cohortId] = (postulantesCountByCohort[p.cohortId] || 0) + 1;
    });
  } catch (e) { /* si Redis falla, seguimos mostrando el resto igual, sin el numerito */ }

  // Titulo de cada diplomatura (ej. "Diplomatura en Data Science") y de cada
  // materia individual (ej. "Fundamentos de Programacion con Python para
  // Datos (diplomatura)") - dos listas de producto distintas, se resuelven
  // juntas en una sola tanda de pedidos.
  const diplomaProductIds = Array.from(new Set(diplomas.map(d => d.diplomaProductId).filter(Boolean)));
  const materiaProductIds = Array.from(new Set(
    diplomas.flatMap(d => (d.modules || []).flatMap(m => (m.cohortAssignments || []).map(ca => ca.productId))).filter(Boolean)
  ));
  const allProductIds = Array.from(new Set(diplomaProductIds.concat(materiaProductIds)));
  const productTitles = await fetchProductTitles(allProductIds, env);

  // Staff asignado a cada comision interna (misma fuente que usa la pestaña
  // Comisiones: TODAS las asignaciones activas de la plataforma, filtradas
  // despues por los cohortId que nos interesan).
  const allCohortIds = new Set(
    diplomas.flatMap(d => (d.modules || []).flatMap(m => (m.cohortAssignments || []).map(ca => ca.cohortId)))
  );
  const allAssignments = await fetchAllAssignments(env);
  const relevantAssignments = allAssignments.filter(a => allCohortIds.has(a.cohortId));
  const userIds = Array.from(new Set(relevantAssignments.map(a => a.userId)));
  const users = await fetchUsers(userIds, env);
  const assignmentsByCohort = {};
  relevantAssignments.forEach(a => {
    if (!assignmentsByCohort[a.cohortId]) assignmentsByCohort[a.cohortId] = [];
    assignmentsByCohort[a.cohortId].push(a);
  });

  const modalidadLabel = { ONLINE: 'Online', ON_SITE: 'Presencial', HYBRID: 'Hibrido' };

  const rows = diplomas.map(d => {
    let postulantesTotal = 0;
    let cohortCount = 0;

    const modules = (d.modules || []).map(m => {
      const cohorts = (m.cohortAssignments || []).map(ca => {
        cohortCount++;
        const startAR = ca.startDate ? new Date(ca.startDate) : null;
        const endAR = ca.endDate ? new Date(ca.endDate) : null;
        const staffList = assignmentsByCohort[ca.cohortId] || [];
        const profs = staffList.filter(s => s.cohortRole === 'INSTRUCTOR' || s.cohortRole === 'PROFESOR');
        const profNames = profs.map(s => users[s.userId] || String(s.userId).substring(0, 8));
        const postulantesCohort = postulantesCountByCohort[ca.cohortId] || 0;
        postulantesTotal += postulantesCohort;
        return {
          cohortId: ca.cohortId,
          commission: ca.commissionNumber,
          course: productTitles[ca.productId] || ca.name,
          profesor1: profNames[0] || '',
          profesor2: profNames[1] || '',
          days: (ca.weekDays || []).slice().sort().map(w => DAYS_MAP[w] || '').join('/'),
          horaInicio: startAR ? timeHM(startAR) : '',
          horaFin: startAR ? timeHM(new Date(startAR.getTime() + CLASS_DURATION_MS)) : '',
          startDate: startAR ? dateDMY(startAR) : '',
          endDate: endAR ? dateDMY(endAR) : '',
          students: ca.currentStudents || 0,
          maxStudents: ca.maxStudents || 0,
          status: ca.status || '',
          postulantesCount: postulantesCohort,
        };
      });
      return {
        sequence: m.moduleSequence,
        startDate: m.startDate ? dateDMY(new Date(m.startDate)) : '',
        endDate: m.endDate ? dateDMY(new Date(m.endDate)) : '',
        cohorts,
      };
    });

    const allStarts = modules.flatMap(m => m.cohorts.map(c => c.startDate)).concat(d.startDate ? [dateDMY(new Date(d.startDate))] : []);
    const startAR = d.startDate ? new Date(d.startDate) : null;
    const endAR = d.endDate ? new Date(d.endDate) : null;

    return {
      diplomaCommissionId: d.id,
      commission: d.commissionNumber,
      name: d.name,
      course: productTitles[d.diplomaProductId] || d.name,
      startDate: startAR ? dateDMY(startAR) : '',
      startDateISO: startAR ? dateISO(startAR) : '',
      endDate: endAR ? dateDMY(endAR) : '',
      modalidad: modalidadLabel[d.modality] || d.modality || '',
      pais: d.country || '',
      students: d.currentStudents || 0,
      maxStudents: d.maxStudents || 0,
      moduleCount: modules.length,
      cohortCount,
      postulantesCount: postulantesTotal,
      modules,
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
