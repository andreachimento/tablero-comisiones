// ============================================================================
// Reemplazos y suplencias (pestaña "Reemplazos y suplencias" del tablero)
// ============================================================================
// Trae del back office los pedidos que hace el staff cuando no puede dar una
// clase o deja una comision (en el BO se llaman "coverage cases"):
//   - SUBSTITUTION -> Suplencia: el profe/tutor no puede dar una o mas clases
//                     puntuales. Se busca alguien solo para esas fechas.
//   - REPLACEMENT  -> Reemplazo (baja de la comision): el profe/tutor deja la
//                     comision desde una fecha en adelante. Se busca quien la
//                     tome de ahi hasta el final.
// Las vacantes de asignacion (ASSIGNMENT: comisiones sin profe asignado) NO
// son pedidos de nadie y ya se ven en la pestaña Comisiones, asi que se dejan
// afuera.
//
// Para cada pedido se arma: quien lo pidio, comision, curso, rol, fechas que
// hay que cubrir, motivo, estado de la busqueda en el BO y candidatos.
// El tablero solo LEE del back office; el seguimiento interno (en gestion /
// resuelto + nota) se guarda en la base propia del tablero.
// ============================================================================

const TZ = 'America/Argentina/Buenos_Aires';
const ESTADOS = ['SEARCHING', 'OFFERED', 'PENDING_SIGNATURE', 'MANUAL', 'FILLED', 'EXPIRED', 'CANCELLED'];

function getEnv() {
  const BASE = process.env.BACKOFFICE_API_URL;
  const SK = process.env.CLAUDE_STUDENT_API_KEY;
  const FK = process.env.CLAUDE_FINANCE_API_KEY;
  if (!BASE || !SK || !FK) throw new Error('Faltan Environment Variables del back office en Vercel.');
  return { BASE: BASE.replace(/\/$/, ''), SK, FK };
}

async function pedir(e, path, key, opts) {
  const o = opts || {};
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(e.BASE + path, {
        method: o.body ? 'POST' : 'GET',
        headers: Object.assign({ 'X-API-Key': key, Accept: 'application/json' }, o.body ? { 'Content-Type': 'application/json' } : {}),
        body: o.body ? JSON.stringify(o.body) : undefined,
      });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
      last = new Error('HTTP ' + r.status + ' en ' + path.split('?')[0]);
    } catch (err) { last = err; }
    await new Promise(res => setTimeout(res, 350 * (i + 1)));
  }
  throw last;
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (err) { out[k] = null; } }
  }));
  return out;
}

function partesAR(iso) {
  if (!iso) return null;
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(iso)).forEach(x => { p[x.type] = x.value; });
  return { fecha: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
}

function nombreDe(u) {
  if (!u) return '';
  const n = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  return n || String(u.email || '').replace(/\+[^@]*@/, '@');
}

