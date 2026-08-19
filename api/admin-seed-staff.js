// ============================================================================
// FUNCION SERVERLESS DE UNA SOLA VEZ: importar la base de profesores/tutores
// del Excel de Andrea (data/seed-staff.json, ya calculado a partir del
// archivo original) a la base de datos real del tablero.
//
// Se llama UNA vez visitando esta URL en el navegador (GET). Es seguro
// llamarla mas de una vez por error: no duplica cursos ni pisa datos que ya
// se hayan cargado a mano (comentarios, estado, ratings), solo agrega los
// cursos habilitados del Excel que todavia no esten cargados.
//
// Una vez importado, este archivo se puede borrar del repo (no hace falta
// para el funcionamiento normal del tablero).
// ============================================================================

const { getAllOverlays, defaultOverlay, OVERLAY_KEY } = require('../lib/overlay');
const { getRedis } = require('../lib/redis');
const seed = require('../data/seed-staff.json');

module.exports = async function handler(req, res) {
  try {
    if ((req.query && req.query.key) !== 'coderhouse-seed-2026') {
      res.status(403).json({ error: 'Falta la clave (?key=...)' });
      return;
    }

    const existing = await getAllOverlays();
    const redis = getRedis();

    let created = 0, merged = 0, cursosAgregados = 0;
    const updates = {};

    for (const entry of seed) {
      const email = String(entry.email || '').toLowerCase().trim();
      if (!email) continue;

      let overlay = existing[email];
      if (overlay) {
        merged++;
      } else {
        overlay = defaultOverlay();
        created++;
      }

      overlay.esDash = overlay.esDash || !!entry.esDash;
      if (entry.esDash) {
        if (!overlay.nombre) overlay.nombre = entry.nombre || '';
        if (!overlay.apellido) overlay.apellido = entry.apellido || '';
      }

      overlay.cursosHabilitados = overlay.cursosHabilitados || [];
      (entry.cursosHabilitados || []).forEach(c => {
        const yaExiste = overlay.cursosHabilitados.some(x => x.curso.toLowerCase() === c.curso.toLowerCase() && x.rol === c.rol);
        if (!yaExiste) { overlay.cursosHabilitados.push(c); cursosAgregados++; }
      });

      updates[email] = JSON.stringify(overlay);
    }

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
};
