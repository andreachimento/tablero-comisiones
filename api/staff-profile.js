// ============================================================================
// FUNCION SERVERLESS: perfil individual de Staff
// ============================================================================
// Trae el detalle de UNA sola persona: datos guardados en la base propia
// (estado, comentarios, cursos habilitados, rating) + su historial de
// comisiones EN VIVO.
//
// La clave de por que esto es rapido aunque haya miles de asignaciones en
// toda la plataforma: le pedimos a Coderhouse solo las asignaciones de ESTE
// usuario puntual (?userId=...), no todas. Asi el perfil siempre refleja al
// instante si se lo asigno o se lo bajo de una comision, sin tener que
// recorrer datos de las 700+ personas del back office.
// ============================================================================

const { getOverlay, defaultOverlay } = require('../lib/overlay');

const TZ = 'America/Argentina/Buenos_Aires';
const DAYS_MAP = { 1: 'Lun', 2: 'Mar', 3: 'Mie', 4: 'Jue', 5: 'Vie', 6: 'Sab', 7: 'Dom' };
const ROLE_LABEL = { PROFESOR: 'Profesor', INSTRUCTOR: 'Profesor', TUTOR: 'Tutor Adjunto', SUPLENTE: 'Suplente' };

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
  return {};
}

function dateDMY(dateObj) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(dateObj);
  const p = {};
  parts.forEach(x => { p[x.type] = x.value; });
  return `${p.day}/${p.month}/${p.year}`;
}

function dateISO(dateObj) {
  return dateObj.toLocaleDateString('sv-SE', { timeZone: TZ });
}

