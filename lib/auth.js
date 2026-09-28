// ============================================================================
// Contrasena de acceso al tablero
// ============================================================================
// Mismo criterio que el panel de evaluaciones del sitio de certificaciones
// (api/admin-preguntas.js): no es un sistema de usuarios, es una contrasena
// compartida por el equipo. La diferencia importante es DONDE se valida.
//
// Poner la contrasena solo en la pantalla no protege nada: los datos del
// tablero (nombres, mails, historial y ratings del staff) los sirven los
// endpoints de /api, y cualquiera que pida esas URLs directamente los
// recibe, sin pasar nunca por la pantalla. Por eso la validacion vive ACA y
// la llama cada endpoint: si la contrasena no viene o no coincide, no se
// devuelve ni un dato.
//
// La contrasena se configura en Vercel (Project Settings > Environment
// Variables) como TABLERO_PASSWORD. Si esa variable no esta cargada, todos
// los endpoints responden error y el tablero no muestra nada: preferimos que
// quede cerrado y se note, antes que abierto sin que nadie se entere.
//
// El navegador la manda en el header 'x-tablero-password' en cada llamada.
// Va por header y no por la URL a proposito: lo que viaja en la URL queda
// escrito en los registros del servidor, en el historial del navegador y en
// el header Referer cuando la pagina carga algo de otro sitio.
// ============================================================================

const crypto = require('crypto');

// Compara sin filtrar informacion por el tiempo que tarda. Un === comun corta
// apenas encuentra el primer caracter distinto, y esa diferencia de tiempo,
// medida muchas veces, deja adivinar la contrasena de a un caracter.
function igualSinFiltrarTiempo(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  // timingSafeEqual exige el mismo largo, asi que primero emparejamos con un
  // hash: asi tampoco se filtra el largo de la contrasena.
  const ha = crypto.createHash('sha256').update(ba).digest();
  const hb = crypto.createHash('sha256').update(bb).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// La contrasena que mando quien llama: header primero, y para los POST que ya
// mandan un cuerpo JSON tambien se acepta en el body (mismo formato que usa
// el panel de evaluaciones, para no tener dos convenciones distintas).
function passwordDeLaPeticion(req) {
  const h = req && req.headers && (req.headers['x-tablero-password'] || req.headers['X-Tablero-Password']);
  if (h) return String(h);
  const b = req && req.body;
  if (b && typeof b === 'object' && b.password != null) return String(b.password);
  return '';
}

// Las tareas programadas de Vercel (ver "crons" en vercel.json) entran sin
// contrasena: no las dispara una persona. Cada uno de esos endpoints ya valida
// CRON_SECRET por su cuenta, y ademas no devuelven datos de staff.
function esTareaProgramada(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req && req.headers && req.headers.authorization;
  return !!auth && auth === `Bearer ${secret}`;
}

// Devuelve true si la peticion puede seguir. Si devuelve false YA respondio,
// asi que quien la llama solo tiene que cortar:
//
//   if (!requireAuth(req, res)) return;
//
function requireAuth(req, res) {
  const configurada = process.env.TABLERO_PASSWORD;
  if (!configurada) {
    res.status(500).json({ error: 'Falta configurar TABLERO_PASSWORD en las Environment Variables de este proyecto en Vercel.' });
    return false;
  }
  if (esTareaProgramada(req)) return true;

  const enviada = passwordDeLaPeticion(req);
  if (!enviada || !igualSinFiltrarTiempo(enviada, configurada)) {
    // 401 es lo que mira el navegador para volver a pedir la contrasena.
    res.status(401).json({ error: 'No autorizado', necesitaPassword: true });
    return false;
  }
  return true;
}

module.exports = { requireAuth };
