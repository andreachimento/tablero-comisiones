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
const CLASS_DURATION_MS = 2 * 3600 * 1000; // misma suposicion que el resto del tablero: 2hs por clase

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
function computeColorReason(estadoOverlay, overlapCheck, ratingPromedio) {
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

module.exports = {
  TZ, DAYS_MAP, ROLE_LABEL, CLASS_DURATION_MS,
  dateDMY, timeHM, minutesOfDay, rangesOverlap, timeRangesOverlap,
  classifyOverlap, computeColorReason,
};
