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

// ----------------------------------------------------------------------------
// Cierre automatico: si el BO muestra que un pedido abierto ya no necesita
// gestion, se devuelve { estado: 'resuelto'|'descartado', motivo }. El tablero
// lo marca solo (sin pisar lo que haya marcado una persona) y lo vuelve a abrir
// si deja de cumplirse. Se revisa en cada consulta al BO.
// ----------------------------------------------------------------------------
function ddmm(iso) { const p = partesAR(iso); return p ? p.fecha.slice(8, 10) + '/' + p.fecha.slice(5, 7) : ''; }
function cierreAutomatico(c, tipo, co, fechas, desde, asigs, casos, rolOriginal) {
  if (['FILLED', 'CANCELLED'].includes(c.status)) return null;
  const oo = c.optOut || {};
  const ahora = Date.now();
  const st = String(co.status || '').toUpperCase();
  if (st === 'CANCELLED') return { estado: 'descartado', motivo: 'La comisión fue cancelada en el BO.' };
  if (st === 'COMPLETED' || st === 'FINISHED' || (co.endDate && new Date(co.endDate).getTime() < ahora - 24 * 3600e3))
    return { estado: 'descartado', motivo: 'La comisión ya finalizó.' };
  const pedidoMs = new Date(oo.requestedAt || c.createdAt || 0).getTime();
  const lista = asigs || [];
  const original = lista.find(a => a.id === c.originalAssignmentId);
  const rol = (original && original.cohortRole) || rolOriginal || '';
  // alguien nuevo (no quien pidio) asignado en la comision despues del pedido
  const nuevos = lista.filter(a => a.staffId !== oo.staffId && ['ACTIVE', 'COMPLETED'].includes(a.status)
    && new Date(a.createdAt || a.assignedAt || a.startDate || 0).getTime() >= pedidoMs - 5 * 60e3);
  const quien = a => (a.professorName || a.email || 'otra persona') + ' (' + String(a.cohortRole || '').toLowerCase() + ', cargado el ' + ddmm(a.createdAt || a.startDate) + ')';
  if (tipo === 'suplencia') {
    const cubreClase = nuevos.find(a => a.cohortRole === 'SUPLENTE' || (rol ? a.cohortRole === rol : a.isReplacement));
    if (cubreClase) return { estado: 'resuelto', motivo: 'Cubierto en el BO: ' + quien(cubreClase) + '.' };
    const ultima = fechas.length ? fechas[fechas.length - 1].inicio : desde;
    if (ultima && new Date(ultima).getTime() < ahora - 3 * 3600e3)
      return { estado: 'descartado', motivo: 'La fecha de la suplencia ya pasó (' + (fechas.length ? fechas.map(f => ddmm(f.inicio)).join(', ') : ddmm(ultima)) + ').' };
  } else {
    // reemplazo / baja: quien pidio ya no esta activo y hay otra persona nueva en el mismo rol
    const yaSalio = !original || original.status !== 'ACTIVE';
    const reemplazante = nuevos.find(a => a.status === 'ACTIVE' && (rol ? a.cohortRole === rol : a.isReplacement));
    if (yaSalio && reemplazante) return { estado: 'resuelto', motivo: 'El staff ya se dio de baja y hay reemplazo en la comisión: ' + quien(reemplazante) + '.' };
  }
  // pedidos repetidos del mismo staff para la misma comision
  const mismos = casos.filter(x => x.id !== c.id && x.cohortId === c.cohortId && x.kind === c.kind && x.optOut && x.optOut.staffId === oo.staffId);
  if (mismos.some(x => x.status === 'FILLED')) return { estado: 'resuelto', motivo: 'Ya se cubrió en otro pedido del mismo staff para esta comisión.' };
  if (mismos.some(x => !['FILLED', 'CANCELLED'].includes(x.status) && new Date((x.optOut && x.optOut.requestedAt) || x.createdAt || 0).getTime() > pedidoMs))
    return { estado: 'descartado', motivo: 'Duplicado: hay un pedido más nuevo del mismo staff para esta comisión.' };
  return null;
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

  // personal de cada comision con pedidos abiertos (para detectar si ya se cubrio por fuera del circuito de ofertas)
  const abiertos = casos.filter(c => !['FILLED', 'CANCELLED'].includes(c.status));
  const cohAbiertas = [...new Set(abiertos.map(c => c.cohortId).filter(Boolean))];
  const staffCom = {};
  (await pool(cohAbiertas, 8, id => pedir(e, `/platform/staff/m2m/admin/assignments/cohort/${id}`, e.SK)))
    .forEach((d, i) => { const v = Array.isArray(d) ? d : (d && (d.data || d.assignments)); if (Array.isArray(v)) staffCom[cohAbiertas[i]] = v; });

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
    const tipo = c.kind === 'SUBSTITUTION' ? 'suplencia' : (ini && partesAR(desde) && partesAR(desde).fecha <= ini.fecha ? 'baja' : 'reemplazo');
    return {
      id: c.id,
      // Suplencia: dias puntuales. Reemplazo: deja una comision que ya estaba en curso.
      // Baja: deja una comision que todavia no habia empezado (en la fecha desde la que se va).
      tipo,
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
      autoCierre: cierreAutomatico(c, tipo, co, fechas, desde, staffCom[c.cohortId], casos, roles[c.originalAssignmentId]),
    };
  });

  // 4) Pedidos que entraron por Slack / Intercom: se suman a la fila del BO si es el
  //    mismo pedido (no se duplica) o quedan como fila propia "Sin cargar en BO".
  let canales = { conectado: false };
  try {
    const { fetchCanales } = require('./canales');
    const c = await fetchCanales();
    canales = { conectado: c.conectado, canales: (c.canales || []).map(x => x.nombre), error: c.error };
    if (c.items && c.items.length) filas.push(...await unirCanales(e, filas, c.items));
    // avisos sueltos de resolucion ("92255 dicta la clase X") para pedidos del BO todavia abiertos
    (c.resoluciones || []).forEach(r => {
      filas.filter(f => String(f.com) === String(r.com) && !f.autoCierre && !['FILLED', 'CANCELLED', 'SIN_BO'].includes(f.estadoBO) && r.at >= String(f.pedidoAt))
        .forEach(f => {
          if (f.tipo === 'suplencia' || cierraDefinitivo(r))
            f.autoCierre = { estado: r.cancelada ? 'descartado' : 'resuelto', motivo: motivoResolucion(r) };
          if (!f.origenes) f.origenes = [];
          if (!f.origenes.some(o => o.link === r.link)) f.origenes.push({ tipo: 'slack', canal: r.canal, link: r.link, at: r.at, autor: r.autor });
        });
    });
  } catch (err) { canales = { conectado: !!process.env.SLACK_BOT_TOKEN, error: String(err && err.message ? err.message : err) }; }

  filas.forEach(f => { if (!f.origenes) f.origenes = []; if (f.estadoBO !== 'SIN_BO' && !f.origenes.some(o => o.tipo === 'bo')) f.origenes.unshift({ tipo: 'bo' }); });
  filas.sort((a, b) => String(b.pedidoAt).localeCompare(String(a.pedidoAt)));
  return { updatedAt: new Date().toISOString(), filas, canales };
}

