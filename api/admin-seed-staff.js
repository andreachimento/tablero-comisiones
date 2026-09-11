// ============================================================================
// FUNCION SERVERLESS "administrativa" DE UNA SOLA VEZ (pero segura de
// re-llamar) - agrupa DOS tareas puntuales en un solo archivo, para no
// sumar mas funciones serverless de las 12 que permite el plan Hobby de
// Vercel de este proyecto (ya estaba en el limite):
//
//  - job por defecto (sin ?job=, o ?job=seed-staff): importar la base de
//    profesores/tutores del Excel de Andrea (data/seed-staff.json) a la
//    base de datos real del tablero. Es la funcion original de este
//    archivo - ver mas abajo (handleSeedStaff).
//  - ?job=import-notion-comments: migracion (una sola vez, en tandas) del
//    CRM de Relaciones Laborales de Notion hacia los perfiles reales del
//    tablero. Antes vivia en su propio archivo
//    (api/admin-import-notion-comments.js) - ver handleImportNotionComments
//    mas abajo para el detalle completo de sus reglas.
//
// Cada job tiene su propia clave (?key=...), completamente separadas entre
// si - no comparten secreto.
// ============================================================================

const crypto = require('crypto');
const { getAllOverlays, getOverlay, setOverlay, defaultOverlay, personKey, OVERLAY_KEY } = require('../lib/overlay');
const { getRedis } = require('../lib/redis');
const seed = require('../data/seed-staff.json');
const {
  getEnv: getNotionEnv, queryAllPages, detectEmail, getAllBlocks, splitDatedEntries,
  buildSummaryComment, bestDate, personKeyLocal,
} = require('../lib/notionSync');
const { getLiveAccountsIndex } = require('../lib/backofficeAccounts');

const NOTION_IMPORT_SECRET = 'coderhouse-notion-import-2026';
const NOTION_IMPORT_BATCH_SIZE_DEFAULT = 30;

function stableNotionId(pageUrl, fecha, texto) {
  return crypto.createHash('sha1').update(String(pageUrl) + '|' + String(fecha || '') + '|' + String(texto).slice(0, 200)).digest('hex').slice(0, 16);
}

