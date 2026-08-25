// ============================================================================
// FUNCION SERVERLESS: guardar cambios en un perfil de Staff
// ============================================================================
// Recibe { email, action, payload } por POST y actualiza la base de datos
// propia del tablero. Todas las acciones devuelven el overlay actualizado.
// ============================================================================

const { getOverlay, setOverlay } = require('../lib/overlay');

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
        if (!['aprobado', 'desaprobado', 'futuro'].includes(payload.estado)) {
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
