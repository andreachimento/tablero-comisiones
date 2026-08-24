// ============================================================================
// FUNCION SERVERLESS: recibe los datos de la planilla de postulaciones y los
// sincroniza contra el tablero.
//
// Andrea eligio que sea Claude (via una tarea programada, una vez por hora)
// quien lea la planilla de Google Sheets y se la mande a ESTE endpoint, en
// vez de que el propio tablero se conecte solo a Google (eso hubiera pedido
// configurar una cuenta de servicio de Google Cloud). Por eso este endpoint
// espera un POST con el contenido de la planilla en el body:
//   { "markdown": "<< el texto que Google Drive devuelve al leer el archivo >>" }
// Protegido con el mismo CRON_SECRET que ya se usa para posthog-refresh, asi
// que solo quien tenga esa clave puede cargar postulaciones.
//
// Si en algun momento se prefiere que el tablero se conecte solo a Google
// (ver lib/googleSheet.js), alcanza con configurar las Environment Variables
// GOOGLE_SHEET_ID / GOOGLE_SHEET_GID / GOOGLE_SERVICE_ACCOUNT_* - en ese caso
// tambien se sincroniza sola cada vez que se abre la pestaña Comisiones (ver
// api/dashboard-data.js), y este endpoint se puede seguir usando igual como
// respaldo manual.
// ============================================================================

const { syncPostulacionesFromSheet } = require('../lib/postulacionesSync');

module.exports = async function handler(req, res) {
  try {
    const secret = process.env.CRON_SECRET;
    if (secret) {
      const auth = req.headers && req.headers.authorization;
      if (auth !== `Bearer ${secret}`) { res.status(401).json({ error: 'No autorizado' }); return; }
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
