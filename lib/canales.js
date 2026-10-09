// ============================================================================
// Pedidos de suplencia / reemplazo / baja que entran por Slack (y por Intercom,
// que Studio Chat reenvia a #alertas-staff con el numero de conversacion).
// ============================================================================
// Se leen los canales configurados (por defecto #alertas-staff,
// #alertas-suplencias-reemplazos y #incidencias-cancelaciones) con un bot de
// Slack (Environment Variable SLACK_BOT_TOKEN en Vercel; el bot tiene que estar
// agregado a cada canal). Opcional: SLACK_CANALES con nombres o IDs separados
// por coma para cambiar la lista.
//
// De cada mensaje se detecta: numero de comision, tipo (suplencia / reemplazo o
// baja), quien lo pide, fecha a cubrir y si en el mismo canal o en el hilo
// alguien avisa que ya se resolvio ("dicta la clase X", "lo cubre", etc.).
// La union con los pedidos del BO (para no duplicar) se hace en
// api/dashboard-data.js. El tablero solo LEE de Slack.
// ============================================================================

const TZ = 'America/Argentina/Buenos_Aires';
const CANALES_DEF = ['alertas-staff', 'alertas-suplencias-reemplazos', 'incidencias-cancelaciones'];
const DIAS_ATRAS = 21;
const WORKSPACE = 'https://coderhouse1.slack.com';

// --------------------------- lectura de texto ------------------------------
const sinTildes = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// numeros de comision: 5 o 6 digitos que empiezan con 9 o 1 (90510, 103085...)
const RE_COM = /(?:^|[^\d])((?:9\d{4})|(?:1\d{5}))(?!\d)/g;
function comisiones(texto) {
  const out = []; let m; const t = String(texto || '').replace(/<(?:https?|mailto):[^>]*>/g, ' ');
  RE_COM.lastIndex = 0;
  while ((m = RE_COM.exec(t))) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}
const RE_PEDIDO = /(no (voy a |va a |vamos a )?(poder|podra|podre|puedo|puede|llego|llega) (a )?(dictar|dar|asistir|estar|cubrir|sumar|conectar|tomar)|no podra (dictar|asistir|estar|dar)|no pudo (asistir|dictar|dar|estar|conectarse)|inasistencia|ausencia|no puedo asistir|suplenc|suplente|reemplaz|baja de la comision|darme de baja|dejar la comision|dejo la comision|renuncia|necesit\w* (un |una )?(suplente|reemplazo|cubrir)|busc\w* (suplente|reemplazo)|pidio (suplencia|reemplazo|la baja))/;
const RE_DEFINITIVO = /(baja de la comision|darme de baja|me doy de baja|se da de baja|pide la baja|pidio la baja|dejar la comision|dejo la comision|deja la comision|renuncia|desvincul|no (voy a |va a |podra |puede )?continuar|reemplazo definitivo|reemplazo de profe|por el resto de la cursada|hasta el final de la cursada)/;
const RE_CANCELADA = /(cancelamos|se cancelo|clase cancelada|cancelada la clase|suspendimos la clase)/;
const RE_RESUELTO = /(dicta (la clase|las clases|hoy|el)|la dicta|lo cubre|la cubre|cubre (la clase|hoy|el|la)|cubrio|cubierta|cubierto|toma la clase|tomo la clase|la toma|lo toma|ya (esta|quedo) (cubiert|resuelt|asignad)|resuelto|asigne|asignamos|ya asignad|reemplazo asignado|suplente asignad|pudo cubrir|cubrir y desarrollar|reprogram|cancelamos|se cancelo|clase cancelada|suspendimos)/;

