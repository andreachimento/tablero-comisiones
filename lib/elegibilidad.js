// ============================================================================
// Reglas compartidas para decidir si una persona SE PUEDE SUMAR a una
// comision (usado tanto en la pestaña Comisiones -> postulantes de una
// comision puntual, como en el perfil de cada persona -> sus propias
// postulaciones). Vive en un solo lugar para que las dos vistas siempre
// muestren el mismo color para el mismo caso.
//
// Reglas (confirmadas por Andrea):
//   - ROJO: desaprobado / en consideracion futura, o superposicion COMPLETA
//     de horario con otra comision propia vigente (asignada o en curso).
//   - NARANJA: superposicion PARCIAL (algunos dias, no todos), o sin
//     superposicion pero rating <= 4.5.
//   - VERDE: sin superposicion y rating >= 4.6, o sin superposicion y
//     todavia sin ningun rating cargado.
// ============================================================================

const TZ = 'America/Argentina/Buenos_Aires';
const DAYS_MAP = { 1: 'Lun', 2: 'Mar', 3: 'Mie', 4: 'Jue', 5: 'Vie', 6: 'Sab', 7: 'Dom' };
const ROLE_LABEL = { PROFESOR: 'Profesor', INSTRUCTOR: 'Profesor', TUTOR: 'Tutor Adjunto', SUPLENTE: 'Suplente' };
const CLASS_DURATION_MS = 2 * 3600 * 1000; // fallback: solo se usa si no se consigue la duracion REAL de la clase (ver fetchClassDurationsMs mas abajo)

function dateDMY(dateObj) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(dateObj);
  const p = {};
  parts.forEach(x => { p[x.type] = x.value; });
  return `${p.day}/${p.month}/${p.year}`;
}

function timeHM(dateObj) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(dateObj);
}

function minutesOfDay(dateObj) {
  const hm = timeHM(dateObj).split(':');
  return parseInt(hm[0], 10) * 60 + parseInt(hm[1], 10);
}

