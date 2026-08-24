// ============================================================================
// FUNCION SERVERLESS: sincroniza la encuesta de disponibilidad horaria (leida
// directo del enlace publico de la planilla - ver lib/disponibilidadSync.js)
// contra el tablero.
//
// Se llama de tres formas, todas validas:
//   1. Automatico: Vercel la invoca sola a las 9 y a las 15 (ver los cron en
//      vercel.json), mandando el header Authorization con el CRON_SECRET.
//   2. Automatico "a demanda": cada vez que alguien abre la pestaña Staff,
//      si paso mas de una hora desde la ultima sincronizacion real (ver
//      ensureFreshDisponibilidadSync en api/staff-list.js).
//   3. Manual, para probar: entrando desde el navegador a
//      /api/disponibilidad-sync?key=coderhouse-disponibilidad-2026
// ============================================================================

const { syncDisponibilidadFromSheet } = require('../lib/disponibilidadSync');

module.exports = async function handler(req, res) {
  try {
    const secret = process.env.CRON_SECRET;
    const auth = req.headers && req.headers.authorization;
    const autorizadoPorCron = !secret || auth === `Bearer ${secret}`;
    const autorizadoPorClave = (req.query && req.query.key) === 'coderhouse-disponibilidad-2026';
    if (!autorizadoPorCron && !autorizadoPorClave) {
      res.status(401).json({ error: 'No autorizado' });
      return;
    }

    const resumen = await syncDisponibilidadFromSheet();
    res.status(200).json({ actualizado: new Date().toISOString(), ...resumen });
  } catch (err) {
    res.status(200).json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
};
