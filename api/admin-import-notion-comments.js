// ============================================================================
// FUNCION SERVERLESS DE UNA SOLA VEZ (pero segura de re-llamar): migra los
// comentarios/seguimiento del CRM de Relaciones Laborales en Notion (base
// "🔴 Tablero de seguimiento Académico de Perfiles") hacia los perfiles
// reales del tablero.
//
// Reglas (confirmadas por Andrea, set. 2026):
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
//  - Autor: "Automático" (nunca a nombre de una persona), para poder
//    identificar despues qué se cargó masivo. Categoria: sin categorizar
//    (la carga el equipo a mano, nunca se asigna sola).
//  - Es IDEMPOTENTE: cada comentario importado guarda un id estable
//    (hash de tarjeta+fecha+texto). Si se vuelve a correr este importador
//    (a proposito o por error), no duplica nada.
//
// Se llama por GET, en tandas (por si son muchas tarjetas y una sola
// llamada tarda demasiado): visitar
//   /api/admin-import-notion-comments?key=coderhouse-notion-import-2026
// y seguir visitando la URL con el "siguienteOffset" que devuelve cada vez
// (o automatizar eso con un ratito de espera entre llamados) hasta que
// devuelva "done": true.
// ============================================================================

const crypto = require('crypto');
const { getOverlay, setOverlay, personKey } = require('../lib/overlay');
const {
  getEnv, queryAllPages, detectEmail, getAllBlocks, splitDatedEntries,
  buildSummaryComment, bestDate, personKeyLocal,
} = require('../lib/notionSync');
const { getLiveAccountsIndex } = require('../lib/backofficeAccounts');

const SECRET = 'coderhouse-notion-import-2026';
const BATCH_SIZE_DEFAULT = 30;

function stableId(pageUrl, fecha, texto) {
  return crypto.createHash('sha1').update(String(pageUrl) + '|' + String(fecha || '') + '|' + String(texto).slice(0, 200)).digest('hex').slice(0, 16);
}

module.exports = async function handler(req, res) {
  try {
    if ((req.query && req.query.key) !== SECRET) {
      res.status(403).json({ error: 'Falta la clave (?key=...)' });
      return;
    }
    const env = getEnv();
    if (!env) {
      res.status(400).json({ error: 'Falta configurar NOTION_API_KEY (y opcionalmente NOTION_DATABASE_ID) en las Environment Variables de Vercel.' });
      return;
    }

    const offset = Math.max(0, parseInt((req.query && req.query.offset) || '0', 10) || 0);
    const limit = Math.max(1, Math.min(100, parseInt((req.query && req.query.limit) || String(BATCH_SIZE_DEFAULT), 10) || BATCH_SIZE_DEFAULT));

    // Chequeo EN VIVO (no la foto vieja de seed-staff.json) de que cuentas
    // reales existen HOY en el back office - es la condicion de seguridad
    // que aprobo Andrea: "solo escribir si se encuentra una cuenta real".
    // Si esto falla (o faltan las Environment Variables del back office),
    // FALLAMOS CERRADO: no se escribe nada en ningun perfil en esta corrida.
    const { indexByPersonKey, error: liveError } = await getLiveAccountsIndex();
    if (liveError) {
      res.status(200).json({ ok: false, error: 'No se pudo confirmar en vivo ninguna cuenta real, asi que no se escribio nada (por seguridad): ' + liveError });
      return;
    }

    const allCards = await queryAllPages(env);

    // Clasificacion (igual criterio que la auditoria previa): descartamos
    // sin mail y conflictos de mail antes de tocar nada.
    const candidatas = [];
    const descartadasSinMail = [];
    const conflictos = [];
    allCards.forEach(card => {
      const det = detectEmail(card);
      if (!det.finalEmail) { descartadasSinMail.push(card.url); return; }
      if (det.conflict) { conflictos.push({ url: card.url, staffTitle: card.staffTitle, perfilDash: card.perfilDash, pdEmails: det.pdEmails, staffEmails: det.staffEmails }); return; }
      candidatas.push({ card, email: det.finalEmail, source: det.source });
    });

    // De las candidatas (mail sin conflicto), separamos las que HOY no
    // tienen ninguna cuenta real confirmada en el back office - a esas NO
    // se les escribe nada, se listan aparte para que Andrea las revise (por
    // ejemplo, gente que ya no trabaja mas en Coderhouse y por eso no tiene
    // cuenta activa, o mails viejos/con errores de tipeo en la tarjeta de
    // Notion).
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

        // 1) Resumen de propiedades - siempre.
        const summaryText = buildSummaryComment(item.card);
        if (summaryText) {
          candidateEntries.push({ fecha: bestDate(item.card), texto: summaryText });
        }

        // 2) Cuerpo de la tarjeta, partido por marcador de fecha (si hay).
        let blocks = [];
        try { blocks = await getAllBlocks(item.card.pageId, env); } catch (e) { /* seguimos solo con el resumen */ }
        if (blocks.length) {
          const { entries } = splitDatedEntries(blocks);
          entries.forEach(e => {
            candidateEntries.push({ fecha: e.fecha || bestDate(item.card), texto: e.texto });
          });
        }

        let added = 0;
        candidateEntries.forEach(entry => {
          if (!entry.texto || !entry.texto.trim()) return;
          const id = stableId(item.card.url, entry.fecha, entry.texto);
          if (existingIds.has(id)) return; // ya importado antes, no duplicar
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
          // Orden cronologico (mas nuevo primero), igual que el resto del
          // tablero - no dependemos del orden en que se insertaron.
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
      sinCuentaReal: offset === 0 ? sinCuentaReal : undefined, // solo en la primera llamada, para no repetir - NO se les escribio nada
      totalDescartadasSinMail: descartadasSinMail.length,
      totalConflictos: conflictos.length,
      conflictos: offset === 0 ? conflictos : undefined, // solo en la primera llamada, para no repetir
      procesadasEnEstaTanda: tarjetasProcesadas,
      nuevosComentarios,
      errores,
      offset,
      siguienteOffset,
      done,
    });
  } catch (err) {
    res.status(200).json({ error: String(err && err.message ? err.message : err) });
  }
};
