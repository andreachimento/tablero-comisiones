// ============================================================================
// FUNCION SERVERLESS: postulantes de UNA comision, con el cruce de datos
// ============================================================================
// La usa la pestaña Comisiones cuando se hace click en una fila para
// desplegarla: devuelve la lista de gente que se postulo a esa comision
// puntual, junto con el dato que Andrea pidio: si esa persona SE PUEDE SUMAR
// o no (rojo/naranja/verde - reglas en lib/elegibilidad.js), mas un resumen
// abreviado de sus asignaciones para el tooltip al pasar el mouse sobre el
// nombre.
// ============================================================================

const { getOverlay, personKey, getAllPostulaciones, getAccountsForPerson } = require('../lib/overlay');
const { DAYS_MAP, ROLE_LABEL, CLASS_DURATION_MS, dateDMY, timeHM, minutesOfDay, classifyOverlap, computeColorReason } = require('../lib/elegibilidad');
const { getPostHogRatings } = require('../lib/posthog');

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

// Todas las asignaciones (cualquier fecha) de UNA cuenta puntual.
async function fetchAssignmentsForAccount(env, userId) {
  const first = await apiGet(env.BASE, `/platform/staff/m2m/admin/assignments?userId=${userId}&page=1&limit=100`, env.STUDENT_KEY);
  if (!first) return [];
  let assignments = (first.items || []).slice();
  const totalPages = Math.min(first.totalPages || 1, 20);
  if (totalPages > 1) {
    const proms = [];
    for (let p = 2; p <= totalPages; p++) {
      proms.push(apiGet(env.BASE, `/platform/staff/m2m/admin/assignments?userId=${userId}&page=${p}&limit=100`, env.STUDENT_KEY));
    }
    (await Promise.all(proms)).forEach(d => { if (d) assignments = assignments.concat(d.items || []); });
  }
  return assignments;
}

// Trae, para una persona (sus cuentas ya resueltas), sus asignaciones
// vigentes (asignada/en_curso) en comisiones DISTINTAS a `excludeCohortId`,
// con toda la info que hace falta para el cruce de horarios y el tooltip.
// De paso devuelve TAMBIEN los numeros de TODAS sus comisiones (incluidas
// las finalizadas) - no hace falta pedir nada extra, ya se bajaron al
// buscar las asignaciones - para poder cruzarlas con el rating real de
// PostHog (que puede tener respuestas de comisiones ya terminadas).
async function fetchVigentes(env, accounts, excludeCohortId) {
  const assignmentsByAccount = await Promise.all(accounts.map(a => fetchAssignmentsForAccount(env, a.id)));
  let assignments = assignmentsByAccount.flat().filter(a => a.status !== 'CANCELLED' && a.cohortId !== excludeCohortId);
  const cohortIds = Array.from(new Set(assignments.map(a => a.cohortId).filter(Boolean)));
  const cohorts = await Promise.all(cohortIds.map(id => apiGet(env.BASE, `/student/enrollment/m2m/admin/cohorts/${id}`, env.STUDENT_KEY)));
  const cohortById = {};
  cohorts.forEach(c => { if (c && c.id) cohortById[c.id] = c; });

  const productIds = Array.from(new Set(Object.values(cohortById).map(c => c.productId).filter(Boolean)));
  const productEntries = await Promise.all(productIds.map(async pid => {
    try {
      const d = await apiGet(env.BASE, `/finance/product/m2m/products/${pid}`, env.FINANCE_KEY);
      let title = null;
      (d && d.localizations || []).forEach(loc => { if (loc.isDefault) title = loc.title; });
      if (!title && d && d.localizations && d.localizations.length) title = d.localizations[0].title;
      if (!title && d && d.program) title = d.program.name;
      return [pid, title || pid.substring(0, 8)];
    } catch (e) {
      return [pid, pid.substring(0, 8)];
    }
  }));
  const productTitle = Object.fromEntries(productEntries);

  const now = new Date();
  const allCommissionNumbers = [];
  const vigentes = assignments.map(a => {
    const c = cohortById[a.cohortId];
    if (!c || c.status === 'CANCELLED') return null;
    if (c.commissionNumber != null) allCommissionNumbers.push(c.commissionNumber);

    const startAR = c.startDate ? new Date(c.startDate) : null;
    const endAR = c.endDate ? new Date(c.endDate) : null;
    let estadoComision;
    if (endAR) estadoComision = endAR < now ? 'finalizada' : (startAR && startAR > now ? 'asignada' : 'en_curso');
    else if (startAR) estadoComision = startAR > now ? 'asignada' : 'en_curso';
    else estadoComision = c.status === 'IN_PROGRESS' ? 'en_curso' : (c.status === 'COMPLETED' ? 'finalizada' : 'asignada');
    if (estadoComision === 'finalizada') return null; // no interesa para superposicion ni para el tooltip

    const startMin = startAR ? minutesOfDay(startAR) : 0;
    return {
      cohortId: c.id,
      curso: productTitle[c.productId] || c.name,
      comisionNumber: c.commissionNumber,
      rol: ROLE_LABEL[a.cohortRole] || a.cohortRole || '',
      dia: (c.weekDays || []).slice().sort().map(d => DAYS_MAP[d] || '').join('/'),
      horaInicio: startAR ? timeHM(startAR) : '',
      horaFin: startAR ? timeHM(new Date(startAR.getTime() + CLASS_DURATION_MS)) : '',
      fechaInicio: startAR ? dateDMY(startAR) : '',
      fechaFin: endAR ? dateDMY(endAR) : '',
      estadoComision,
      weekDaysSet: new Set(c.weekDays || []),
      startDate: startAR,
      endDate: endAR,
      startMin,
      endMin: startMin + 120,
    };
  }).filter(Boolean);
  return { vigentes, allCommissionNumbers };
}