async function fetchCoberturas() {
  const e = getEnv();
  // 1) Todos los pedidos, de todos los estados (el BO exige filtrar por estado).
  const listas = await Promise.all(ESTADOS.map(st => pedir(e, `/platform/staff/m2m/admin/coverage/cases?status=${st}`, e.SK).catch(() => [])));
  const porId = {};
  listas.forEach(l => (Array.isArray(l) ? l : (l && (l.data || l.items)) || []).forEach(c => { if (c && c.kind !== 'ASSIGNMENT') porId[c.id] = c; }));
  const casos = Object.values(porId);

  // 2) Comisiones, cursos, personas, asignaciones y clases que hacen falta.
  const cohortIds = [...new Set(casos.map(c => c.cohortId).filter(Boolean))];
  const cohorts = {};
  (await pool(cohortIds, 8, id => pedir(e, `/student/enrollment/m2m/admin/cohorts/${id}`, e.SK)))
    .forEach((c, i) => { const v = c && (c.data || c.cohort || c); if (v) cohorts[cohortIds[i]] = v; });

  const productIds = [...new Set(Object.values(cohorts).map(c => c.productId).filter(Boolean))];
  const productos = {};
  (await pool(productIds, 8, pid => pedir(e, `/finance/product/m2m/products/${pid}`, e.FK)))
    .forEach((d, i) => {
      if (!d) return;
      const locs = d.localizations || [];
      productos[productIds[i]] = (locs.find(l => l.isDefault) || locs[0] || {}).title || (d.program && d.program.name) || d.slug || '';
    });

  // staffId -> userId (perfil de staff) y userId -> usuario
  const staffIds = new Set();
  casos.forEach(c => {
    if (c.optOut && c.optOut.staffId) staffIds.add(c.optOut.staffId);
    (c.offers || []).forEach(o => { if (o.status === 'WON' || o.status === 'PENDING_SIGNATURE') staffIds.add(o.staffId); });
  });
  const sList = [...staffIds];
  const staffUser = {};
  (await pool(sList, 8, id => pedir(e, `/platform/staff/m2m/admin/profiles/${id}`, e.SK)))
    .forEach((p, i) => { const v = p && (p.data || p.profile || p); if (v && v.userId) staffUser[sList[i]] = v.userId; });
  const userIds = new Set(Object.values(staffUser));
  casos.forEach(c => { if (c.optOut && c.optOut.requestedBy) userIds.add(c.optOut.requestedBy); });
  const uList = [...userIds];
  const usuarios = {};
  (await pool(uList, 8, id => pedir(e, `/platform/user/m2m/admin/users/${id}`, e.SK)))
    .forEach((u, i) => { const v = u && (u.data || u.user || u); if (v && v.id) usuarios[uList[i]] = v; });

  // rol en la comision (profesor / tutor) desde la asignacion original
  const asigIds = [...new Set(casos.map(c => c.originalAssignmentId).filter(Boolean))];
  const roles = {};
  (await pool(asigIds, 8, id => pedir(e, `/platform/staff/m2m/admin/assignments/${id}`, e.SK)))
    .forEach((a, i) => { const v = a && (a.assignment || a.data || a); if (v && v.cohortRole) roles[asigIds[i]] = v.cohortRole; });

  // fechas de las clases de cada suplencia
  const clases = {};
  const conClases = [...new Set(casos.filter(c => (c.classInstanceIds || []).length).map(c => c.cohortId))];
  for (let i = 0; i < conClases.length; i += 100) {
    try {
      const d = await pedir(e, '/education/scheduling/m2m/v2/schedules/cohorts/classes', e.SK, { body: { cohortIds: conClases.slice(i, i + 100) } });
      ((d && d.data) || []).forEach(x => (x.classes || []).forEach(k => { clases[k.id] = k; }));
    } catch (err) { /* sin fechas de clase: se usa la fecha del pedido */ }
  }

  // 3) Una fila por pedido.
  const filas = casos.map(c => {
    const co = cohorts[c.cohortId] || {};
    const oo = c.optOut || {};
    const sol = usuarios[staffUser[oo.staffId]] || null;
    const pidioU = usuarios[oo.requestedBy] || null;
    const won = (c.offers || []).find(o => o.status === 'WON') || (c.offers || []).find(o => o.status === 'PENDING_SIGNATURE');
    const cubre = won ? usuarios[staffUser[won.staffId]] : null;
    const cnt = st => (c.offers || []).filter(o => o.status === st).length;
    const fechas = (c.classInstanceIds || []).map(id => clases[id]).filter(Boolean)
      .map(k => ({ inicio: k.scheduledStartAt, clase: k.label || '', ...partesAR(k.scheduledStartAt) }))
      .sort((a, b) => String(a.inicio).localeCompare(String(b.inicio)));
    const desde = fechas.length ? fechas[0].inicio : c.fromDate;
    const ini = partesAR(co.startDate);
    return {
      id: c.id,
      // Suplencia: dias puntuales. Reemplazo: deja una comision que ya estaba en curso.
      // Baja: deja una comision que todavia no habia empezado (en la fecha desde la que se va).
      tipo: c.kind === 'SUBSTITUTION' ? 'suplencia' : (ini && partesAR(desde) && partesAR(desde).fecha <= ini.fecha ? 'baja' : 'reemplazo'),
      estadoBO: c.status,
      com: co.commissionNumber || null,
      cohortId: c.cohortId,
      curso: productos[co.productId] || co.name || '',
      rol: roles[c.originalAssignmentId] || '',
      inicioComision: ini ? ini.fecha : '',
      horario: ini ? ini.hora : '',
      dias: (co.weekDays || []).slice().sort(),
      solicitante: sol ? { nombre: nombreDe(sol), email: sol.email || '' } : null,
      cargadoPor: pidioU && staffUser[oo.staffId] !== oo.requestedBy ? { nombre: nombreDe(pidioU), email: pidioU.email || '' } : null,
      motivo: oo.reason || '',
      pedidoAt: oo.requestedAt || c.createdAt,
      desde,
      hasta: c.toDate || null,
      fechas,
      vence: c.slaExpiresAt || desde,
      avisadoAt: c.alertedAt || null,
      actualizadoAt: c.updatedAt,
      candidatos: { total: (c.offers || []).length, ofrecidas: cnt('OFFERED'), rechazadas: cnt('REJECTED'), vencidas: cnt('EXPIRED'), noAptos: cnt('INELIGIBLE') },
      cubre: cubre ? { nombre: nombreDe(cubre), email: cubre.email || '' } : null,
    };
  }).sort((a, b) => String(b.pedidoAt).localeCompare(String(a.pedidoAt)));

  return { updatedAt: new Date().toISOString(), filas };
}

module.exports = { fetchCoberturas };
