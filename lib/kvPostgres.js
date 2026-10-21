// ============================================================================
// Adaptador de Postgres (Neon) con la MISMA interfaz que el cliente de Redis
// de Upstash: hset, hget, hgetall, hkeys, hdel, set, get, del, rpush, lrange,
// lset. Gracias a eso ningun otro archivo cambia: lib/redis.js devuelve este
// objeto o el de Upstash segun que Environment Variables esten cargadas.
//
// POR QUE SE MIGRO. El plan gratis de Upstash cobra por BYTES transferidos
// (10 GB al mes). En octubre se agotaron y la base quedo SUSPENDIDA: dejaron
// de funcionar el tablero y, sobre todo, el sitio publico donde los
// profesores rinden la evaluacion. La causa era leer colecciones enteras en
// cada carga de pantalla (ya corregido), pero el modo de falla es el
// problema: al pasarse, Upstash corta tambien las lecturas y los datos
// quedan encerrados adentro.
//
// En Neon, pasarse de almacenamiento NO suspende nada: fallan las escrituras
// y se sigue leyendo. Es un modo de falla mucho menos destructivo. Los dos
// limites a vigilar son la transferencia (5 GB al mes) y las horas de
// computo (100 al mes), los dos con buen margen contra el consumo real.
//
// COMO SE GUARDA. Dos tablas, que imitan las dos estructuras de Redis que el
// tablero usa:
//   kv       -> los Hash (comentarios, certificaciones, banco de preguntas,
//               indice de cuentas) y las claves sueltas (caches).
//               k = clave, f = campo del hash, o '' si es una clave suelta.
//   kv_list  -> las Listas (hoy solo staff:postulaciones). El orden lo da el
//               id autoincremental, igual que el orden de insercion en Redis.
//
// SERIALIZACION. Se imita exactamente al cliente de Upstash: al escribir, lo
// que no es texto se convierte a JSON; al leer, se intenta deserializar y si
// no es JSON valido se devuelve el texto tal cual. Esto importa porque el
// codigo del tablero a veces llama a set() con un objeto y a veces con un
// JSON.stringify ya hecho, y en los dos casos espera recuperar un objeto.
// ============================================================================

