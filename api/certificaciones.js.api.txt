// ============================================================================
// FUNCION SERVERLESS: solapa Certificaciones (interno)
// ============================================================================
// GET  -> devuelve todas las certificaciones (con el semaforo calculado para
//         las que estan "pendiente") + el banco de preguntas completo (con
//         las respuestas correctas, para la pantalla de "Gestionar
//         preguntas" - esto es interno, nunca se expone asi al publico).
// POST -> { action, payload } para: aprobar, desaprobar, habilitarDeNuevo
//         (certificaciones) y addPregunta / editPregunta / deletePregunta
//         (banco de preguntas).
//
// Cuando se aprueba una certificacion, se le agrega el curso+rol al perfil
// de la persona (mismo mecanismo que "Cursos habilitados a dictar" usa hoy).
// Aprobar y desaprobar disparan un mail automatico - ver enviarMailDecision:
// por ahora queda como un "stub" (no envia nada de verdad todavia) hasta que
// se defina que servicio de mail se va a usar; se deja el punto de enganche
// listo y documentado.
// ============================================================================

const { getOverlay, setOverlay, personKey, getAccountsForPerson } = require('../lib/overlay');
const { getAllCertificaciones, saveCertificacion, getAllPreguntas, getPreguntas, savePreguntas, genId } = require('../lib/certificaciones');
const { getPostHogRatings } = require('../lib/posthog');

const RATING_MINIMO = 4.7;
const DIAS_RECENCIA = 365;

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

async function fetchAssignmentsForAccount(env, userId) {
  const first = await apiGet(env.BASE, `/platform/staff/m2m/admin/assignments?userId=${userId}&page=1&limit=100`, env.STUDENT_KEY);
  let assignments = (first && first.items) || [];
  const totalPages = Math.min((first && first.totalPages) || 1, 20);
  if (totalPages > 1) {
    const proms = [];
    for (let p = 2; p <= totalPages; p++) {
      proms.push(apiGet(env.BASE, `/platform/staff/m2m/admin/assignments?userId=${userId}&page=${p}&limit=100`, env.STUDENT_KEY));
    }
    (await Promise.all(proms)).forEach(d => { assignments = assignments.concat((d && d.items) || []); });
  }
  return assignments;
}