module.exports = async function handler(req, res) {
  try {
    const email = String((req.query && req.query.email) || '').toLowerCase().trim();
    if (!email) { res.status(200).json({ error: 'Falta el parametro email' }); return; }

    const env = getEnv();
    let overlay;
    let overlayError = null;
    try {
      overlay = await getOverlay(email);
    } catch (e) {
      overlayError = String(e && e.message ? e.message : e);
      overlay = defaultOverlay();
    }

    // Buscamos si existe una cuenta REAL de instructor en el back office con
    // este mail. Ojo: aunque haya una cuenta de otro tipo (ej. estudiante),
    // solo cuenta como "perfil real" si es INSTRUCTOR - si no, se trata igual
    // como perfil "extraido de Dash".
    let backofficeUser = null;
    try {
      const lookup = await fetch(env.BASE + '/platform/user/m2m/admin/users/by-email?email=' + encodeURIComponent(email), { headers: { 'X-API-Key': env.STUDENT_KEY } });
      if (lookup.ok) {
        const txt = await lookup.text();
        try { backofficeUser = JSON.parse(txt); } catch (e) { /* noop */ }
      }
    } catch (e) { /* noop, tratamos como no encontrado */ }

    const isRealInstructor = !!(backofficeUser && backofficeUser.id && backofficeUser.role === 'INSTRUCTOR');

    let nombre = '';
    let apellido = '';
    let historial = [];

    if (isRealInstructor) {
      let fn = backofficeUser.firstName;
      let ln = backofficeUser.lastName;
      if (!fn && !ln) {
        const full = await apiGet(env.BASE, `/platform/user/m2m/admin/users/${backofficeUser.id}`, env.STUDENT_KEY);
        fn = full.firstName;
        ln = full.lastName;
      }
      nombre = fn || '';
      apellido = ln || '';
      if (!nombre && !apellido) nombre = email.split('@')[0];

      // TODAS las asignaciones de esta persona, en cualquier estado de fecha
      // (pasadas, en curso y futuras) - por eso no se manda ningun filtro de
      // fecha, a diferencia del tablero de Comisiones.
      const first = await apiGet(env.BASE, `/platform/staff/m2m/admin/assignments?userId=${backofficeUser.id}&page=1&limit=100`, env.STUDENT_KEY);
      let assignments = (first.items || []).slice();
      const totalPages = Math.min(first.totalPages || 1, 20);
      if (totalPages > 1) {
        const proms = [];
        for (let p = 2; p <= totalPages; p++) {
          proms.push(apiGet(env.BASE, `/platform/staff/m2m/admin/assignments?userId=${backofficeUser.id}&page=${p}&limit=100`, env.STUDENT_KEY));
        }
        (await Promise.all(proms)).forEach(d => { assignments = assignments.concat(d.items || []); });
      }

      // Si se la bajo de una comision (CANCELLED), no debe aparecer mas: eso
      // es justamente lo que Andrea pidio que se reflejara al instante.
      assignments = assignments.filter(a => a.status !== 'CANCELLED');

      const cohortIds = Array.from(new Set(assignments.map(a => a.cohortId).filter(Boolean)));
      const cohorts = await Promise.all(cohortIds.map(id => apiGet(env.BASE, `/student/enrollment/m2m/admin/cohorts/${id}`, env.STUDENT_KEY)));
      const cohortById = {};
      cohorts.forEach(c => { if (c && c.id) cohortById[c.id] = c; });

      const productIds = Array.from(new Set(Object.values(cohortById).map(c => c.productId).filter(Boolean)));
      const productEntries = await Promise.all(productIds.map(async pid => {
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
      const productTitle = Object.fromEntries(productEntries);

      const ratings = overlay.ratings || {};
      historial = assignments.map(a => {
        const c = cohortById[a.cohortId];
        if (!c || c.status === 'CANCELLED') return null; // la comision en si se cancelo

        let estadoComision = 'asignada';
        if (c.status === 'IN_PROGRESS') estadoComision = 'en_curso';
        else if (c.status === 'COMPLETED') estadoComision = 'finalizada';

        let tipoAsignacion = 'Titular';
        if (a.isReplacement) tipoAsignacion = a.replacementType === 'REEMPLAZO' ? 'Reemplazo' : 'Suplente';

        const startAR = c.startDate ? new Date(c.startDate) : null;
        const endAR = c.endDate ? new Date(c.endDate) : null;

        return {
          cohortId: c.id,
          curso: productTitle[c.productId] || c.name,
          comisionNumber: c.commissionNumber,
          fechaInicio: startAR ? dateDMY(startAR) : '',
          fechaInicioISO: startAR ? dateISO(startAR) : '',
          fechaFin: endAR ? dateDMY(endAR) : '',
          dia: (c.weekDays || []).slice().sort().map(d => DAYS_MAP[d] || '').join('/'),
          rol: ROLE_LABEL[a.cohortRole] || a.cohortRole || '',
          tipoAsignacion,
          estadoComision,
          rating: ratings[c.id] || null,
        };
      }).filter(Boolean);
    } else {
      // Perfil "extraido de Dash": todavia no tiene cuenta real en el back office.
      nombre = overlay.nombre || email.split('@')[0];
      apellido = overlay.apellido || '';
    }

    // Orden pedido: arriba las asignadas (mas proxima primero), en el medio
    // las en curso, abajo de todo las finalizadas (mas reciente primero).
    const asignadas = historial.filter(h => h.estadoComision === 'asignada').sort((a, b) => a.fechaInicioISO.localeCompare(b.fechaInicioISO));
    const enCurso = historial.filter(h => h.estadoComision === 'en_curso').sort((a, b) => a.fechaInicioISO.localeCompare(b.fechaInicioISO));
    const finalizadas = historial.filter(h => h.estadoComision === 'finalizada').sort((a, b) => b.fechaInicioISO.localeCompare(a.fechaInicioISO));
    historial = asignadas.concat(enCurso, finalizadas);

    const ratingVals = Object.values(overlay.ratings || {}).filter(v => typeof v === 'number' && v > 0);
    const ratingPromedio = ratingVals.length ? Math.round((ratingVals.reduce((a, b) => a + b, 0) / ratingVals.length) * 10) / 10 : null;

    res.status(200).json({
      email,
      nombre,
      apellido,
      esDash: !isRealInstructor,
      estado: overlay.estado || 'aprobado',
      comentarios: overlay.comentarios || [],
      cursosHabilitados: overlay.cursosHabilitados || [],
      ratingPromedio,
      ratingCount: ratingVals.length,
      historial,
      overlayError,
    });
  } catch (err) {
    res.status(200).json({ error: String(err && err.message ? err.message : err) });
  }
};