function serializar(v) {
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

function deserializar(s) {
  if (s == null) return null;
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch (e) { return s; }
}

const DDL = [
  "CREATE TABLE IF NOT EXISTS kv (k text NOT NULL, f text NOT NULL DEFAULT '', v text, exp bigint, PRIMARY KEY (k, f))",
  'CREATE TABLE IF NOT EXISTS kv_list (id bigserial PRIMARY KEY, k text NOT NULL, v text)',
  'CREATE INDEX IF NOT EXISTS kv_list_k ON kv_list (k, id)',
];

// `consultar(sql, args)` tiene que devolver un array de filas (objetos con
// las columnas pedidas). Asi este adaptador no depende de un cliente puntual
// y se puede probar contra cualquier Postgres.
function crearAdaptador(consultar) {
  let schemaListo = null;

  async function asegurarSchema() {
    if (!schemaListo) {
      schemaListo = (async () => {
        for (const sql of DDL) await consultar(sql, []);
      })().catch(err => { schemaListo = null; throw err; });
    }
    return schemaListo;
  }

  async function q(sql, args) {
    await asegurarSchema();
    return consultar(sql, args || []);
  }

  const ahora = () => Date.now();

  return {
    // --- claves sueltas ---------------------------------------------------
    async set(key, value, opts) {
      let exp = null;
      if (opts && typeof opts.ex === 'number') exp = ahora() + opts.ex * 1000;
      else if (opts && typeof opts.px === 'number') exp = ahora() + opts.px;
      await q(
        "INSERT INTO kv (k, f, v, exp) VALUES ($1, '', $2, $3) " +
        'ON CONFLICT (k, f) DO UPDATE SET v = EXCLUDED.v, exp = EXCLUDED.exp',
        [String(key), serializar(value), exp]
      );
      return 'OK';
    },

    async get(key) {
      const filas = await q("SELECT v, exp FROM kv WHERE k = $1 AND f = ''", [String(key)]);
      const fila = filas[0];
      if (!fila) return null;
      // Vencida: se comporta como si no existiera y se limpia sin bloquear.
      if (fila.exp != null && Number(fila.exp) < ahora()) {
        q("DELETE FROM kv WHERE k = $1 AND f = ''", [String(key)]).catch(() => {});
        return null;
      }
      return deserializar(fila.v);
    },

    async del(...keys) {
      const lista = keys.flat().map(String);
      if (!lista.length) return 0;
      await q('DELETE FROM kv WHERE k = ANY($1)', [lista]);
      await q('DELETE FROM kv_list WHERE k = ANY($1)', [lista]);
      return lista.length;
    },

    // --- hashes -----------------------------------------------------------
    async hset(key, obj) {
      const entradas = Object.entries(obj || {});
      if (!entradas.length) return 0;
      // Un solo INSERT con todos los campos: una ida y vuelta por lote, y o
      // entra todo o no entra nada.
      const campos = entradas.map(e => String(e[0]));
      const valores = entradas.map(e => serializar(e[1]));
      await q(
        'INSERT INTO kv (k, f, v, exp) ' +
        'SELECT $1, campo, valor, NULL FROM unnest($2::text[], $3::text[]) AS t(campo, valor) ' +
        'ON CONFLICT (k, f) DO UPDATE SET v = EXCLUDED.v',
        [String(key), campos, valores]
      );
      return entradas.length;
    },

    async hget(key, field) {
      const filas = await q('SELECT v FROM kv WHERE k = $1 AND f = $2', [String(key), String(field)]);
      return filas[0] ? deserializar(filas[0].v) : null;
    },

    async hgetall(key) {
      const filas = await q("SELECT f, v FROM kv WHERE k = $1 AND f <> ''", [String(key)]);
      if (!filas.length) return null; // igual que Upstash: hash vacio -> null
      const out = {};
      filas.forEach(fila => { out[fila.f] = deserializar(fila.v); });
      return out;
    },

    async hkeys(key) {
      const filas = await q("SELECT f FROM kv WHERE k = $1 AND f <> ''", [String(key)]);
      return filas.map(fila => fila.f);
    },

    async hdel(key, ...fields) {
      const lista = fields.flat().map(String);
      if (!lista.length) return 0;
      const filas = await q(
        'DELETE FROM kv WHERE k = $1 AND f = ANY($2) RETURNING f',
        [String(key), lista]
      );
      return filas.length;
    },

    // --- listas -----------------------------------------------------------
    async rpush(key, ...values) {
      const lista = values.flat();
      if (!lista.length) return 0;
      await q(
        'INSERT INTO kv_list (k, v) SELECT $1, valor FROM unnest($2::text[]) AS t(valor)',
        [String(key), lista.map(serializar)]
      );
      const filas = await q('SELECT COUNT(*)::int AS n FROM kv_list WHERE k = $1', [String(key)]);
      return Number((filas[0] || {}).n || 0);
    },

    async lrange(key, start, stop) {
      const filas = await q('SELECT v FROM kv_list WHERE k = $1 ORDER BY id', [String(key)]);
      const todos = filas.map(fila => deserializar(fila.v));
      const n = todos.length;
      if (!n) return [];
      // Indices negativos y recorte, igual que Redis.
      let a = Number(start); let b = Number(stop);
      if (a < 0) a = Math.max(n + a, 0);
      if (b < 0) b = n + b;
      if (b >= n) b = n - 1;
      if (a > b || a >= n) return [];
      return todos.slice(a, b + 1);
    },

    async lset(key, index, value) {
      const filas = await q('SELECT id FROM kv_list WHERE k = $1 ORDER BY id', [String(key)]);
      let i = Number(index);
      if (i < 0) i = filas.length + i;
      if (i < 0 || i >= filas.length) throw new Error('lset: indice fuera de rango');
      await q('UPDATE kv_list SET v = $1 WHERE id = $2', [serializar(value), filas[i].id]);
      return 'OK';
    },
  };
}

// Driver para Neon (HTTP, pensado para funciones serverless: no mantiene una
// conexion abierta entre invocaciones, que es justo lo que rompe Postgres en
// Vercel).
function crearDesdeUrl(url) {
  const { neon } = require('@neondatabase/serverless');
  const sql = neon(url);
  return crearAdaptador((texto, args) => sql.query(texto, args));
}

module.exports = { crearAdaptador, crearDesdeUrl, serializar, deserializar, DDL };
