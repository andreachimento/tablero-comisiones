// ============================================================================
// FUNCION SERVERLESS: sincroniza las postulaciones desde la planilla de
// Google Sheets del sitio publico hacia el tablero. La dispara sola el cron
// de Vercel una vez por hora (ver la seccion "crons" de vercel.json), pero
// tambien se puede abrir a mano en el navegador para forzar una sincronizada
// inmediata: /api/postulaciones-sync
// ============================================================================

const { syncPostulacionesFromSheet } = require('../lib/postulacionesSync');

module.exports = async function handler(req, res) {
  try {
    const secret = process.env.CRON_SECRET;
    if (secret) {
      const auth = req.headers && req.headers.authorization;
      if (auth !== `Bearer ${secret}`) { res.status(401).json({ error: 'No autorizado' }); return; }
    }
    const resumen = await syncPostulacionesFromSheet();
    res.status(200).json({ actualizado: new Date().toISOString(), ...resumen });
  } catch (err) {
    res.status(200).json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
};