function partesAR(d) {
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })
    .formatToParts(d).forEach(x => { p[x.type] = x.value; });
  return { fecha: `${p.year}-${p.month}-${p.day}`, wd: { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday] };
}
const sumarDias = (fecha, n) => { const d = new Date(fecha + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const DIAS = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };
// Fecha (AAAA-MM-DD, hora Argentina) que el mensaje pide cubrir, o null si no la dice.
function fechaDelTexto(texto, enviado) {
  const t = sinTildes(texto);
  const base = partesAR(enviado);
  const m = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (m) {
    const dd = +m[1], mm = +m[2];
    if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12) {
      let yy = m[3] ? +m[3] : +base.fecha.slice(0, 4);
      if (yy < 100) yy += 2000;
      let f = `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
      if (!m[3] && f < sumarDias(base.fecha, -60)) f = `${yy + 1}${f.slice(4)}`;
      return f;
    }
  }
  if (/pasado manana/.test(t)) return sumarDias(base.fecha, 2);
  if (/\bmanana\b/.test(t) && !/de la manana|por la manana|a la manana/.test(t)) return sumarDias(base.fecha, 1);
  if (/\b(hoy|esta noche|esta tarde|ahora)\b/.test(t)) return base.fecha;
  for (const [nom, wd] of Object.entries(DIAS)) {
    if (new RegExp('\\b' + nom + '\\b').test(t)) return sumarDias(base.fecha, (wd - base.wd + 7) % 7);
  }
  return null;
}

// Mensaje de Studio Chat en #alertas-staff: "ALERTA STAFF ... Docente: X / Rol: Y / Consulta: Z / Conv #N"
function leerAlertaStaff(texto) {
  const campo = n => { const m = String(texto).match(new RegExp('(?:^|\\n)\\s*\\*?' + n + '\\*?:\\s*([^\\n]+)', 'i')); return m ? m[1].trim() : ''; };
  const conv = (String(texto).match(/Conv #(\d{6,})/) || String(texto).match(/conversation\/(\d{6,})/) || [])[1] || '';
  return { esAlertaStaff: /ALERTA STAFF/i.test(texto), docente: campo('Docente').replace(/^Profe\s*\|\s*/i, ''), rol: campo('Rol'), consulta: campo('Consulta'), conv };
}

// ------------------------------- Slack API ---------------------------------
async function slack(metodo, params, token) {
  const u = new URL('https://slack.com/api/' + metodo);
  Object.entries(params || {}).forEach(([k, v]) => { if (v !== undefined && v !== null) u.searchParams.set(k, String(v)); });
  for (let i = 0; i < 3; i++) {
    const r = await fetch(u, { headers: { Authorization: 'Bearer ' + token } });
    if (r.status === 429) { await new Promise(res => setTimeout(res, 1000 * (Number(r.headers.get('retry-after')) || 2))); continue; }
    const d = await r.json();
    if (!d.ok) throw new Error('Slack ' + metodo + ': ' + d.error);
    return d;
  }
  throw new Error('Slack ' + metodo + ': demasiadas consultas');
}
const textoDe = m => {
  let t = m.text || '';
  (m.attachments || []).forEach(a => { t += '\n' + [a.pretext, a.title, a.text, a.fallback].filter(Boolean).join('\n'); });
  if (!t.trim() && Array.isArray(m.blocks)) t = JSON.stringify(m.blocks).replace(/"[a-z_]+":/g, ' ').replace(/[{}\[\]",]/g, ' ');
  return t;
};
const linkDe = (canal, ts) => WORKSPACE + '/archives/' + canal + '/p' + String(ts).replace('.', '');
const fechaTs = ts => new Date(Number(String(ts).split('.')[0]) * 1000);

// ---------------------------------------------------------------------------
// Devuelve { conectado, canales: [{id, nombre}], items: [...], error? }.
// items: un pedido detectado por mensaje (ya unidos los repetidos del mismo
// canal o de la misma conversacion de Intercom).
// ---------------------------------------------------------------------------
async function fetchCanales() {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return { conectado: false, canales: [], items: [] };
  const pedidos = (process.env.SLACK_CANALES || CANALES_DEF.join(',')).split(',').map(s => s.trim().replace(/^#/, '')).filter(Boolean);

  // nombres -> IDs (el bot solo ve los canales privados a los que fue agregado)
  const todos = [];
  let cursor;
  do {
    const d = await slack('conversations.list', { types: 'public_channel,private_channel', limit: 1000, exclude_archived: true, cursor }, token);
    todos.push(...(d.channels || []));
    cursor = d.response_metadata && d.response_metadata.next_cursor;
  } while (cursor);
  const canales = [];
  const faltan = [];
  pedidos.forEach(p => {
    const c = todos.find(x => x.id === p || x.name === p);
    if (c) canales.push({ id: c.id, nombre: '#' + c.name, miembro: !!c.is_member }); else faltan.push(p);
  });

  const desde = Math.floor(Date.now() / 1000) - DIAS_ATRAS * 86400;
  const usuarios = {};
  const nombreUsuario = async (uid, m) => {
    if (m && m.bot_profile && m.bot_profile.name) return m.bot_profile.name;
    if (m && m.username) return m.username;
    if (!uid) return '';
    if (usuarios[uid] === undefined) {
      try { const d = await slack('users.info', { user: uid }, token); const u = d.user || {}; usuarios[uid] = (u.profile && (u.profile.real_name || u.profile.display_name)) || u.real_name || u.name || ''; }
      catch (e) { usuarios[uid] = ''; }
    }
    return usuarios[uid];
  };

  const mensajes = [];
  const errores = faltan.length ? ['No se encontró o el bot no está agregado a: ' + faltan.map(f => '#' + f).join(', ')] : [];
  for (const c of canales) {
    if (!c.miembro) { errores.push('El bot no está agregado a ' + c.nombre); continue; }
    try {
      let cur, vueltas = 0;
      do {
        const d = await slack('conversations.history', { channel: c.id, oldest: desde, limit: 200, cursor: cur }, token);
        (d.messages || []).forEach(m => mensajes.push({ canal: c, m }));
        cur = d.response_metadata && d.response_metadata.next_cursor;
      } while (cur && ++vueltas < 5);
    } catch (e) { errores.push(c.nombre + ': ' + e.message); }
  }

  // 1) pedidos
  const items = [];
  const resoluciones = []; // { com, texto, at, link, autor }
  for (const { canal, m } of mensajes) {
    if (m.subtype && !['bot_message', 'thread_broadcast'].includes(m.subtype)) continue;
    const texto = textoDe(m);
    const t = sinTildes(texto);
    const al = leerAlertaStaff(texto);
    const enviado = fechaTs(m.ts);
    const coms = comisiones(al.esAlertaStaff ? al.consulta : texto);
    const autor = await nombreUsuario(m.user, m);
    // mensajes que avisan que algo ya se resolvio (sirven para cerrar pedidos)
    if (coms.length && RE_RESUELTO.test(t)) coms.forEach(com => resoluciones.push({ com, texto: texto.slice(0, 300), at: enviado.toISOString(), link: linkDe(canal.id, m.ts), autor, canal: canal.nombre, cancelada: RE_CANCELADA.test(t) }));
    const esPedido = al.esAlertaStaff ? RE_PEDIDO.test(sinTildes(al.consulta)) : RE_PEDIDO.test(t);
    if (!esPedido || !coms.length) continue;
    // respuestas del hilo: tambien pueden resolverlo
    let hilo = [];
    if (m.reply_count) {
      try {
        const d = await slack('conversations.replies', { channel: canal.id, ts: m.ts, limit: 50 }, token);
        hilo = (d.messages || []).filter(x => x.ts !== m.ts);
      } catch (e) { /* sin hilo */ }
    }
    for (const x of hilo) {
      const tx = textoDe(x);
      if (RE_RESUELTO.test(sinTildes(tx))) {
        const a = await nombreUsuario(x.user, x);
        coms.forEach(com => resoluciones.push({ com, texto: tx.slice(0, 300), at: fechaTs(x.ts).toISOString(), link: linkDe(canal.id, m.ts), autor: a, canal: canal.nombre, cancelada: RE_CANCELADA.test(sinTildes(tx)) }));
      }
    }
    const motivo = al.esAlertaStaff ? al.consulta : texto.replace(/<@[A-Z0-9]+\|([^>]+)>/g, '$1').replace(/<mailto:[^|>]+\|([^>]+)>/g, '$1').replace(/<(https?:[^|>]+)\|?[^>]*>/g, '').trim();
    const definitivo = RE_DEFINITIVO.test(sinTildes(motivo));
    const email = (motivo.match(/[\w.+-]+@[\w-]+\.[\w.]+/) || [])[0] || '';
    coms.forEach(com => items.push({
      id: 'slack:' + canal.id + ':' + m.ts + ':' + com,
      com,
      definitivo,
      docente: al.docente || '',
      email,
      rol: al.rol || '',
      autor,
      canal: canal.nombre,
      link: linkDe(canal.id, m.ts),
      conv: al.conv,
      convLink: al.conv ? 'https://app.intercom.com/a/inbox/_/inbox/conversation/' + al.conv : '',
      motivo: motivo.slice(0, 800),
      pedidoAt: enviado.toISOString(),
      fechaTexto: fechaDelTexto(al.esAlertaStaff ? al.consulta : texto, enviado),
      ts: m.ts,
    }));
  }

  // 2) unir repetidos: misma conversacion de Intercom, o misma comision + tipo + fecha + docente
  const unidos = [];
  items.sort((a, b) => a.pedidoAt.localeCompare(b.pedidoAt)).forEach(it => {
    const igual = unidos.find(u => u.com === it.com && ((it.conv && u.conv === it.conv)
      || (u.definitivo === it.definitivo && (u.fechaTexto || u.pedidoAt.slice(0, 10)) === (it.fechaTexto || it.pedidoAt.slice(0, 10))
        && (!u.docente || !it.docente || sinTildes(u.docente) === sinTildes(it.docente)))));
    if (igual) {
      igual.origenes.push({ canal: it.canal, link: it.link, at: it.pedidoAt, autor: it.autor });
      if (!igual.docente) igual.docente = it.docente;
      if (!igual.conv && it.conv) { igual.conv = it.conv; igual.convLink = it.convLink; }
    } else unidos.push(Object.assign({}, it, { origenes: [{ canal: it.canal, link: it.link, at: it.pedidoAt, autor: it.autor }] }));
  });

  // 3) resolucion: un aviso posterior (en el canal o en el hilo) para la misma comision
  unidos.forEach(u => {
    const r = resoluciones.filter(x => x.com === u.com && x.at >= u.pedidoAt).sort((a, b) => a.at.localeCompare(b.at))[0];
    if (r) u.resolucion = r;
  });

  return { conectado: true, canales, items: unidos, resoluciones, error: errores.join(' · ') || undefined };
}

module.exports = { fetchCanales, _test: { comisiones, fechaDelTexto, leerAlertaStaff, RE_PEDIDO, RE_RESUELTO, RE_DEFINITIVO, RE_CANCELADA, sinTildes } };