// ----------------------------------------------------------------------------
// job=import-notion-comments (antes api/admin-import-notion-comments.js) -
// reglas completas (confirmadas por Andrea, set. 2026):
//  - El mail de cada tarjeta se busca primero en "Perfil Dash" y despues en
//    el titulo (Staff). Si no aparece en ninguno de los dos, la tarjeta se
//    DESCARTA (no se carga nada).
//  - Si "Perfil Dash" y el titulo tienen mails de BASE distinta (no es solo
//    un +tag distinto), la tarjeta se considera un conflicto y tambien se
//    DESCARTA - no se adivina a quien pertenece.
//  - Antes de escribir nada, se confirma EN VIVO (contra el back office real
//    de Coderhouse, no una foto vieja) que existe al menos una cuenta real
//    para ese mail. Si no se encuentra ninguna cuenta real, tampoco se
//    escribe nada - se lista aparte ("sinCuentaReal") para que Andrea la
//    revise a mano. Si no se puede confirmar nada en vivo (faltan las
//    Environment Variables del back office, o falla la consulta), la
//    corrida entera se corta sin escribir nada, por seguridad.
//  - Cada entrada fechada dentro del cuerpo de la tarjeta se sube como un
//    comentario PROPIO (no se mezclan varias fechas en un solo comentario),
//    con el texto tal cual esta escrito (no se parafrasea).
//  - Ademas, SIEMPRE se agrega un comentario extra con el resumen de las
//    propiedades de la tarjeta (Estado / Motivos / Curso / Rol), porque en
//    la mayoria de las tarjetas viejas esa es toda la informacion que hay
//    (el cuerpo esta vacio).
//  - Autor: "Automático" (nunca a nombre de una persona). Categoria: sin
//    categorizar (la carga el equipo a mano, nunca se asigna sola).
//  - Es IDEMPOTENTE: cada comentario importado guarda un id estable
//    (hash de tarjeta+fecha+texto). Si se vuelve a correr este importador
//    (a proposito o por error), no duplica nada.
//
// Se llama por GET, en tandas: visitar
//   /api/admin-seed-staff?job=import-notion-comments&key=coderhouse-notion-import-2026
// y seguir visitando la URL con el "siguienteOffset" que devuelve cada vez
// hasta que devuelva "done": true.
// ----------------------------------------------------------------------------
async function handleImportNotionComments(req, res) {
  if ((req.query && req.query.key) !== NOTION_IMPORT_SECRET) {
    res.status(403).json({ error: 'Falta la clave (?key=...)' });
    return;
  }
  const notionEnv = getNotionEnv();
  if (!notionEnv) {
    res.status(400).json({ error: 'Falta configurar NOTION_API_KEY (y opcionalmente NOTION_DATABASE_ID) en las Environment Variables de Vercel.' });
    return;
  }

  const offset = Math.max(0, parseInt((req.query && req.query.offset) || '0', 10) || 0);
  const limit = Math.max(1, Math.min(100, parseInt((req.query && req.query.limit) || String(NOTION_IMPORT_BATCH_SIZE_DEFAULT), 10) || NOTION_IMPORT_BATCH_SIZE_DEFAULT));

  // Chequeo EN VIVO (no la foto vieja de seed-staff.json) de que cuentas
  // reales existen HOY en el back office - condicion de seguridad aprobada
  // por Andrea: "solo escribir si se encuentra una cuenta real". Si falla,
  // FALLAMOS CERRADO: no se escribe nada en ningun perfil en esta corrida.
  const { indexByPersonKey, error: liveError } = await getLiveAccountsIndex();
  if (liveError) {
    res.status(200).json({ ok: false, error: 'No se pudo confirmar en vivo ninguna cuenta real, asi que no se escribio nada (por seguridad): ' + liveError });
    return;
  }

  const allCards = await queryAllPages(notionEnv);

  const candidatas = [];
  const descartadasSinMail = [];
  const conflictos = [];
  allCards.forEach(card => {
    const det = detectEmail(card);
    if (!det.finalEmail) { descartadasSinMail.push(card.url); return; }
    if (det.conflict) { conflictos.push({ url: card.url, staffTitle: card.staffTitle, perfilDash: card.perfilDash, pdEmails: det.pdEmails, staffEmails: det.staffEmails }); return; }
    candidatas.push({ card, email: det.finalEmail, source: det.source });
  });

  const sinCuentaReal = [];
  const candidatasConCuenta = [];
  candidatas.forEach(item => {
    const key = personKeyLocal(item.email);
    const accounts = indexByPersonKey.get(key);
    if (accounts && accounts.length) candidatasConCuenta.push(item);
    else sinCuentaReal.push({ url: item.card.url, staffTitle: item.card.staffTitle, email: item.email });
  });

  const slice = candidatasConCuenta.slice(offset, offset + limit);

  let nuevosComentarios = 0;
  let tarjetasProcesadas = 0;
  const errores = [];

  for (const item of slice) {
    try {
      const key = personKey(item.email);
      const overlay = await getOverlay(key);
      overlay.comentarios = overlay.comentarios || [];
      const existingIds = new Set(overlay.comentarios.map(c => c.notionEntryId).filter(Boolean));

      const candidateEntries = [];
      const summaryText = buildSummaryComment(item.card);
      if (summaryText) candidateEntries.push({ fecha: bestDate(item.card), texto: summaryText });

      let blocks = [];
      try { blocks = await getAllBlocks(item.card.pageId, notionEnv); } catch (e) { /* seguimos solo con el resumen */ }
      if (blocks.length) {
        const { entries } = splitDatedEntries(blocks);
        entries.forEach(e => candidateEntries.push({ fecha: e.fecha || bestDate(item.card), texto: e.texto }));
      }

      let added = 0;
      candidateEntries.forEach(entry => {
        if (!entry.texto || !entry.texto.trim()) return;
        const id = stableNotionId(item.card.url, entry.fecha, entry.texto);
        if (existingIds.has(id)) return;
        existingIds.add(id);
        overlay.comentarios.push({
          texto: entry.texto,
          autor: 'Automático',
          fecha: entry.fecha ? (entry.fecha + 'T00:00:00.000Z') : new Date().toISOString(),
          categoria: null,
          origenNotion: true,
          notionUrl: item.card.url,
          notionEntryId: id,
        });
        added++;
      });

      if (added) {
        overlay.comentarios.sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')));
        await setOverlay(key, overlay);
        nuevosComentarios += added;
      }
      tarjetasProcesadas++;
    } catch (e) {
      errores.push({ url: item.card.url, error: String(e && e.message ? e.message : e) });
    }
  }

  const siguienteOffset = offset + slice.length;
  const done = siguienteOffset >= candidatasConCuenta.length;

  res.status(200).json({
    ok: true,
    totalTarjetas: allCards.length,
    totalCandidatas: candidatas.length,
    totalConCuentaRealConfirmada: candidatasConCuenta.length,
    totalSinCuentaReal: sinCuentaReal.length,
    sinCuentaReal: offset === 0 ? sinCuentaReal : undefined,
    totalDescartadasSinMail: descartadasSinMail.length,
    totalConflictos: conflictos.length,
    conflictos: offset === 0 ? conflictos : undefined,
    procesadasEnEstaTanda: tarjetasProcesadas,
    nuevosComentarios,
    errores,
    offset,
    siguienteOffset,
    done,
  });
}

