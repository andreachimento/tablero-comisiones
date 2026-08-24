// ============================================================================
// FUNCION SERVERLESS DE UNA SOLA VEZ: importa las respuestas que ya estaban
// cargadas en la encuesta de disponibilidad horaria (planilla de Google
// Sheets "Disponibilidad horaria - Profesores y Tutores Coderhouse",
// data/disponibilidad-seed.json, ya leida y normalizada por Claude) al
// apartado "Disponibilidad" de cada perfil del tablero.
//
// Se llama UNA vez visitando esta URL en el navegador (con la clave). Es
// seguro llamarla mas de una vez por error: vuelve a escribir los mismos
// dias/franjas, no duplica nada. OJO: a diferencia de postulaciones, esto
// SI pisa el campo "disponibilidad" de cada perfil con lo que dice la
// encuesta (se toma como la fuente de verdad) - si alguien lo edito a mano
// desde el tablero despues de que se genero este archivo, ese cambio a
// mano se pierde al volver a correr esto.
//
// Esta planilla, a diferencia de la de postulaciones, NO esta compartida
// como "Cualquiera con el enlace" (solo el dominio @coderhouse.com puede
// verla), asi que el tablero todavia no puede leerla solo - por eso esto es
// una importacion puntual (una fotografia de la encuesta a este momento),
// no algo que se actualice solo cada hora. Para las respuestas que lleguen
// despues, hay que repetir el proceso (pedirle a Claude que vuelva a leer
// la planilla y regenere este archivo), o compartir la planilla como
// "Cualquiera con el enlace" para activar la sincronizacion automatica
// (igual que se hizo con postulaciones).
// ============================================================================

const { setDisponibilidadBulk } = require('../lib/overlay');

module.exports = async function handler(req, res) {
  try {
    if ((req.query && req.query.key) !== 'coderhouse-disponibilidad-2026') {
      res.status(403).json({ error: 'Falta la clave (?key=...)' });
      return;
    }

    let seed;
    try {
      seed = require('../data/disponibilidad-seed.json');
    } catch (readErr) {
      res.status(200).json({
        ok: false,
        error: 'No se pudo leer data/disponibilidad-seed.json: ' + String(readErr && readErr.message ? readErr.message : readErr),
      });
      return;
    }

    const resultado = await setDisponibilidadBulk(seed);
    res.status(200).json({
      ok: true,
      totalProcesadas: seed.length,
      personasActualizadas: resultado.personasActualizadas,
      perfilesNuevos: resultado.perfilesNuevos,
    });
  } catch (err) {
    res.status(200).json({ error: String(err && err.message ? err.message : err) });
  }
};