module.exports = async function handler(req, res) {
  try {
    const cohortId = String((req.query && req.query.cohortId) || '').trim();
    if (!cohortId) { res.status(200).json({ error: 'Falta el parametro cohortId', postulantes: [] }); return; }

    const env = getEnv();

    const [targetCohort, todasPostulaciones] = await Promise.all([
      apiGet(env.BASE, `/student/enrollment/m2m/admin/cohorts/${cohortId}`, env.STUDENT_KEY),
      getAllPostulaciones().catch(() => []),
    ]);

    if (!targetCohort || !targetCohort.id) {
      res.status(200).json({ cohortId, postulantes: [], error: 'No se encontro la comision' });
      return;
    }

    const postulacionesCohort = (todasPostulaciones || []).filter(p => p.cohortId === cohortId);
    if (!postulacionesCohort.length) {
      res.status(200).json({ cohortId, comisionNumber: targetCohort.commissionNumber, postulantes: [] });
      return;
    }

    const targetStart = targetCohort.startDate ? new Date(targetCohort.startDate) : null;
    const targetEnd = targetCohort.endDate ? new Date(targetCohort.endDate) : null;
    const targetStartMin = targetStart ? minutesOfDay(targetStart) : 0;
    const target = {
      weekDaysSet: new Set(targetCohort.weekDays || []),
      startDate: targetStart,
      endDate: targetEnd,
      startMin: targetStartMin,
      endMin: targetStartMin + 120,
    };

    // Primera pasada: juntamos overlay + agenda de cada postulante (esto ya
    // se pedia antes). Todavia no calculamos el rating final aca, porque
    // preferimos pedirle a PostHog el rating de TODOS los postulantes de
    // esta comision en una sola consulta (se cachea 15 min en lib/posthog.js)
    // en vez de una consulta por postulante.
    const datos = await Promise.all(postulacionesCohort.map(async (p) => {
      const key = personKey(p.email);
      let overlay = null;
      try { overlay = await getOverlay(key); } catch (e) { /* seguimos sin overlay */ }
      const estadoOverlay = (overlay && overlay.estado) || 'aprobado';
      const ratingVals = Object.values((overlay && overlay.ratings) || {}).filter(v => typeof v === 'number' && v > 0);
      const ratingManualPromedio = ratingVals.length ? Math.round((ratingVals.reduce((a, b) => a + b, 0) / ratingVals.length) * 10) / 10 : null;

      let accounts = null;
      try { accounts = await getAccountsForPerson(key); } catch (e) { /* cache fria */ }
      accounts = accounts || [];

      let vigentes = [];
      let allCommissionNumbers = [];
      let datosIncompletos = !accounts.length; // sin cuentas indexadas todavia -> no podemos chequear superposicion real
      if (accounts.length) {
        try {
          const r = await fetchVigentes(env, accounts, cohortId);
          vigentes = r.vigentes;
          allCommissionNumbers = r.allCommissionNumbers;
        } catch (e) {
          datosIncompletos = true;
        }
      }

      return { p, key, estadoOverlay, ratingManualPromedio, ratingManualCount: ratingVals.length, accounts, vigentes, allCommissionNumbers, datosIncompletos };
    }));

    // Un solo pedido a PostHog para el rating real de todos los postulantes
    // de esta comision juntos. Si falla (env vars, red, PostHog caido), cada
    // uno sigue con su rating manual (si lo tenia cargado) - no rompe nada.
    let postHogRatings = {};
    try {
      postHogRatings = await getPostHogRatings(datos.map(d => ({
        key: d.key,
        emails: Array.from(new Set([d.key].concat(d.accounts.map(a => a.email)))),
        commissionNumbers: d.allCommissionNumbers,
      })));
    } catch (e) { /* seguimos con el rating manual de cada uno */ }

    const postulantes = datos.map(d => {
      const ph = postHogRatings[d.key];
      const usaPostHog = ph && ph.ratingCount > 0;
      const ratingPromedio = usaPostHog ? ph.ratingPromedio : d.ratingManualPromedio;
      const ratingCount = usaPostHog ? ph.ratingCount : d.ratingManualCount;
      const ratingSource = usaPostHog ? 'posthog' : (d.ratingManualPromedio != null ? 'manual' : null);

      const overlapCheck = classifyOverlap(target, d.vigentes);
      const { color, reason: baseReason } = computeColorReason(d.estadoOverlay, overlapCheck, ratingPromedio);
      const reason = d.datosIncompletos && color !== 'rojo' ? (baseReason + ' (no se pudo verificar su agenda completa)') : baseReason;

      const enCurso = d.vigentes.filter(a => a.estadoComision === 'en_curso');
      const aFuturo = d.vigentes.filter(a => a.estadoComision === 'asignada');

      return {
        id: d.p.id,
        email: d.key,
        nombre: d.p.nombre || d.key.split('@')[0],
        rol: d.p.rol,
        fecha: d.p.fecha,
        estadoPostulacion: d.p.estado,
        ratingPromedio,
        ratingCount,
        ratingSource,
        estadoOverlay: d.estadoOverlay,
        color,
        reason,
        tooltip: {
          curso: enCurso.map(a => ({ txt: '#' + a.comisionNumber + ' ' + a.curso + ' (' + a.rol + ') — ' + a.dia + ' ' + a.horaInicio + ' a ' + a.horaFin + ' — hasta ' + a.fechaFin })),
          futuro: aFuturo.map(a => ({ txt: '#' + a.comisionNumber + ' ' + a.curso + ' (' + a.rol + ') — inicia ' + a.fechaInicio })),
        },
      };
    });

    res.status(200).json({ cohortId, comisionNumber: targetCohort.commissionNumber, postulantes });
  } catch (err) {
    res.status(200).json({ error: String(err && err.message ? err.message : err), postulantes: [] });
  }
};