function avgRating(ratings) {
  const vals = Object.values(ratings || {}).filter(v => typeof v === 'number' && v > 0);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// Para una persona (personKey), calcula: su rating actual (PostHog si tiene
// respuestas, si no el manual) y la fecha de su comision mas reciente
// (pasada, en curso o futura - lo que importa es que no haya pasado mucho
// tiempo desde la ultima vez que dio clase). Se usa solo para las
// certificaciones "pendiente", asi que el costo (llamadas a la API real) es
// bajo en la practica.
async function calcularSemaforo(email, overlay, env) {
  const ratingManual = avgRating(overlay.ratings);
  let ratingPromedio = ratingManual;
  try {
    const accounts = (await getAccountsForPerson(email)) || [];
    const emails = Array.from(new Set([email].concat(accounts.map(a => a.email).filter(Boolean))));
    const phMap = await getPostHogRatings([{ key: email, emails, commissionNumbers: [] }]);
    const ph = phMap[email];
    if (ph && ph.ratingCount > 0) ratingPromedio = ph.ratingPromedio;

    let ultimaFecha = null;
    if (accounts.length) {
      const assignmentsByAccount = await Promise.all(accounts.map(a => fetchAssignmentsForAccount(env, a.id)));
      let assignments = assignmentsByAccount.flat().filter(a => a.status !== 'CANCELLED');
      const cohortIds = Array.from(new Set(assignments.map(a => a.cohortId).filter(Boolean)));
      const cohorts = await Promise.all(cohortIds.map(id => apiGet(env.BASE, `/student/enrollment/m2m/admin/cohorts/${id}`, env.STUDENT_KEY)));
      cohorts.forEach(c => {
        if (!c || !c.startDate) return;
        const d = new Date(c.startDate);
        if (!ultimaFecha || d > ultimaFecha) ultimaFecha = d;
      });
    }

    const ahora = new Date();
    const diasDesde = ultimaFecha ? Math.round((ahora - ultimaFecha) / (1000 * 60 * 60 * 24)) : null;
    const recienteOk = diasDesde != null && diasDesde <= DIAS_RECENCIA;
    const ratingOk = ratingPromedio != null && ratingPromedio >= RATING_MINIMO;

    return {
      semaforo: (ratingOk && recienteOk) ? 'verde' : 'rojo',
      ratingPromedio,
      ratingOk,
      ultimaComisionFecha: ultimaFecha ? ultimaFecha.toISOString() : null,
      recienteOk,
    };
  } catch (e) {
    return { semaforo: 'rojo', ratingPromedio, ratingOk: false, ultimaComisionFecha: null, recienteOk: false, error: String(e && e.message ? e.message : e) };
  }
}

// Punto de enganche para el mail automatico de aprobacion/rechazo. Todavia
// no dispara nada de verdad (falta elegir un servicio de mail y sus
// credenciales) - queda el lugar listo para conectarlo sin tener que tocar
// el resto de la logica de aprobar/desaprobar.
async function enviarMailDecision(cert, decision) {
  // TODO: conectar un servicio de mail (Resend / SendGrid / el que se elija)
  // usando una Environment Variable con la API key, y armar aca el texto:
  //  - aprobado: puede mencionar el curso+rol.
  //  - desaprobado: mensaje generico, sin explicar el motivo especifico
  //    (rating, comentarios, evaluacion, necesidad de staff - varia segun el
  //    caso y no siempre es prudente decirlo).
  console.log('[certificaciones] TODO enviar mail de ' + decision + ' a', cert.email);
  return { enviado: false, motivo: 'Servicio de mail todavia no configurado' };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const env = getEnv();
      const certs = await getAllCertificaciones();
      const preguntas = await getAllPreguntas();

      const pendientes = certs.filter(c => c.estado === 'pendiente');
      const keysUnicas = Array.from(new Set(pendientes.map(c => personKey(c.email))));
      const overlaysPorKey = {};
      await Promise.all(keysUnicas.map(async key => { overlaysPorKey[key] = await getOverlay(key); }));

      const semaforoPorCert = {};
      await Promise.all(pendientes.map(async c => {
        const key = personKey(c.email);
        semaforoPorCert[c.id] = await calcularSemaforo(key, overlaysPorKey[key] || { ratings: {} }, env);
      }));

      const certsConSemaforo = certs.map(c => ({
        ...c,
        checklist: c.estado === 'pendiente' ? semaforoPorCert[c.id] : null,
      }));

      res.status(200).json({
        certificaciones: certsConSemaforo,
        preguntas,
        ratingMinimo: RATING_MINIMO,
        diasRecencia: DIAS_RECENCIA,
      });
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Metodo no permitido' });
      return;
    }

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    const action = body.action;
    const payload = body.payload || {};

    switch (action) {
      case 'aprobar': {
        const certs = await getAllCertificaciones();
        const cert = certs.find(c => c.id === payload.id);
        if (!cert) { res.status(400).json({ error: 'No se encontro esa certificacion' }); return; }
        cert.estado = 'aprobado';
        cert.fechaDecision = new Date().toISOString();
        await saveCertificacion(cert);

        // Se agrega el curso+rol al perfil, igual que "Cursos habilitados a
        // dictar" cuando se hace a mano.
        const key = personKey(cert.email);
        const overlay = await getOverlay(key);
        overlay.cursosHabilitados = overlay.cursosHabilitados || [];
        const yaExiste = overlay.cursosHabilitados.some(c => c.curso.toLowerCase() === cert.curso.toLowerCase() && c.rol === cert.rol);
        if (!yaExiste) overlay.cursosHabilitados.push({ curso: cert.curso, rol: cert.rol });
        await setOverlay(key, overlay);

        const mail = await enviarMailDecision(cert, 'aprobado');
        res.status(200).json({ ok: true, cert, mail });
        return;
      }
      case 'desaprobar': {
        const certs = await getAllCertificaciones();
        const cert = certs.find(c => c.id === payload.id);
        if (!cert) { res.status(400).json({ error: 'No se encontro esa certificacion' }); return; }
        cert.estado = 'desaprobado';
        cert.fechaDecision = new Date().toISOString();
        const hoy = new Date();
        cert.cooldownHasta = new Date(hoy.getFullYear(), hoy.getMonth() + 3, hoy.getDate()).toISOString();
        await saveCertificacion(cert);
        const mail = await enviarMailDecision(cert, 'desaprobado');
        res.status(200).json({ ok: true, cert, mail });
        return;
      }
      case 'habilitarDeNuevo': {
        const certs = await getAllCertificaciones();
        const cert = certs.find(c => c.id === payload.id);
        if (!cert) { res.status(400).json({ error: 'No se encontro esa certificacion' }); return; }
        cert.cooldownHasta = null;
        cert.reintentoHabilitadoManual = true;
        await saveCertificacion(cert);
        res.status(200).json({ ok: true, cert });
        return;
      }
      case 'addPregunta': {
        const { curso, rol, texto, opciones, correcta, puntaje } = payload;
        if (!curso || !rol || !texto || !Array.isArray(opciones) || opciones.length < 2) {
          res.status(400).json({ error: 'Faltan datos de la pregunta (curso, rol, texto, al menos 2 opciones)' });
          return;
        }
        if (!Number.isInteger(correcta) || correcta < 0 || correcta >= opciones.length) {
          res.status(400).json({ error: 'La opcion correcta no es valida' });
          return;
        }
        const lista = await getPreguntas(curso, rol);
        lista.push({ id: genId(), texto: String(texto).trim(), opciones: opciones.map(o => String(o).trim()), correcta, puntaje: Number(puntaje) > 0 ? Number(puntaje) : 1 });
        await savePreguntas(curso, rol, lista);
        res.status(200).json({ ok: true, preguntas: lista });
        return;
      }
      case 'editPregunta': {
        const { curso, rol, id, texto, opciones, correcta, puntaje } = payload;
        if (!curso || !rol || !id) { res.status(400).json({ error: 'Faltan datos' }); return; }
        const lista = await getPreguntas(curso, rol);
        const idx = lista.findIndex(p => p.id === id);
        if (idx === -1) { res.status(400).json({ error: 'No se encontro esa pregunta' }); return; }
        if (texto != null) lista[idx].texto = String(texto).trim();
        if (Array.isArray(opciones) && opciones.length >= 2) lista[idx].opciones = opciones.map(o => String(o).trim());
        if (Number.isInteger(correcta) && correcta >= 0 && correcta < lista[idx].opciones.length) lista[idx].correcta = correcta;
        if (Number(puntaje) > 0) lista[idx].puntaje = Number(puntaje);
        await savePreguntas(curso, rol, lista);
        res.status(200).json({ ok: true, preguntas: lista });
        return;
      }
      case 'deletePregunta': {
        const { curso, rol, id } = payload;
        if (!curso || !rol || !id) { res.status(400).json({ error: 'Faltan datos' }); return; }
        const lista = (await getPreguntas(curso, rol)).filter(p => p.id !== id);
        await savePreguntas(curso, rol, lista);
        res.status(200).json({ ok: true, preguntas: lista });
        return;
      }
      default:
        res.status(400).json({ error: 'Accion invalida' });
    }
  } catch (err) {
    res.status(200).json({ error: String(err && err.message ? err.message : err) });
  }
};