// ----------------------------------------------------------------------------
// job por defecto: importar la base de profesores/tutores del Excel de
// Andrea (data/seed-staff.json, ya calculado a partir del archivo original)
// a la base de datos real del tablero.
//
// Se llama UNA vez visitando esta URL en el navegador (GET). Es seguro
// llamarla mas de una vez por error: no duplica cursos ni pisa datos que ya
// se hayan cargado a mano (comentarios, estado, ratings), solo agrega los
// cursos habilitados del Excel que todavia no esten cargados.
// ----------------------------------------------------------------------------
async function handleSeedStaff(req, res) {
  try {
    if ((req.query && req.query.key) !== 'coderhouse-seed-2026') {
      res.status(403).json({ error: 'Falta la clave (?key=...)' });
      return;
    }

    const existing = await getAllOverlays();
    const redis = getRedis();

    let created = 0, merged = 0, cursosAgregados = 0;
    const updates = {};

    // IMPORTANTE: se agrupa por personKey (mail sin el "+tag"), no por el
    // mail tal cual viene en el Excel. Una misma persona suele aparecer en
    // el Excel varias veces con distinto "+tag" (ej. una fila para su rol
    // de profesor, otra para tutor) - si se guardara cada fila por separado
    // quedarian varias entradas sueltas para la misma persona en vez de una
    // sola unificada (el listado de Staff las termina unificando de todos
    // modos la primera vez que se abre, pero mejor guardarlas ya unificadas
    // desde el importador para no depender de ese paso extra).
    const porPersona = {};
    seed.forEach(entry => {
      const rawEmail = String(entry.email || '').toLowerCase().trim();
      if (!rawEmail) return;
      const key = personKey(rawEmail);
      if (!porPersona[key]) porPersona[key] = [];
      porPersona[key].push(entry);
    });

    Object.keys(porPersona).forEach(key => {
      const entradas = porPersona[key];
      let overlay = existing[key];
      if (overlay) {
        merged++;
      } else {
        overlay = defaultOverlay();
        created++;
      }

      overlay.cursosHabilitados = overlay.cursosHabilitados || [];

      entradas.forEach(entry => {
        overlay.esDash = overlay.esDash || !!entry.esDash;
        if (entry.esDash) {
          if (!overlay.nombre) overlay.nombre = entry.nombre || '';
          if (!overlay.apellido) overlay.apellido = entry.apellido || '';
        }
        (entry.cursosHabilitados || []).forEach(c => {
          const yaExiste = overlay.cursosHabilitados.some(x => x.curso.toLowerCase() === c.curso.toLowerCase() && x.rol === c.rol);
          if (!yaExiste) { overlay.cursosHabilitados.push(c); cursosAgregados++; }
        });
      });

      updates[key] = JSON.stringify(overlay);
    });

    // Escribimos todo en tandas de 200 campos por llamada (en vez de una
    // llamada de red por persona) para que esto termine en pocos segundos.
    const entries = Object.entries(updates);
    const BATCH = 200;
    for (let i = 0; i < entries.length; i += BATCH) {
      const chunk = Object.fromEntries(entries.slice(i, i + BATCH));
      await redis.hset(OVERLAY_KEY, chunk);
    }

    res.status(200).json({
      ok: true,
      totalProcesados: seed.length,
      perfilesNuevos: created,
      perfilesFusionados: merged,
      cursosAgregados,
    });
  } catch (err) {
    res.status(200).json({ error: String(err && err.message ? err.message : err) });
  }
}

module.exports = async function handler(req, res) {
  const job = (req.query && req.query.job) || 'seed-staff';
  if (job === 'import-notion-comments') {
    await handleImportNotionComments(req, res);
    return;
  }
  await handleSeedStaff(req, res);
};
