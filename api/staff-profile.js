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

const { getOverlay, setOverlay, defaultOverlay, personKey, getAccountsForPerson, getAllPostulaciones } = require('../lib/overlay');
const { minutesOfDay, timeHM, CLASS_DURATION_MS, classifyOverlap, computeColorReason } = require('../lib/elegibilidad');
const { getPostHogRatings } = require('../lib/posthog');

// Cuando ya dicto un curso (aparece en su historial real de comisiones), se
// lo da por habilitado a dictarlo aunque nadie lo haya cargado a mano en el
// Excel - si lo dicto, es porque puede. Solo se consideran los mismos dos
// roles que se pueden cargar a mano (Profesor / Tutor Adjunto); un
// reemplazo puntual como Suplente no alcanza por si solo.
const ROL_HISTORIAL_A_HABILITADO = { Profesor: 'profesor', 'Tutor Adjunto': 'tutor' };

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
          horaInicio: startAR ? timeHM(startAR) : '',
          horaFin: startAR ? timeHM(new Date(startAR.getTime() + CLASS_DURATION_MS)) : '',
          rol: ROLE_LABEL[a.cohortRole] || a.cohortRole || '',
          tipoAsignacion,
          estadoComision,
          rating: ratings[c.id] || null,
          // Campos internos (no se mandan al cliente) para poder calcular mas
          // abajo si sus postulaciones se superponen con esto.
          _weekDays: c.weekDays || [],
          _startDate: startAR,
          _endDate: endAR,
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

    // Auto-habilitacion: si ya dicto un curso de verdad (esta en su
    // historial real), lo agregamos solo a "Cursos habilitados a dictar"
    // aunque no estuviera cargado a mano ni en el Excel - haberlo dictado ya
    // demuestra que puede. Si se agrega algo nuevo, se guarda de una para
    // que tambien aparezca la proxima vez que se abra el listado de Staff
    // (que no vuelve a mirar el historial de cada persona, por velocidad).
    overlay.cursosHabilitados = overlay.cursosHabilitados || [];
    let cursosNuevosPorHistorial = false;
    historial.forEach(h => {
      const rolHabilitado = ROL_HISTORIAL_A_HABILITADO[h.rol];
      if (!rolHabilitado || !h.curso) return;
      const yaExiste = overlay.cursosHabilitados.some(c => String(c.curso || '').toLowerCase() === h.curso.toLowerCase() && c.rol === rolHabilitado);
      if (!yaExiste) { overlay.cursosHabilitados.push({ curso: h.curso, rol: rolHabilitado }); cursosNuevosPorHistorial = true; }
    });
    if (cursosNuevosPorHistorial && !overlayError) {
      try { await setOverlay(email, overlay); } catch (e) { /* si no se pudo guardar, se vuelve a intentar la proxima vez que se abra este perfil */ }
    }

    const ratingVals = Object.values(overlay.ratings || {}).filter(v => typeof v === 'number' && v > 0);
    const ratingManualPromedio = ratingVals.length ? Math.round((ratingVals.reduce((a, b) => a + b, 0) / ratingVals.length) * 10) / 10 : null;

    // Rating real, sacado de la encuesta "Live Class Rating" de PostHog (ver
    // lib/posthog.js para el detalle de como se calcula). Se usa como
    // fuente principal; si todavia no hay ninguna respuesta de encuesta que
    // le corresponda a esta persona, se cae al rating manual viejo (si lo
    // tenia cargado) en vez de mostrar "sin datos" de golpe.
    let ratingPromedio = ratingManualPromedio;
    let ratingCount = ratingVals.length;
    let ratingSource = ratingManualPromedio != null ? 'manual' : null;
    try {
      const misComisiones = Array.from(new Set(historial.map(h => h.comisionNumber).filter(v => v != null)));
      const misMails = Array.from(new Set([email].concat(accounts.map(a => a.email))));
      const phRatings = await getPostHogRatings([{ key: email, emails: misMails, commissionNumbers: misComisiones }]);
      const ph = phRatings[email];
      if (ph && ph.ratingCount > 0) {
        ratingPromedio = ph.ratingPromedio;
        ratingCount = ph.ratingCount;
        ratingSource = 'posthog';
      }
    } catch (e) { /* si falla PostHog (env vars, red, etc.) seguimos con el rating manual */ }

    // Postulaciones que hizo esta persona desde el sitio publico de
    // postulaciones (a cualquiera de sus mails, por eso se compara por
    // personKey y no por el mail exacto). Se les suma el mismo cruce de
    // color (se puede sumar / con advertencia / no se puede sumar) que se
    // ve en la pestaña Comisiones, para no tener que entrar ahi a chequearlo.
    let postulaciones = [];
    try {
      const todas = await getAllPostulaciones();
      postulaciones = todas.filter(p => personKey(p.email) === email);
      postulaciones.sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')));

      // Sus propias comisiones vigentes (asignada/en_curso), listas para
      // cruzar horarios contra cada comision a la que se postulo.
      const vigentes = historial.filter(h => h.estadoComision !== 'finalizada').map(h => {
        const startMin = h._startDate ? minutesOfDay(h._startDate) : 0;
        return {
          weekDaysSet: new Set(h._weekDays || []),
          startDate: h._startDate,
          endDate: h._endDate,
          startMin,
          endMin: startMin + 120,
          comisionNumber: h.comisionNumber,
          curso: h.curso,
        };
      });

      if (postulaciones.length) {
        const targets = await Promise.all(postulaciones.map(p => apiGet(env.BASE, `/student/enrollment/m2m/admin/cohorts/${p.cohortId}`, env.STUDENT_KEY)));
        postulaciones = postulaciones.map((p, i) => {
          const c = targets[i];
          if (!c || !c.id) return { ...p, color: null, reason: 'No se pudo verificar (la comision ya no existe)' };
          const startAR = c.startDate ? new Date(c.startDate) : null;
          const endAR = c.endDate ? new Date(c.endDate) : null;
          const startMin = startAR ? minutesOfDay(startAR) : 0;
          const target = {
            weekDaysSet: new Set(c.weekDays || []),
            startDate: startAR,
            endDate: endAR,
            startMin,
            endMin: startMin + 120,
          };
          const overlapCheck = classifyOverlap(target, vigentes.filter(v => v.comisionNumber !== c.commissionNumber));
          const { color, reason } = computeColorReason(overlay.estado || 'aprobado', overlapCheck, ratingPromedio);
          return { ...p, color, reason };
        });
      }
    } catch (e) { /* si falla, mostramos el resto del perfil igual */ }

    historial.forEach(h => { delete h._weekDays; delete h._startDate; delete h._endDate; });

    res.status(200).json({
      email,
      nombre,
      apellido,
      esDash: !isRealInstructor,
      cuentas: accounts.length,
      estado: overlay.estado || 'aprobado',
      comentarios: overlay.comentarios || [],
      cursosHabilitados: overlay.cursosHabilitados || [],
      disponibilidad: overlay.disponibilidad || { dias: [], franjas: [] },
      ratingPromedio,
      ratingCount,
      ratingSource,
      historial,
      postulaciones,
      overlayError,
    });
  } catch (err) {
    res.status(200).json({ error: String(err && err.message ? err.message : err) });
  }
};
