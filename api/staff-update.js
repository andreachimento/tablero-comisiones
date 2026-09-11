// ============================================================================
// FUNCION SERVERLESS: guardar cambios en un perfil de Staff
// ============================================================================
// Recibe { email, action, payload } por POST y actualiza la base de datos
// propia del tablero. Todas las acciones devuelven el overlay actualizado.
// ============================================================================

const crypto = require('crypto');
const { getOverlay, setOverlay, CATEGORIA_COMENTARIO_VALUES } = require('../lib/overlay');
// Sincronizacion con el CRM de Relaciones Laborales de Notion (accion
// 'syncNotionComments' mas abajo). Vive ACA adentro (y no en su propio
// archivo api/staff-comments-sync.js, como se penso originalmente) para no
// sumar una funcion serverless mas: el plan Hobby de Vercel de este proyecto
// tiene un tope de 12 funciones por deploy, y ya estaba al limite.
const {
  getEnv: getNotionEnv, queryAllPages, detectEmail, getAllBlocks, splitDatedEntries,
  buildSummaryComment, bestDate, personKeyLocal,
} = require('../lib/notionSync');

function stableNotionId(pageUrl, fecha, texto) {
  return crypto.createHash('sha1').update(String(pageUrl) + '|' + String(fecha || '') + '|' + String(texto).slice(0, 200)).digest('hex').slice(0, 16);
}

