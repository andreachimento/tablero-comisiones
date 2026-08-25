// ============================================================================
// RATING REAL DE PROFESORES, vía PostHog (encuesta "Live Class Rating")
// ============================================================================
// Reemplaza (con fallback al rating manual viejo si no hay datos todavia) el
// sistema de estrellas cargadas a mano por el rating real que completan los
// estudiantes al finalizar cada clase.
//
// De donde sale el dato (especificacion que paso el equipo de Andrea):
//   - Encuesta "Live Class Rating", survey id fijo (SURVEY_ID mas abajo).
//   - Evento `survey sent`, propiedad `professor_guidance` (escala 1-5).
//   - Se vincula por `cohort_id` (que en realidad es el commissionNumber, no
//     el id interno de Coderhouse): candidato -> sus comisiones (API de
//     Coderhouse) -> commissionNumber -> promedio de `professor_guidance` en
//     PostHog, ponderado por cantidad de respuestas.
//
// DOS ERAS DE DATOS (encontrado al explorar el esquema real, no estaba en la
// especificacion original):
//   - Filas NUEVAS: ya traen `class_professor_email_1/2` +
//     `professor_guidance_1/2` (rating por profesor, para comisiones
//     co-dictadas). Estas se pueden asignar de forma exacta por mail, sin
//     pasar por el puente de cohort_id. A la fecha (ago-2026) practicamente
//     el 100% de las respuestas de esta encuesta caen en este caso.
//   - Filas VIEJAS: solo viene `professor_guidance` (el campo de siempre),
//     sin mail ni id del profesor - la unica forma de asignarle esa
//     respuesta a alguien seria el puente por cohort_id (commissionNumber)
//     que describio el equipo de Andrea. Hoy no se encontraron filas asi en
//     los datos reales (todas las respuestas ya traen al menos un mail de
//     profesor), pero se deja el puente armado como red de seguridad por si
//     aparecen respuestas mas viejas o de otro origen sin ese dato. Si una
//     comision co-dictada solo tuviera filas de este tipo, a los DOS
//     profesores se les sumaria la misma respuesta (no hay forma de saber a
//     cual corresponde con este dato - limitacion real de la encuesta vieja,
//     no un bug de este codigo).
//
// Como se evita pegarle a PostHog en cada request: se trae y agrega TODA la
// encuesta de una sola consulta HogQL, se cachea en Redis 15 minutos, y el
// prorateo por persona (que mails / que numeros de comision le corresponden)
// se hace despues en JS, sin volver a consultar PostHog.
//
// ACTUALIZACION: quien abre el tablero SIEMPRE ve datos de PostHog de como
// maximo 15 minutos de antiguedad (si el cache vencio, la siguiente carga lo
// vuelve a calcular sola). Ademas, para que el numero este al dia aunque
// nadie abra el tablero por un rato, api/posthog-refresh.js llama a
// refreshRatingsCache() una vez por dia (configurado en vercel.json, seccion
// "crons") y lo fuerza a recalcularse igual.
// ============================================================================

const { getRedis } = require('./redis');

const SURVEY_ID = '019c42b1-0ada-0000-c7a3-628b307891a7';
const CACHE_KEY = 'posthog:ratings-agg-v1';
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutos

function getEnv() {
  const API_KEY = process.env.POSTHOG_API_KEY;
  const PROJECT_ID = process.env.POSTHOG_PROJECT_ID;
  if (!API_KEY || !PROJECT_ID) {
    throw new Error('Faltan Environment Variables en Vercel (POSTHOG_API_KEY / POSTHOG_PROJECT_ID).');
  }
  return { API_KEY, PROJECT_ID };
}

