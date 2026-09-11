// ============================================================================
// FUNCION SERVERLESS: sincronizar los comentarios de UN perfil puntual con
// el CRM de Relaciones Laborales en Notion (boton "Actualizar comentarios"
// del perfil, + auto-refresh cada 5 minutos mientras el perfil esta
// abierto - ver index.html).
//
// Busca en Notion todas las tarjetas cuyo mail (Perfil Dash o titulo)
// pertenezca a esta misma persona (mismo mail base, sin importar el
// +tag), y agrega como comentarios nuevos ("Automático", sin categorizar)
// cualquier entrada que todavia no se hubiera importado - tanto de una
// migracion previa como de un sync anterior. Nunca duplica (cada entrada
// tiene un id estable) y nunca toca comentarios ya existentes.
//
// Si no esta configurado NOTION_API_KEY, devuelve ok:false con un mensaje
// claro en vez de romper - el resto del perfil sigue funcionando igual.
// ============================================================================

const crypto = require('crypto');
const { getOverlay, setOverlay, personKey } = require('../lib/overlay');
const {
  getEnv, queryAllPages, detectEmail, getAllBlocks, splitDatedEntries,
  buildSummaryComment, bestDate, personKeyLocal,
} = require('../lib/notionSync');

function stableId(pageUrl, fecha, texto) {
  return crypto.createHash('sha1').update(String(pageUrl) + '|' + String(fecha || '') + '|' + String(texto).slice(0, 200)).digest('hex').slice(0, 16);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Metodo no permitido, usar POST' });
    return;
  }
  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    const email = String(body.email || '').toLowerCase().trim();
    if (!email) { res.status(400).json({ error: 'Falta el email' }); return; }

    const env = getEnv();
    if (!env) {
      res.status(200).json({ ok: false, configurado: false, mensaje: 'La sincronización con Notion todavía no está configurada (falta NOTION_API_KEY en Vercel).' });
      return;
    }

    const targetKey = personKeyLocal(email);
    const allCards = await queryAllPages(env);
    const matching = [];
    allCards.forEach(card => {
      const det = detectEmail(card);
      if (!det.finalEmail || det.conflict) return; // igual criterio que la migracion masiva
      if (personKeyLocal(det.finalEmail) === targetKey) matching.push(card);
    });

    const key = personKey(email);
    const overlay = await getOverlay(key);
    overlay.comentarios = overlay.comentarios || [];
    const existingIds = new Set(overlay.comentarios.map(c => c.notionEntryId).filter(Boolean));

    let added = 0;
    for (const card of matching) {
      const candidateEntries = [];
      const summaryText = buildSummaryComment(card);
      if (summaryText) candidateEntries.push({ fecha: bestDate(card), texto: summaryText });

      let blocks = [];
      try { blocks = await getAllBlocks(card.pageId, env); } catch (e) { /* seguimos solo con el resumen */ }
      if (blocks.length) {
        const { entries } = splitDatedEntries(blocks);
        entries.forEach(e => candidateEntries.push({ fecha: e.fecha || bestDate(card), texto: e.texto }));
      }

      candidateEntries.forEach(entry => {
        if (!entry.texto || !entry.texto.trim()) return;
        const id = stableId(card.url, entry.fecha, entry.texto);
        if (existingIds.has(id)) return;
        existingIds.add(id);
        overlay.comentarios.push({
          texto: entry.texto,
          autor: 'Automático',
          fecha: entry.fecha ? (entry.fecha + 'T00:00:00.000Z') : new Date().toISOString(),
          categoria: null,
          origenNotion: true,
          notionUrl: card.url,
          notionEntryId: id,
        });
        added++;
      });
    }

    if (added) {
      overlay.comentarios.sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')));
      await setOverlay(key, overlay);
    }

    res.status(200).json({ ok: true, configurado: true, nuevosComentarios: added, tarjetasEncontradas: matching.length, comentarios: overlay.comentarios });
  } catch (err) {
    res.status(200).json({ error: String(err && err.message ? err.message : err) });
  }
};
