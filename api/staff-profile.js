// ============================================================================
// FUNCION SERVERLESS: perfil individual de Staff
// ============================================================================
// Trae el detalle de UNA sola persona: datos guardados en la base propia
// (estado, comentarios, cursos habilitados, rating) + su historial de
// comisiones EN VIVO.
//
// PERFILES UNIFICADOS: una misma persona puede tener varias cuentas en el
// back office (mismo mail base, distinto "+tag"). El listado (staff-list.js)
// ya arma y guarda un indice de que cuentas le pertenecen a cada mail base
// (personKey); aca lo leemos para traer el historial de TODAS esas cuentas
// juntas. Si todavia no hay indice guardado (por ejemplo la primera vez que
// se abre un perfil despues de desplegar esto, antes de haber cargado el
// listado una vez), probamos directamente el mail pedido como si fuera una
// sola cuenta, igual que antes.
//
// La clave de por que esto es rapido aunque haya miles de asignaciones en
// toda la plataforma: le pedimos a Coderhouse solo las asignaciones de la(s)
// cuenta(s) puntuales de esta persona (?userId=...), no todas. Asi el perfil
// siempre refleja al instante si se lo asigno o se lo bajo de una comision,
// sin tener que recorrer datos de las 700+ personas del back office.
// ============================================================================

const { getOverlay, defaultOverlay, personKey, getAccountsForPerson } = require('../lib/overlay');

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

// Todas las asignaciones (en cualquier estado de fecha) de UNA cuenta
// puntual (?userId=...).
async function fetchAssignmentsForAccount(env, userId) {
  const first = await apiGet(env.BASE, `/platform/staff/m2m/admin/assignments?userId=${userId}&page=1&limit=100`, env.STUDENT_KEY);
  let assignments = (first.items || []).slice();
  const totalPages = Math.min(first.totalPages || 1, 20);
  if (totalPages > 1) {
    const proms = [];
    for (let p = 2; p <= totalPages; p++) {
      proms.push(apiGet(env.BASE, `/platform/staff/m2m/admin/assignments?userId=${userId}&page=${p}&limit=100`, env.STUDENT_KEY));
    }
    (await Promise.all(proms)).forEach(d => { assignments = assignments.concat(d.items || []); });
  }
  return assignments;
}

module.exports = async function handler(req, res) {
  try {
    const rawEmail = String((req.query && req.query.email) || '').toLowerCase().trim();
    if (!rawEmail) { res.status(200).json({ error: 'Falta el parametro email' }); return; }
    const email = personKey(rawEmail);

    const env = getEnv();
    let overlay;
    let overlayError = null;
    try {
      overlay = await getOverlay(email);
    } catch (e) {
      overlayError = String(e && e.message ? e.message : e);
      overlay = defaultOverlay();
    }

    // Cuentas reales del back office que pertenecen a esta persona. OJO: el
    // campo "role" de una cuenta NO es confiable para saber si da clases de
    // verdad - se encontraron cuentas con asignaciones reales y activas cuyo
    // "role" plano dice "STUDENT" (o directamente null), mientras que el
    // dato correcto vive en publicMetadata.role. Por eso ya no filtramos por
    // role: si la cuenta existe (esta en el indice armado por el listado, o
    // se encuentra directamente por mail), siempre se le busca el historial.
    let accounts = null;
    try {
      accounts = await getAccountsForPerson(email);
    } catch (e) { /* cache no disponible, seguimos con el fallback de abajo */ }

    if (!accounts || !accounts.length) {
      // Cache todavia no poblada (ej. primera vez que se abre un perfil
      // despues de desplegar esto, antes de haber abierto el listado una
      // vez) - probamos el mail directamente, como una sola cuenta.
      let backofficeUser = null;
      try {
        const lookup = await fetch(env.BASE + '/platform/user/m2m/admin/users/by-email?email=' + encodeURIComponent(email), { headers: { 'X-API-Key': env.STUDENT_KEY } });
        if (lookup.ok) {
          const txt = await lookup.text();
          try { backofficeUser = JSON.parse(txt); } catch (e) { /* noop */ }
        }
      } catch (e) { /* noop, tratamos como no encontrado */ }
      if (backofficeUser && backofficeUser.id) {
        accounts = [{ id: backofficeUser.id, email, firstName: backofficeUser.firstName || '', lastName: backofficeUser.lastName || '' }];
      } else {
        accounts = [];
      }
    }

    const isRealInstructor = accounts.length > 0;

    let nombre = '';
    let apellido = '';
    let historial = [];

    if (isRealInstructor) {
      const withName = accounts.find(a => a.firstName || a.lastName);
      let fn = withName ? withName.firstName : '';
      let ln = withName ? withName.lastName : '';
      if (!fn && !ln) {
        const full = await apiGet(env.BASE, `/platform/user/m2m/admin/users/${accounts[0].id}`, env.STUDENT_KEY);
        fn = full.firstName;
        ln = full.lastName;
      }
      nombre = fn || '';
      apellido = ln || '';
      if (!nombre && !apellido) nombre = email.split('@')[0];

      // TODAS las asignaciones de TODAS las cuentas de esta persona, en
      // cualquier estado de fecha (pasadas, en curso y futuras) - por eso no
      // se manda ningun filtro de fecha, a diferencia del tablero de
      // Comisiones.
      const assignmentsByAccount = await Promise.all(accounts.map(a => fetchAssignmentsForAccount(env, a.id)));
      let assignments = assignmentsByAccount.flat();

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
      const now = new Date();
      historial = assignments.map(a => {
        const c = cohortById[a.cohortId];
        if (!c || c.status === 'CANCELLED') return null; // la comision en si se cancelo

        const startAR = c.startDate ? new Date(c.startDate) : null;
        const endAR = c.endDate ? new Date(c.endDate) : null;

        // El "status" que guarda el back office para la comision (IN_PROGRESS
        // / COMPLETED) no siempre se actualiza cuando corresponde - se
        // encontraron comisiones marcadas "en curso" cuya fecha de fin ya
        // paso hace meses. Por eso, si hay fechas cargadas, el estado se
        // calcula directamente comparando esas fechas con hoy (dato mucho
        // mas confiable), y solo se usa el status del back office como
        // ultimo recurso si a la comision le faltan las fechas.
        let estadoComision;
        if (endAR) estadoComision = endAR < now ? 'finalizada' : (startAR && startAR > now ? 'asignada' : 'en_curso');
        else if (startAR) estadoComision = startAR > now ? 'asignada' : 'en_curso';
        else {
          estadoComision = 'asignada';
          if (c.status === 'IN_PROGRESS') estadoComision = 'en_curso';
          else if (c.status === 'COMPLETED') estadoComision = 'finalizada';
        }

        let tipoAsignacion = 'Titular';
        if (a.isReplacement) tipoAsignacion = a.replacementType === 'REEMPLAZO' ? 'Reemplazo' : 'Suplente';

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
      cuentas: accounts.length,
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
