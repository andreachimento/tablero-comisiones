// ============================================================================
// FUNCION SERVERLESS DE UNA SOLA VEZ: importa las postulaciones que ya
// estaban cargadas en la planilla de Google Sheets al momento de armar esto
// (data/postulaciones-seed.json, ya resueltas contra el back office real por
// Claude) a la base de datos real del tablero.
//
// Se llama UNA vez visitando esta URL en el navegador (GET, con la clave).
// Es seguro llamarla mas de una vez por error: no duplica postulaciones ni
// pisa el estado (pendiente/aprobada/rechazada) de una que Andrea ya haya
// revisado desde el tablero - ver upsertPostulacionesFromSheet en
// lib/overlay.js.
//
// Esto cubre las postulaciones que YA ESTABAN en la planilla en el momento
// de generar data/postulaciones-seed.json. Para las que lleguen DESPUES,
// hay que repetir el proceso (pedirle a Claude que vuelva a leer la
// planilla y regenere este archivo) hasta que se resuelva la sincronizacion
// automatica de una vez por hora (ver la conversacion sobre las opciones
// A/B/C para eso).
// ============================================================================

const { upsertPostulacionesFromSheet } = require('../lib/overlay');
const seed = require('../data/postulaciones-seed.json');

module.exports = async function handler(req, res) {
  try {
    if ((req.query && req.query.key) !== 'coderhouse-postulaciones-2026') {
      res.status(403).json({ error: 'Falta la clave (?key=...)' });
      return;
    }

    const resultado = await upsertPostulacionesFromSheet(seed);
    res.status(200).json({
      ok: true,
      totalProcesadas: seed.length,
      nuevas: resultado.nuevas,
      actualizadas: resultado.actualizadas,
    });
  } catch (err) {
    res.status(200).json({ error: String(err && err.message ? err.message : err) });
  }
};
