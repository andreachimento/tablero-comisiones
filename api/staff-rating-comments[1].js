// ============================================================================
// FUNCION SERVERLESS: comentarios reales (individuales, no agregados) de la
// encuesta "Live Class Rating" en PostHog para UNA persona (todas sus
// cuentas del back office), para el modal "Ver comentarios" que se abre al
// hacer click en el rating del perfil.
//
// Aparte de api/staff-profile.js porque traer las respuestas fila por fila
// (en vez del agregado ya calculado) es una consulta mas pesada a PostHog, y
// la gran mayoria de las veces nadie abre ese modal - conviene pedirla a
// demanda, no en cada carga del perfil.
// ============================================================================

const { personKey, getAccountsForPerson } = require('../lib/overlay');
const { getPostHogComments } = require('../lib/posthog');

module.exports = async function handler(req, res) {
  try {
    const rawEmail = String((req.query && req.query.email) || '').toLowerCase().trim();
    if (!rawEmail) { res.status(200).json({ error: 'Falta el parametro email' }); return; }
    const email = personKey(rawEmail);

    let accounts = null;
    try { accounts = await getAccountsForPerson(email); } catch (e) { /* seguimos solo con el mail pedido */ }
    const misMails = Array.from(new Set([email].concat((accounts || []).map(a => a.email).filter(Boolean))));

    const respuestas = await getPostHogComments(misMails);
    res.status(200).json({ email, respuestas });
  } catch (err) {
    res.status(200).json({ error: String(err && err.message ? err.message : err) });
  }
};
