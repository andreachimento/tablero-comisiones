// ============================================================================
// FUNCION SERVERLESS: sincroniza las postulaciones de la planilla publica de
// Google Sheets contra el tablero. El tablero mismo lee la planilla (por el
// enlace publico, sin credenciales - ver lib/postulacionesSync.js), asi que
// esta funcion no necesita recibir los datos por POST; alcanza con
// invocarla (por GET o POST, sin body).
//
// Se llama de tres formas, todas validas:
//   1. Automatico: Vercel la invoca sola a las 9 y a las 15 (ver los cron en
//      vercel.json), mandando el header Authorization con el CRON_SECRET.
//   2. Automatico "a demanda": cada vez que alguien abre la pestaña
//      Comisiones, si paso mas de una hora desde la ultima sincronizacion
//      real (ver ensureFreshSync en api/dashboard-data.js).
//   3. Manual, para probar: entrando desde el navegador a
//      /api/postulaciones-sync?key=coderhouse-postulaciones-2026
// ============================================================================

const { syncPostulacionesFromSheet } = require('../lib/postulacionesSync');

module.exports = async function handler(req, res) {
  try {
    const secret = process.env.CRON_SECRET;
    const auth = req.headers && req.headers.authorization;
    const autorizadoPorCron = !secret || auth === `Bearer ${secret}`;
    const autorizadoPorClave = (req.query && req.query.key) === 'coderhouse-postulaciones-2026';
    if (!autorizadoPorCron && !autorizadoPorClave) {
      res.status(401).json({ error: 'No autorizado' });
      return;
    }

    let datosPlanilla;
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      datosPlanilla = body.markdown || body.rows || undefined;
    }

    const resumen = await syncPostulacionesFromSheet(datosPlanilla);
    res.status(200).json({ actualizado: new Date().toISOString(), ...resumen });
  } catch (err) {
    res.status(200).json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
};