// ----------------------------------------------------------------------------
// Comparacion "flexible" de nombres de curso: hace falta porque el mismo
// curso aparece escrito de formas distintas segun de donde salga el dato -
// el Excel original que cargo Andrea tiene nombres cortos y sin tildes
// (ej. "Programacion Backend I"), mientras que el back office de Coderhouse
// devuelve el nombre completo del producto (ej. "Programación Backend I:
// Desarrollo Avanzado de Backend Flex"). Si se comparan tal cual, casi nunca
// coinciden aunque sean el mismo curso. normalizeCurso() saca tildes, el
// subtitulo despues de los dos puntos y la palabra "Flex"; cursoMatches()
// considera que coinciden si quedan identicos o si uno es el comienzo del
// otro (para los nombres truncados del Excel original).
// ----------------------------------------------------------------------------
function normalizeCurso(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(':')[0]
    .replace(/\bflex\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function cursoMatches(a, b) {
  const na = normalizeCurso(a);
  const nb = normalizeCurso(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Prefijo palabra-por-palabra (no caracter por caracter) para no confundir
  // niveles numerados como "Backend I" y "Backend II": comparar caracter por
  // caracter haria que "backend i" calce como prefijo de "backend ii".
  const wa = na.split(' ').filter(Boolean);
  const wb = nb.split(' ').filter(Boolean);
  const [corta, larga] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  if (!corta.length) return false;
  return corta.every((palabra, i) => palabra === larga[i]);
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  if (!aStart || !bStart) return false;
  const aE = aEnd || aStart;
  const bE = bEnd || bStart;
  return aStart <= bE && bStart <= aE;
}

function timeRangesOverlap(aStartMin, aEndMin, bStartMin, bEndMin) {
  return aStartMin < bEndMin && bStartMin < aEndMin;
}

// target / others: { weekDaysSet: Set<number>, startDate: Date|null, endDate: Date|null, startMin: number, endMin: number }
// Devuelve { type: 'none'|'parcial'|'completa', refs: [...others que se superponen] }
function classifyOverlap(target, others) {
  let matchedDays = new Set();
  const refs = [];
  (others || []).forEach(o => {
    if (!rangesOverlap(target.startDate, target.endDate, o.startDate, o.endDate)) return;
    let dayMatchFound = false;
    target.weekDaysSet.forEach(d => {
      if (o.weekDaysSet.has(d) && timeRangesOverlap(target.startMin, target.endMin, o.startMin, o.endMin)) {
        matchedDays.add(d);
        dayMatchFound = true;
      }
    });
    if (dayMatchFound) refs.push(o);
  });
  if (!refs.length) return { type: 'none', refs: [] };
  if (target.weekDaysSet.size > 0 && matchedDays.size >= target.weekDaysSet.size) return { type: 'completa', refs };
  return { type: 'parcial', refs };
}

// Combina estado del staff + resultado de classifyOverlap + rating en el
// color/motivo final que se muestra en pantalla.
//
// habilitado (opcional, default true): pensado para postulaciones que
// llegan del sitio publico (donde cualquiera se puede postular a cualquier
// comision, curso y rol lo tenga habilitado o no) - si la persona NO esta
// habilitada para dictar ese curso en ese rol, se corta ahi con un color
// GRIS aparte de rojo/naranja/verde, para diferenciar "no se puede sumar
// por horario/estado" (rojo) de "se postulo pero todavia no esta aprobada
// para dictar esto" (gris). Los llamados existentes (postulaciones
// internas, ya todas de gente habilitada) no mandan este parametro y siguen
// funcionando igual que antes.
function computeColorReason(estadoOverlay, overlapCheck, ratingPromedio, habilitado) {
  if (habilitado === false) {
    return { color: 'gris', reason: 'Se postuló pero no está habilitado para dictar este curso · revisar antes de aprobar' };
  }
  if (estadoOverlay === 'desaprobado') {
    return { color: 'rojo', reason: 'No se puede sumar · desaprobado en el staff' };
  }
  if (estadoOverlay === 'futuro') {
    return { color: 'rojo', reason: 'No se puede sumar · en consideración futura' };
  }
  if (overlapCheck.type === 'completa') {
    const ref = overlapCheck.refs[0];
    return {
      color: 'rojo',
      reason: 'No se puede sumar · superposición completa con ' + (ref ? ('#' + ref.comisionNumber + ' ' + ref.curso) : 'otra comisión suya'),
    };
  }
  if (overlapCheck.type === 'parcial') {
    const ref = overlapCheck.refs[0];
    return {
      color: 'naranja',
      reason: 'Puede sumarse, pero se superpone en algún día con ' + (ref ? ('#' + ref.comisionNumber + ' ' + ref.curso) : 'otra comisión suya'),
    };
  }
  if (ratingPromedio != null && ratingPromedio <= 4.5) {
    return { color: 'naranja', reason: 'Puede sumarse, pero rating ' + ratingPromedio.toFixed(1) + ' (≤ 4.5)' };
  }
  return {
    color: 'verde',
    reason: ratingPromedio != null
      ? ('Disponible · rating ' + ratingPromedio.toFixed(1) + ' · sin superposición')
      : 'Disponible · sin rating todavía · sin superposición',
  };
}

// ----------------------------------------------------------------------------
// Duracion REAL de las clases de cada comision (en ms) - reemplaza el
// supuesto fijo de CLASS_DURATION_MS (2hs), que resulto estar mal para
// cursos cuyas clases en vivo duran otra cosa (ej: 2.5hs). Confirmado por
// Andrea con la comision 102315: el tablero calculaba "termina a las
// 20:30" (inicio + 2hs fijas) cuando en realidad la clase dura 2.5hs y
// termina a las 21:00.
//
// Fuente primaria (liviana: UN solo llamado batched para todas las
// comisiones que haga falta a la vez): la proxima clase en vivo de cada
// cohorte (`next-classes`). Alcanza para la gran mayoria de los casos,
// porque las pestañas que muestran comisiones "vivas" (Comisiones,
// Diplomaturas, postulantes de una comision) solo traen comisiones
// NOT_STARTED/IN_PROGRESS, que casi siempre tienen una proxima clase.
//
// Fallback (mas pesado: se pide solo para las comisiones que quedaron sin
// dato, tipicamente comisiones ya finalizadas sin clases futuras, como las
// que aparecen en el historial de un perfil de Staff): el listado completo
// de clases de esas pocas comisiones (`classes`), tomando la primera clase
// que tenga inicio y fin.
//
// Nunca tira: si algo falla (red, credenciales, endpoint caido), esas
// comisiones simplemente no quedan en el resultado y quien llama debe caer
// a CLASS_DURATION_MS (2hs) para ellas, como se hacia antes.
//
// Devuelve { [cohortId]: durationMs }.
// ----------------------------------------------------------------------------
async function apiPostSchedule(base, path, key, body, retries) {
  const maxRetries = retries == null ? 2 : retries;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(base + path, {
        method: 'POST',
        headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await resp.text();
      if (resp.ok) {
        try { return JSON.parse(text); } catch (e) { /* reintenta */ }
      }
    } catch (e) { /* reintenta */ }
    if (attempt < maxRetries) await new Promise(r => setTimeout(r, 350 * (attempt + 1)));
  }
  return null;
}

async function fetchClassDurationsMs(cohortIds, base, key) {
  const ids = Array.from(new Set((cohortIds || []).filter(Boolean)));
  const byCohort = {};
  if (!ids.length || !base || !key) return byCohort;

  try {
    const nextResp = await apiPostSchedule(base, '/education/scheduling/m2m/v2/schedules/cohorts/next-classes', key, { cohortIds: ids });
    const nextList = (nextResp && nextResp.data) || [];
    nextList.forEach(entry => {
      const nc = entry && entry.nextClass;
      if (entry && entry.cohortId && nc && nc.scheduledStartAt && nc.scheduledEndAt) {
        const dur = new Date(nc.scheduledEndAt).getTime() - new Date(nc.scheduledStartAt).getTime();
        if (dur > 0) byCohort[entry.cohortId] = dur;
      }
    });
  } catch (e) { /* seguimos con el fallback de abajo */ }

  const missing = ids.filter(id => !byCohort[id]);
  if (missing.length) {
    try {
      const classesResp = await apiPostSchedule(base, '/education/scheduling/m2m/v2/schedules/cohorts/classes', key, { cohortIds: missing });
      const classesList = (classesResp && classesResp.data) || [];
      classesList.forEach(entry => {
        const classes = (entry && entry.classes) || [];
        const first = classes.find(c => c && c.scheduledStartAt && c.scheduledEndAt);
        if (entry && entry.cohortId && first) {
          const dur = new Date(first.scheduledEndAt).getTime() - new Date(first.scheduledStartAt).getTime();
          if (dur > 0) byCohort[entry.cohortId] = dur;
        }
      });
    } catch (e) { /* nos quedamos con CLASS_DURATION_MS de fallback para estas */ }
  }

  return byCohort;
}

module.exports = {
  TZ, DAYS_MAP, ROLE_LABEL, CLASS_DURATION_MS,
  dateDMY, timeHM, minutesOfDay, rangesOverlap, timeRangesOverlap,
  classifyOverlap, computeColorReason, normalizeCurso, cursoMatches,
  fetchClassDurationsMs,
};
