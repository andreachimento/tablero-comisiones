// ============================================================================
// Conexion a la base de datos que usa el tablero para guardar todo lo que no
// viene de la API de Coderhouse: comentarios, estado del perfil,
// calificaciones, cursos habilitados, certificaciones y postulaciones.
//
// Hay DOS motores soportados y el que se usa depende de que Environment
// Variables esten cargadas en Vercel:
//
//   1) POSTGRES / NEON (el actual). Si esta DATABASE_URL (o POSTGRES_URL, que
//      es como la llama la integracion de Vercel), se usa lib/kvPostgres.js,
//      que habla SQL con la misma interfaz que Redis.
//
//   2) UPSTASH / Redis (el anterior). Si no hay Postgres pero si estan las
//      variables de Upstash, se sigue usando ese. Se deja a proposito: si
//      hiciera falta volver, alcanza con sacar la variable de Postgres y
//      redesplegar, sin tocar una linea de codigo.
//
// Por que se migro: el plan gratis de Upstash cobra por BYTES transferidos
// (10 GB al mes) y la base quedo suspendida en octubre al agotarlos, con el
// tablero y -lo mas grave- el sitio publico de certificaciones caidos. Ver el
// comentario largo arriba de lib/kvPostgres.js.
// ============================================================================

let client = null;

function urlPostgres() {
  // La integracion de Neon en Vercel inyecta varias; se toma la primera que
  // exista. POSTGRES_URL_NON_POOLING queda al final porque es la que conviene
  // solo para migraciones, no para el trafico normal.
  return process.env.DATABASE_URL
    || process.env.POSTGRES_URL
    || process.env.NEON_DATABASE_URL
    || process.env.POSTGRES_PRISMA_URL
    || process.env.POSTGRES_URL_NON_POOLING
    || null;
}

function entornoUpstash() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url, token } : null;
}

function getRedis() {
  if (client) return client;

  const pg = urlPostgres();
  if (pg) {
    const { crearDesdeUrl } = require('./kvPostgres');
    client = crearDesdeUrl(pg);
    return client;
  }

  const upstash = entornoUpstash();
  if (upstash) {
    const { Redis } = require('@upstash/redis');
    client = new Redis({ url: upstash.url, token: upstash.token });
    return client;
  }

  throw new Error('Falta conectar la base de datos: conecta la base de Neon al proyecto desde Vercel > Storage (eso carga DATABASE_URL solo) y volve a desplegar.');
}

// Para los tests, que necesitan apuntar a una base distinta en cada corrida.
function _resetClienteParaTests() { client = null; }

module.exports = { getRedis, _resetClienteParaTests };