// Valores permitidos para la disponibilidad (dias y franjas horarias que
// contesta la gente en la encuesta que va a mandar Andrea). Se cargan a
// mano en el perfil por ahora, en base a esas respuestas. Si el equipo
// cambia las opciones de la encuesta, hay que actualizar esta misma lista
// en index.html (donde se muestran los checkboxes).
const DIAS_DISPONIBLES = ['Lunes', 'Martes', 'Miercoles', 'Jueves', 'Viernes', 'Sabado'];
const FRANJAS_DISPONIBLES = ['7:30-10:00hs', '10:00-12:00hs', '11:00-13:00hs', '18:30-21:00hs', '19:00-21:00hs', '20:30-22:30hs'];

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Metodo no permitido, usar POST' });
    return;
  }
  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body || {};

    const email = String(body.email || '').toLowerCase().trim();
    const action = body.action;
    const payload = body.payload || {};

    if (!email || !action) {
      res.status(400).json({ error: 'Faltan los campos email o action' });
      return;
    }

    const overlay = await getOverlay(email);
    overlay.comentarios = overlay.comentarios || [];
    overlay.cursosHabilitados = overlay.cursosHabilitados || [];
    overlay.ratings = overlay.ratings || {};
    overlay.disponibilidad = overlay.disponibilidad || { dias: [], franjas: [] };

    switch (action) {
      case 'setEstado': {
        if (!['aprobado', 'desaprobado', 'futuro', 'renuncia'].includes(payload.estado)) {
          res.status(400).json({ error: 'Estado invalido' });
          return;
        }
        overlay.estado = payload.estado;
        break;
      }
      case 'addComentario': {
        const texto = String(payload.texto || '').trim();
        const autor = String(payload.autor || '').trim();
        if (!texto) {
          res.status(400).json({ error: 'El comentario esta vacio' });
          return;
        }
        if (!autor) {
          res.status(400).json({ error: 'Falta indicar quien escribe el comentario' });
          return;
        }
        overlay.comentarios.unshift({
          texto,
          autor,
          fecha: new Date().toISOString(),
          categoria: null,
        });
        break;
      }
      case 'editComentario': {
        const index = Number(payload.index);
        const texto = String(payload.texto || '').trim();
        if (!texto) {
          res.status(400).json({ error: 'El comentario no puede quedar vacio' });
          return;
        }
        if (!Number.isInteger(index) || index < 0 || index >= overlay.comentarios.length) {
          res.status(400).json({ error: 'No se encontro ese comentario' });
          return;
        }
        overlay.comentarios[index].texto = texto;
        overlay.comentarios[index].editado = true;
        overlay.comentarios[index].fechaEdicion = new Date().toISOString();
        break;
      }
      case 'setComentarioCategoria': {
        // Subcategoria manual (No asignable / Asignable con alerta /
        // Asignable / sin categorizar) - SIEMPRE la carga una persona a
        // mano, nunca se asigna sola (ni al importar de Notion ni al
        // sincronizar comentarios nuevos).
        const index = Number(payload.index);
        if (!Number.isInteger(index) || index < 0 || index >= overlay.comentarios.length) {
          res.status(400).json({ error: 'No se encontro ese comentario' });
          return;
        }
        const categoria = payload.categoria == null || payload.categoria === '' ? null : String(payload.categoria);
        if (categoria !== null && !CATEGORIA_COMENTARIO_VALUES.includes(categoria)) {
          res.status(400).json({ error: 'Categoria invalida' });
          return;
        }
        overlay.comentarios[index].categoria = categoria;
        break;
      }
      case 'deleteComentario': {
        const index = Number(payload.index);
        if (!Number.isInteger(index) || index < 0 || index >= overlay.comentarios.length) {
          res.status(400).json({ error: 'No se encontro ese comentario' });
          return;
        }
        overlay.comentarios.splice(index, 1);
        break;
      }
      case 'addCurso': {
        const curso = String(payload.curso || '').trim();
        const rol = payload.rol;
        if (!curso || !['profesor', 'tutor'].includes(rol)) {
          res.status(400).json({ error: 'Curso o rol invalido' });
          return;
        }
        const yaExiste = overlay.cursosHabilitados.some(c => c.curso.toLowerCase() === curso.toLowerCase() && c.rol === rol);
        if (!yaExiste) overlay.cursosHabilitados.push({ curso, rol });
        break;
      }
      case 'removeCurso': {
        const curso = String(payload.curso || '');
        const rol = payload.rol;
        overlay.cursosHabilitados = overlay.cursosHabilitados.filter(c => !(c.curso === curso && c.rol === rol));
        break;
      }
      case 'setRating': {
        const cohortId = payload.cohortId;
        const rating = Number(payload.rating);
        if (!cohortId || !(rating >= 1 && rating <= 5)) {
          res.status(400).json({ error: 'Rating invalido' });
          return;
        }
        overlay.ratings[cohortId] = rating;
        break;
      }
      case 'setDisponibilidad': {
        const dias = Array.isArray(payload.dias) ? payload.dias.filter(d => DIAS_DISPONIBLES.includes(d)) : [];
        const franjas = Array.isArray(payload.franjas) ? payload.franjas.filter(f => FRANJAS_DISPONIBLES.includes(f)) : [];
        overlay.disponibilidad = { dias, franjas };
        break;
      }
      case 'syncNotionComments': {
        // Busca en Notion todas las tarjetas cuyo mail (Perfil Dash o
        // titulo) pertenezca a esta misma persona (mismo mail base, sin
        // importar el +tag), y agrega como comentarios nuevos ("Automático",
        // sin categorizar) cualquier entrada que todavia no se hubiera
        // importado - tanto de la migracion inicial como de un sync
        // anterior. Nunca duplica (cada entrada tiene un id estable) y
        // nunca toca comentarios ya existentes. Se llama desde el boton
        // "Actualizar comentarios" del perfil, y desde el auto-refresh cada
        // 5 minutos mientras el perfil este abierto - ver index.html.
        const notionEnv = getNotionEnv();
        if (!notionEnv) {
          res.status(200).json({ ok: false, configurado: false, mensaje: 'La sincronización con Notion todavía no está configurada (falta NOTION_API_KEY en Vercel).' });
          return;
        }
        const targetKey = personKeyLocal(email);
        const allCards = await queryAllPages(notionEnv);
        const matching = [];
        allCards.forEach(card => {
          const det = detectEmail(card);
          if (!det.finalEmail || det.conflict) return; // igual criterio que la migracion masiva
          if (personKeyLocal(det.finalEmail) === targetKey) matching.push(card);
        });

        const existingIds = new Set(overlay.comentarios.map(c => c.notionEntryId).filter(Boolean));
        let added = 0;
        for (const card of matching) {
          const candidateEntries = [];
          const summaryText = buildSummaryComment(card);
          if (summaryText) candidateEntries.push({ fecha: bestDate(card), texto: summaryText });

          let blocks = [];
          try { blocks = await getAllBlocks(card.pageId, notionEnv); } catch (e) { /* seguimos solo con el resumen */ }
          if (blocks.length) {
            const { entries } = splitDatedEntries(blocks);
            entries.forEach(e => candidateEntries.push({ fecha: e.fecha || bestDate(card), texto: e.texto }));
          }

          candidateEntries.forEach(entry => {
            if (!entry.texto || !entry.texto.trim()) return;
            const id = stableNotionId(card.url, entry.fecha, entry.texto);
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
          await setOverlay(email, overlay);
        }
        res.status(200).json({ ok: true, configurado: true, nuevosComentarios: added, tarjetasEncontradas: matching.length, comentarios: overlay.comentarios });
        return;
      }
      case 'setNombreDash': {
        // Solo tiene sentido para perfiles "extraidos de Dash" (sin cuenta
        // real todavia), para poder corregir el nombre que se adivino a
        // partir del mail.
        if (payload.nombre != null) overlay.nombre = String(payload.nombre).trim();
        if (payload.apellido != null) overlay.apellido = String(payload.apellido).trim();
        break;
      }
      default:
        res.status(400).json({ error: 'Accion desconocida: ' + action });
        return;
    }

    await setOverlay(email, overlay);
    res.status(200).json({ ok: true, overlay });
  } catch (err) {
    res.status(200).json({ error: String(err && err.message ? err.message : err) });
  }
};