async function runHogQL(query) {
  const { API_KEY, PROJECT_ID } = getEnv();
  const resp = await fetch(`https://us.posthog.com/api/projects/${PROJECT_ID}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error('PostHog respondio ' + resp.status + ': ' + text.slice(0, 300));
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('PostHog devolvio una respuesta que no es JSON'); }
  return data.results || [];
}

// Trae de PostHog TODA la encuesta agregada: cuanto suma y cuantas
// respuestas hay, agrupado por mail del profesor (filas nuevas) y por
// numero de comision (filas viejas, el puente por cohort_id).
async function fetchAggregate() {
  // OJO: PostHog exige que toda consulta sobre "events" tenga un rango de
  // fechas explicito en el WHERE (sin esto, la consulta escanea TODO el
  // historial de eventos de Coderhouse, no solo los de esta encuesta, y se
  // vuelve lenta/inestable - probablemente la causa de que el rating
  // apareciera en el perfil pero no en el listado general la primera vez
  // que se probo, ya que ahi se compite por tiempo con las ~700 llamadas al
  // back office que ya hace esa pantalla). La encuesta empezo a
  // completarse en marzo 2026 asi que 2 años para atras sobra de margen.
  const query = `
    SELECT person_email, cohort_id, count() AS n, sum(score) AS total
    FROM (
      SELECT
        toString(properties.class_professor_email_1) AS person_email,
        NULL AS cohort_id,
        toFloat(properties.professor_guidance_1) AS score
      FROM events
      WHERE event = 'survey sent'
        AND timestamp >= now() - INTERVAL 2 YEAR
        AND properties['$survey_id'] = '${SURVEY_ID}'
        AND isNotNull(properties.professor_guidance_1)
        AND notEmpty(toString(properties.class_professor_email_1))
      UNION ALL
      SELECT
        toString(properties.class_professor_email_2) AS person_email,
        NULL AS cohort_id,
        toFloat(properties.professor_guidance_2) AS score
      FROM events
      WHERE event = 'survey sent'
        AND timestamp >= now() - INTERVAL 2 YEAR
        AND properties['$survey_id'] = '${SURVEY_ID}'
        AND isNotNull(properties.professor_guidance_2)
        AND notEmpty(toString(properties.class_professor_email_2))
      UNION ALL
      SELECT
        NULL AS person_email,
        toString(properties.cohort_id) AS cohort_id,
        toFloat(properties.professor_guidance) AS score
      FROM events
      WHERE event = 'survey sent'
        AND timestamp >= now() - INTERVAL 2 YEAR
        AND properties['$survey_id'] = '${SURVEY_ID}'
        AND isNotNull(properties.professor_guidance)
        AND notEmpty(toString(properties.cohort_id))
        AND empty(toString(properties.class_professor_email_1))
        AND empty(toString(properties.class_professor_email_2))
    )
    GROUP BY person_email, cohort_id
    LIMIT 5000
  `;
  // OJO - bug real encontrado y corregido (ago-2026): la API de consultas de
  // PostHog devuelve como maximo 100 filas por defecto si la consulta no
  // pide un LIMIT explicito, SIN avisar de ningun modo que el resultado se
  // truncó. Como esta consulta agrupa por profesor (~260 profesores con
  // datos reales a la fecha), sin este LIMIT explicito solo ~100 profesores
  // (en un orden arbitrario, no por mail ni por cantidad) quedaban con
  // rating, y el resto mostraba "sin rating" a pesar de tener respuestas
  // reales en la encuesta. El LIMIT de arriba deja bastante margen para que
  // la planta de profesores siga creciendo sin volver a pisar este límite.
  const rows = await runHogQL(query);
  const byEmail = {};
  const byCohort = {};
  rows.forEach(r => {
    const personEmail = r[0];
    const cohortId = r[1];
    const n = Number(r[2]) || 0;
    const total = Number(r[3]) || 0;
    if (!n) return;
    if (personEmail) {
      const key = String(personEmail).toLowerCase().trim();
      if (!key) return;
      if (!byEmail[key]) byEmail[key] = { n: 0, total: 0 };
      byEmail[key].n += n;
      byEmail[key].total += total;
    } else if (cohortId) {
      const key = String(cohortId).trim();
      if (!key) return;
      if (!byCohort[key]) byCohort[key] = { n: 0, total: 0 };
      byCohort[key].n += n;
      byCohort[key].total += total;
    }
  });
  return { byEmail, byCohort };
}

// Guarda el agregado ya calculado en Redis, con el timestamp de cuando se
// calculo (para poder decidir despues si sigue "fresco" o hay que
// recalcularlo). Se usa tanto desde el camino normal (cache vencido) como
// desde el refresh forzado de una vez por dia.
async function saveAggregate(redis, data) {
  if (!redis) return;
  try {
    await redis.set(CACHE_KEY, JSON.stringify({ ts: Date.now(), data }), { ex: Math.round((CACHE_TTL_MS * 2) / 1000) });
  } catch (e) { /* si no se pudo guardar el cache, no pasa nada, se vuelve a calcular la proxima vez */ }
}

async function getAggregateCached() {
  let redis = null;
  try { redis = getRedis(); } catch (e) { /* seguimos sin cache */ }

  if (redis) {
    try {
      const cached = await redis.get(CACHE_KEY);
      const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
      if (parsed && parsed.ts && (Date.now() - parsed.ts) < CACHE_TTL_MS && parsed.data) {
        return parsed.data;
      }
    } catch (e) { /* cache invalida o vacia, la recalculamos abajo */ }
  }

  const data = await fetchAggregate();
  await saveAggregate(redis, data);
  return data;
}

// Fuerza un recalculo (sin importar si el cache todavia estaba fresco) y lo
// guarda. La llama api/posthog-refresh.js una vez por dia (cron de Vercel)
// para que el rating este al dia aunque nadie haya abierto el tablero en un
// rato. Devuelve un resumen chiquito, util para loguear/confirmar que corrio
// bien.
async function refreshRatingsCache() {
  let redis = null;
  try { redis = getRedis(); } catch (e) { /* sin cache, igual devolvemos el resultado */ }
  const data = await fetchAggregate();
  await saveAggregate(redis, data);
  return {
    profesoresConDatos: Object.keys(data.byEmail).length,
    comisionesConDatos: Object.keys(data.byCohort).length,
  };
}

// API publica: dado un listado de personas -
//   { key: personKey, emails: [mails de sus cuentas del back office], commissionNumbers: [numeros de TODAS sus comisiones, pasadas y presentes] }
// - devuelve { [key]: { ratingPromedio, ratingCount } } calculado con datos
// reales de la encuesta. Si una persona no tiene ninguna respuesta que le
// corresponda, devuelve ratingCount: 0 / ratingPromedio: null (no se
// descarta a nadie por falta de datos, simplemente queda "s/d").
async function getPostHogRatings(people) {
  const { byEmail, byCohort } = await getAggregateCached();
  const out = {};
  (people || []).forEach(p => {
    if (!p || !p.key) return;
    let n = 0;
    let total = 0;
    (p.emails || []).forEach(e => {
      const key = String(e || '').toLowerCase().trim();
      if (!key) return;
      const agg = byEmail[key];
      if (agg) { n += agg.n; total += agg.total; }
    });
    (p.commissionNumbers || []).forEach(c => {
      const key = c == null ? '' : String(c).trim();
      if (!key) return;
      const agg = byCohort[key];
      if (agg) { n += agg.n; total += agg.total; }
    });
    out[p.key] = n > 0 ? { ratingPromedio: Math.round((total / n) * 10) / 10, ratingCount: n } : { ratingPromedio: null, ratingCount: 0 };
  });
  return out;
}

// Trae las respuestas INDIVIDUALES (no agregadas) de la encuesta para una
// persona puntual - una fila por respuesta, con el comentario libre que
// escribio el estudiante, la clase/comision y la fecha. Se usa a demanda,
// solo cuando alguien hace click en el rating del perfil para leer los
// comentarios (por eso no se cachea junto con el agregado: pedirla para las
// ~700 personas del staff de una sola vez seria mucho mas pesado que traerla
// para una sola persona cuando hace falta).
async function getPostHogComments(emails) {
  const cleanEmails = Array.from(new Set((emails || []).map(e => String(e || '').toLowerCase().trim()).filter(Boolean)));
  if (!cleanEmails.length) return [];
  const emailList = cleanEmails.map(e => `'${e.replace(/'/g, "''")}'`).join(', ');
  // OJO: en HogQL, toString(NULL) no da string vacio - da el string literal
  // "(null)". La mayoria de las respuestas no dejan comentario escrito (solo
  // ponen el puntaje), asi que sin este chequeo explicito el modal mostraria
  // "(null)" como si fuera un comentario real en la mayoria de los casos.
  const query = `
    SELECT score, comment, class_title, cohort_id, ts FROM (
      SELECT
        toFloat(properties.professor_guidance_1) AS score,
        if(isNotNull(properties.comment), toString(properties.comment), '') AS comment,
        toString(properties.class_title) AS class_title,
        toString(properties.cohort_id) AS cohort_id,
        timestamp AS ts
      FROM events
      WHERE event = 'survey sent'
        AND timestamp >= now() - INTERVAL 2 YEAR
        AND properties['$survey_id'] = '${SURVEY_ID}'
        AND isNotNull(properties.professor_guidance_1)
        AND lower(toString(properties.class_professor_email_1)) IN (${emailList})
      UNION ALL
      SELECT
        toFloat(properties.professor_guidance_2) AS score,
        if(isNotNull(properties.comment), toString(properties.comment), '') AS comment,
        toString(properties.class_title) AS class_title,
        toString(properties.cohort_id) AS cohort_id,
        timestamp AS ts
      FROM events
      WHERE event = 'survey sent'
        AND timestamp >= now() - INTERVAL 2 YEAR
        AND properties['$survey_id'] = '${SURVEY_ID}'
        AND isNotNull(properties.professor_guidance_2)
        AND lower(toString(properties.class_professor_email_2)) IN (${emailList})
    )
    ORDER BY ts DESC
    LIMIT 500
  `;
  const rows = await runHogQL(query);
  return rows.map(r => ({
    score: r[0] == null ? null : Number(r[0]),
    comment: r[1] || '',
    claseTitle: r[2] || '',
    cohortId: r[3] || '',
    fecha: r[4] || null,
  }));
}

module.exports = { getPostHogRatings, refreshRatingsCache, getPostHogComments, SURVEY_ID };