// ----------------------------------------------------------------------------
// Union con Slack / Intercom
// ----------------------------------------------------------------------------
const palabras = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^a-z]+/).filter(w => w.length > 2 && !['staff', 'user', 'profe', 'profesor', 'profesora', 'tutor', 'tutora'].includes(w));
const mismaPersona = (a, b) => { const A = palabras(a), B = palabras(b); return !A.length || !B.length || A.some(w => B.includes(w)); };
function uuidDe(texto) {
  const h = require('crypto').createHash('md5').update(String(texto)).digest('hex');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20, 32);
}
const origenDe = it => it.origenes.map(o => ({ tipo: 'slack', canal: o.canal, link: o.link, at: o.at, autor: o.autor }))
  .concat(it.conv ? [{ tipo: 'intercom', link: it.convLink, conv: it.conv }] : []);
// para un reemplazo o baja, "dicta la clase X" puede ser solo por un dia: hace falta que diga que se asigno
const cierraDefinitivo = r => /(asign|toma la comision|queda (a cargo|como)|reemplazo (definitivo|confirmado))/.test(String(r.texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase());
const motivoResolucion = r => (r.cancelada ? 'Clase cancelada, avisado en ' : 'Avisado en ') + r.canal + (r.autor ? ' por ' + r.autor : '') + ': "' + r.texto.replace(/<[^>|]*\|([^>]*)>/g, '$1').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 160) + '"';

