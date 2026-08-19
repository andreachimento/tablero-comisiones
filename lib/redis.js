// ============================================================================
// Conexion a la base de datos (Redis, via Upstash) que usa la pestaña Staff
// para guardar todo lo que no viene de la API de Coderhouse: comentarios,
// estado del perfil, calificaciones, cursos habilitados y los perfiles
// "extraidos de Dash".
//
// Las credenciales se configuran como Environment Variables en Vercel (nunca
// escritas en este archivo). Segun como se haya llamado la integracion al
// crearla, Vercel puede inyectarlas con distintos nombres, asi que probamos
// los mas comunes:
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN   (nombre estandar de Upstash)
//   KV_REST_API_URL / KV_REST_API_TOKEN                 (nombre historico de Vercel KV)
// ============================================================================

const { Redis } = require('@upstash/redis');

let client = null;

function getRedis() {
  if (client) return client;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error('Falta conectar la base de datos: configura UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN (o KV_REST_API_URL / KV_REST_API_TOKEN) en Vercel > Project Settings > Environment Variables y volve a desplegar.');
  }
  client = new Redis({ url, token });
  return client;
}

module.exports = { getRedis };
