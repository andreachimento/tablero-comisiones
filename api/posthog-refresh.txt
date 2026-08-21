// ============================================================================
// FUNCION SERVERLESS: actualizacion diaria del rating de PostHog
// ============================================================================
// El rating que se muestra en el tablero ya se recalcula solo cada vez que
// el cache de 15 minutos vence (ver lib/posthog.js) - pero eso depende de
// que alguien tenga el tablero abierto. Para que el numero este al dia
// aunque nadie lo abra por un rato, Vercel llama a este endpoint una vez por
// dia (ver la seccion "crons" de vercel.json) y fuerza el recalculo.
//
// Se puede llamar a mano tambien, visitando la URL en el navegador, si en
// algun momento se quiere forzar una actualizacion sin esperar al cron.
//
// Seguridad: si se configura la Environment Variable CRON_SECRET en Vercel,
// solo se acepta el pedido si viene con el header que Vercel agrega solo
// automaticamente a sus propios crons (Authorization: Bearer <CRON_SECRET>).
// Si todavia no se configuro esa variable, el endpoint funciona igual sin
// pedir nada (no hace falta configurarla para que la actualizacion diaria
// funcione).
// ============================================================================

const { refreshRatingsCache } = require('../lib/posthog');

module.exports = async function handler(req, res) {
  try {
    const secret = process.env.CRON_SECRET;
    if (secret) {
      const auth = req.headers && req.headers.authorization;
      if (auth !== `Bearer ${secret}`) {
        res.status(401).json({ error: 'No autorizado' });
        return;
      }
    }

    const resumen = await refreshRatingsCache();
    res.status(200).json({
      ok: true,
      actualizado: new Date().toISOString(),
      ...resumen,
    });
  } catch (err) {
    res.status(200).json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
};