async function unirCanales(e, filas, items) {
  const nuevas = [];
  const sueltos = [];
  items.forEach(it => {
    const DIEZ = 10 * 86400e3;
    const cands = filas.filter(f => String(f.com) === String(it.com)
      && (it.definitivo ? f.tipo !== 'suplencia' : f.tipo === 'suplencia')
      && Math.abs(new Date(f.pedidoAt).getTime() - new Date(it.pedidoAt).getTime()) <= DIEZ
      && (!it.docente || !f.solicitante || mismaPersona(it.docente, f.solicitante.nombre) || mismaPersona(it.email, f.solicitante.email)))
      .sort((a, b) => Math.abs(new Date(a.pedidoAt) - new Date(it.pedidoAt)) - Math.abs(new Date(b.pedidoAt) - new Date(it.pedidoAt)));
    if (cands.length) {
      const f = cands[0];
      f.origenes = (f.origenes || []).concat(origenDe(it));
      if (it.resolucion && !f.autoCierre && !['FILLED', 'CANCELLED'].includes(f.estadoBO) && (f.tipo === 'suplencia' || cierraDefinitivo(it.resolucion)))
        f.autoCierre = { estado: it.resolucion.cancelada ? 'descartado' : 'resuelto', motivo: motivoResolucion(it.resolucion) };
    } else sueltos.push(it);
  });
  if (!sueltos.length) return nuevas;

  // datos de las comisiones de los pedidos que no estan en el BO
  const coms = [...new Set(sueltos.map(x => x.com))];
  const porCom = {};
  (await pool(coms, 6, n => pedir(e, `/student/enrollment/m2m/admin/cohorts?commissionNumber=${n}&limit=5`, e.SK)))
    .forEach((d, i) => { const l = (d && (d.data || d.items)) || (Array.isArray(d) ? d : []); const c = l.find(x => String(x.commissionNumber) === String(coms[i])) || l[0]; if (c) porCom[coms[i]] = c; });
  const cids = Object.values(porCom).map(c => c.id);
  const prods = {};
  const pids = [...new Set(Object.values(porCom).map(c => c.productId).filter(Boolean))];
  (await pool(pids, 6, pid => pedir(e, `/finance/product/m2m/products/${pid}`, e.FK)))
    .forEach((d, i) => { if (d) { const l = d.localizations || []; prods[pids[i]] = (l.find(x => x.isDefault) || l[0] || {}).title || (d.program && d.program.name) || ''; } });
  const asig = {};
  (await pool(cids, 6, id => pedir(e, `/platform/staff/m2m/admin/assignments/cohort/${id}`, e.SK)))
    .forEach((d, i) => { const v = Array.isArray(d) ? d : (d && (d.data || d.assignments)); if (Array.isArray(v)) asig[cids[i]] = v; });
  const clases = {};
  if (cids.length) {
    try {
      const d = await pedir(e, '/education/scheduling/m2m/v2/schedules/cohorts/classes', e.SK, { body: { cohortIds: cids } });
      ((d && d.data) || []).forEach(x => { const id = x.cohortId || (x.cohort && x.cohort.id); if (id) clases[id] = (x.classes || []).filter(k => k.scheduledStartAt).sort((a, b) => a.scheduledStartAt.localeCompare(b.scheduledStartAt)); });
    } catch (err) { /* sin cronograma */ }
  }

  const ahora = Date.now();
  sueltos.forEach(it => {
    const co = porCom[it.com] || {};
    const ks = clases[co.id] || [];
    const ini = partesAR(co.startDate);
    // fecha a cubrir: la que dice el mensaje (con la hora de la clase de ese dia) o la proxima clase
    let clase = null;
    if (it.fechaTexto) clase = ks.find(k => partesAR(k.scheduledStartAt).fecha === it.fechaTexto) || null;
    else clase = ks.find(k => new Date(k.scheduledStartAt).getTime() >= new Date(it.pedidoAt).getTime() - 3 * 3600e3) || null;
    const desde = clase ? clase.scheduledStartAt : (it.fechaTexto ? it.fechaTexto + 'T' + (ini ? ini.hora : '12:00') + ':00-03:00' : it.pedidoAt);
    const tipo = !it.definitivo ? 'suplencia' : (ini && partesAR(desde) && partesAR(desde).fecha <= ini.fecha ? 'baja' : 'reemplazo');
    const rol = /tutor/i.test(it.rol) ? 'TUTOR' : /prof/i.test(it.rol) ? 'PROFESOR' : '';
    const lista = asig[co.id] || [];
    // cierre automatico
    let autoCierre = null;
    const st = String(co.status || '').toUpperCase();
    if (it.resolucion && (!it.definitivo || cierraDefinitivo(it.resolucion))) autoCierre = { estado: it.resolucion.cancelada ? 'descartado' : 'resuelto', motivo: motivoResolucion(it.resolucion) };
    else if (st === 'CANCELLED') autoCierre = { estado: 'descartado', motivo: 'La comisión fue cancelada en el BO.' };
    else if (st === 'COMPLETED' || (co.endDate && new Date(co.endDate).getTime() < ahora - 86400e3)) autoCierre = { estado: 'descartado', motivo: 'La comisión ya finalizó.' };
    else if (tipo === 'suplencia' && new Date(desde).getTime() < ahora - 3 * 3600e3) autoCierre = { estado: 'descartado', motivo: 'La fecha de la suplencia ya pasó (' + (partesAR(desde) || {}).fecha.split('-').reverse().slice(0, 2).join('/') + ').' };
    else if (tipo !== 'suplencia') {
      const pedido = new Date(it.pedidoAt).getTime();
      const quien = lista.find(a => it.docente && mismaPersona(it.docente, a.professorName));
      const nuevo = lista.find(a => a.status === 'ACTIVE' && (!rol || a.cohortRole === rol) && new Date(a.createdAt || a.startDate || 0).getTime() >= pedido - 5 * 60e3 && !(it.docente && mismaPersona(it.docente, a.professorName)));
      if (nuevo && (!quien || quien.status !== 'ACTIVE')) autoCierre = { estado: 'resuelto', motivo: 'El staff ya se dio de baja y hay reemplazo en la comisión: ' + (nuevo.professorName || nuevo.email) + '.' };
    }
    nuevas.push({
      id: uuidDe(it.id),
      tipo,
      estadoBO: 'SIN_BO',
      com: it.com,
      cohortId: co.id || null,
      curso: prods[co.productId] || co.name || '',
      rol,
      inicioComision: ini ? ini.fecha : '',
      horario: ini ? ini.hora : '',
      dias: (co.weekDays || []).slice().sort(),
      solicitante: { nombre: it.docente || it.email || '(no se identifica en el mensaje)', email: it.email || '' },
      cargadoPor: { nombre: (it.autor || 'Slack') + ' · ' + it.canal },
      motivo: it.motivo,
      pedidoAt: it.pedidoAt,
      desde,
      hasta: null,
      fechas: clase && tipo === 'suplencia' ? [{ inicio: clase.scheduledStartAt, clase: clase.label || '', ...partesAR(clase.scheduledStartAt) }] : [],
      vence: desde,
      candidatos: { total: 0, ofrecidas: 0, rechazadas: 0, vencidas: 0, noAptos: 0 },
      cubre: null,
      origenes: origenDe(it),
      autoCierre,
    });
  });
  return nuevas;
}

module.exports = { fetchCoberturas, _test: { unirCanales, mismaPersona, uuidDe } };
