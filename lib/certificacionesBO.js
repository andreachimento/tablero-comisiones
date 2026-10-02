// ============================================================================
// Empujar una certificacion aprobada al perfil de la persona en el BACK OFFICE
// ============================================================================
// Hasta ahora, aprobar una certificacion solo dejaba el curso en el perfil del
// tablero ("Cursos habilitados a dictar"). El back office tiene su propia
// lista por persona - la que se ve en "ver certificaciones" del perfil de
// staff - y quedaba desactualizada, habia que cargarla a mano.
//
// Esto la completa sola. Reglas, acordadas con Andrea (oct. 2026):
//
//   1. SOLO PROFESORES. En el back office esa lista es una sola, sin separar
//      profesor de tutor, y hoy los perfiles +tutor la tienen vacia a
//      proposito. Asi que las certificaciones de tutor se aprueban como
//      siempre y no se empuja nada.
//
//   2. VA AL MAIL EXACTO, no a la persona. En el back office una persona
//      suele tener varias cuentas (@coderhouse.com, +profesor@, +tutor@...) y
//      CADA UNA tiene su propio perfil. El rol esta en el mail: el que
//      termina en +profesor es el perfil de profesor. Por eso se usa
//      cert.email tal cual lo escribio la persona al rendir - con su +tag -
//      y NO personKey(), que justamente borra el tag para agrupar cuentas en
//      la pantalla del tablero. Si se usara personKey, la certificacion
//      podria terminar en el perfil equivocado.
//
//   3. NO SE ADIVINA EL CURSO. El back office identifica los cursos por ID de
//      producto, no por nombre. La equivalencia esta en lib/cursosProductos.js
//      revisada una por una. Si un curso no esta ahi (o todavia no tiene
//      producto creado), no se empuja nada y se dice por que: preferimos que
//      falte un dato alla y quede registrado, antes que escribir el producto
//      equivocado en el perfil de alguien.
//
//   4. NUNCA ROMPE LA APROBACION. Si el back office no contesta, o la cuenta
//      no existe alla, la certificacion se aprueba igual en el tablero y se
//      informa que no se pudo empujar. Lo importante es que la decision de
//      Andrea no se pierda por un problema de red.
//
//   5. SOLO AGREGA. Se manda unicamente "add", nunca "remove": esta funcion
//      no puede sacarle una certificacion a nadie.
// ============================================================================

const { productoDeCurso } = require('./cursosProductos');
const { getAccountsForPerson } = require('./overlay');

// ---------------------------------------------------------------------------
// A QUE CUENTAS SE LES EMPUJA
// ---------------------------------------------------------------------------
// Lista vacia = a todas (siempre dentro de las dos reglas de mas abajo: tiene
// que ser una certificacion de PROFESOR y el mail tiene que ser una cuenta
// +profesor). Si se carga aunque sea un mail, el empuje vuelve a correr solo
// para esos - sirve para volver a acotarlo si alguna vez hace falta probar
// algo sin tocar a nadie mas.
//
// Historia: arranco el 1/10/2026 limitado a andrea.chimento+profesor@ para
// validar el circuito en una sola cuenta. Se comprobo con datos reales que el
// empuje AGREGA y no pisa lo que la persona ya tenia cargado en el back
// office (su certificacion previa seguia ahi despues de sumar dos nuevas),
// que era la condicion para abrirlo al resto. Abierto el mismo dia.
const SOLO_ESTAS_CUENTAS = [];

function cuentaHabilitada(email) {
  if (!SOLO_ESTAS_CUENTAS.length) return true; // lista vacia = todos
  return SOLO_ESTAS_CUENTAS.indexOf(String(email || '').toLowerCase().trim()) !== -1;
}

function getEnv() {
  const BASE = process.env.BACKOFFICE_API_URL;
  const STUDENT_KEY = process.env.CLAUDE_STUDENT_API_KEY;
  if (!BASE || !STUDENT_KEY) return null;
  return { BASE, STUDENT_KEY };
}

// Devuelve siempre un objeto que describe que paso, nunca tira una excepcion.
// Forma: { empujado: bool, motivo: string, productId, email, detalle }
//   empujado=true  -> el back office confirmo el cambio
//   empujado=false -> no se hizo nada; 'motivo' explica si fue una decision
//                     (rol tutor, curso sin producto) o una falla (red, etc).
async function empujarCertificacionAlBO(cert) {
  const resultado = {
    empujado: false,
    motivo: '',
    email: (cert && cert.email) || null,
    curso: (cert && cert.curso) || null,
    productId: null,
    detalle: null,
  };

  if (!cert || !cert.email) {
    resultado.motivo = 'La certificacion no tiene mail, no se puede saber a que perfil va.';
    return resultado;
  }

  if (cert.rol !== 'profesor') {
    resultado.motivo = 'Es una certificacion de tutor: por decision del equipo, al back office solo van las de profesor.';
    return resultado;
  }

  if (!cuentaHabilitada(cert.email)) {
    resultado.motivo = 'Todavia no esta activado para esta cuenta: por ahora el empuje al back office corre solo en la cuenta de prueba.';
    return resultado;
  }

  // Chequeo de coherencia: el rol dice profesor, pero el mail tiene que
  // corresponderse, porque es el mail el que elige el perfil del otro lado.
  // Si no coinciden hay algo raro cargado y es mejor frenar que escribir en
  // el perfil equivocado.
  const tag = String(cert.email).toLowerCase().match(/\+([a-z0-9]+)@/);
  if (!tag || !/^prof/.test(tag[1])) {
    resultado.motivo = `El mail (${cert.email}) no es una cuenta +profesor, asi que no se puede saber en que perfil del back office impactar.`;
    return resultado;
  }

  return agregarEnBO(cert.email, cert.curso, resultado);
}

// ---------------------------------------------------------------------------
// CAMINO 2: un curso agregado a mano en "Cursos habilitados a dictar"
// ---------------------------------------------------------------------------
// Aca el rol lo elige quien carga el curso en el desplegable del perfil
// (Profesor / Tutor Adjunto) y es lo unico que decide si se sube: profesor
// sube, tutor adjunto no.
//
// La diferencia con el camino de las certificaciones es a QUE CUENTA escribir.
// Alla la persona habia rendido con un mail concreto (+profesor), asi que el
// destino venia dado. Aca el perfil del tablero esta unificado por mail base y
// agrupa todas las cuentas de la persona, asi que hay que buscar cual de ellas
// es la de profesor. Se usa el indice de cuentas que ya mantiene la pestaña
// Staff (lib/overlay.js -> getAccountsForPerson), que trae las cuentas reales
// del back office.
//
// Medido contra el back office (oct. 2026, 827 cuentas de instructor en 746
// personas): 387 personas tienen exactamente una cuenta +profesor, 338 son
// tutores (sin cuenta +profesor, y no hay que tocarlos), y solo 8 tienen DOS
// cuentas +profesor. En esas 8 no se escribe nada y se avisa: elegir una por
// nuestra cuenta puede dejar el curso en el perfil equivocado.
// Personas que NO se empujan nunca por este camino, por pedido de Andrea
// (oct. 2026). Son las 8 que tienen dos cuentas +profesor en el back office:
// no se puede saber en cual cargar el curso y elegir mal deja la certificacion
// en el perfil equivocado.
//
// La regla dinamica de mas abajo (si hay mas de una cuenta +profesor, no se
// escribe) ya las frenaria sola. Esta lista esta ADEMAS, a proposito: si
// manana alguien borra una de las dos cuentas, la regla dinamica las dejaria
// pasar de nuevo, y en varios de estos casos eso seria un error. El mas claro
// es camila.mojavik@coderhouse.com, donde +prof no es un duplicado suyo sino
// la cuenta de trabajo de OTRA persona (Tamara Drajner, con 73 asignaciones).
//
// A medida que se vayan unificando en el back office, se van sacando de aca.
const PERSONAS_SIN_EMPUJE = [
  'arunramsank@gmail.com',        // +profesor y +professor (con dos eses)
  'camila.mojavik@coderhouse.com',// +prof es, en realidad, de Tamara Drajner
  'gimenavilches.gv@gmail.com',   // +profesor (6 certificaciones) y +profesora
  'melinaveronica@gmail.com',     // las dos cuentas con asignaciones y 15 certificaciones cada una
  'naylalaco@gmail.com',          // +profesor y +profesora, las dos vacias
  'tomas@coderhouse.com',         // +profecc y +profesor1000, parecen de prueba
  'vanecb@hotmail.com',           // +profesor (2 certificaciones) y +profesora
  'yamilagvazquez@gmail.com',     // certificaciones en una cuenta, asignaciones en la otra
];

// OJO: esto aplica SOLO a este camino (curso agregado a mano en el perfil).
// Las certificaciones aprobadas no se tocan: alla la persona rindio con un
// mail +profesor concreto, asi que no hay ninguna ambiguedad que resolver.
async function empujarCursoHabilitadoAlBO({ personKey: clave, curso, rol }) {
  const resultado = {
    empujado: false,
    motivo: '',
    email: null,
    curso: curso || null,
    productId: null,
    detalle: null,
  };

  if (rol !== 'profesor') {
    resultado.motivo = 'Se cargo como Tutor Adjunto: al back office solo van los cursos de Profesor.';
    return resultado;
  }
  if (!clave) {
    resultado.motivo = 'No se sabe de que persona es el curso.';
    return resultado;
  }
  if (PERSONAS_SIN_EMPUJE.indexOf(String(clave).toLowerCase().trim()) !== -1) {
    resultado.motivo = 'Esta persona esta excluida a proposito: tiene dos cuentas +profesor en el back office y no se puede saber en cual cargarlo. Hay que hacerlo a mano.';
    return resultado;
  }

  let cuentas = null;
  try {
    cuentas = await getAccountsForPerson(clave);
  } catch (e) {
    resultado.motivo = 'No se pudo leer el indice de cuentas para saber a que perfil del back office escribir.';
    return resultado;
  }
  // null significa dos cosas que no se pueden distinguir desde aca: que el
  // indice todavia no se armo, o que esta persona no figura en el back office.
  // Se dicen las dos, en vez de afirmar una.
  if (!Array.isArray(cuentas)) {
    resultado.motivo = 'No se encontraron las cuentas del back office de esta persona. Puede ser que el indice todavia no se haya armado (abri una vez la pestaña Staff y proba de nuevo) o que no tenga cuenta alla.';
    return resultado;
  }

  const deProfesor = cuentas
    .map(c => String((c && c.email) || '').toLowerCase().trim())
    .filter(e => /\+prof[a-z0-9]*@/.test(e));

  if (!deProfesor.length) {
    resultado.motivo = 'Esta persona no tiene una cuenta +profesor en el back office, asi que no hay perfil de profesor donde cargarlo.';
    return resultado;
  }
  if (deProfesor.length > 1) {
    resultado.motivo = `Esta persona tiene mas de una cuenta +profesor en el back office (${deProfesor.join(', ')}), asi que no se puede saber en cual cargarlo. Hay que hacerlo a mano.`;
    return resultado;
  }

  const email = deProfesor[0];
  resultado.email = email;
  if (!cuentaHabilitada(email)) {
    resultado.motivo = 'Todavia no esta activado para esta cuenta.';
    return resultado;
  }

  return agregarEnBO(email, curso, resultado);
}

// ---------------------------------------------------------------------------
// El envio en si, compartido por los dos caminos. Siempre "add", nunca
// "remove": esto no puede sacarle una certificacion a nadie.
// ---------------------------------------------------------------------------
async function agregarEnBO(email, curso, resultado) {
  const productId = productoDeCurso(curso);
  if (!productId) {
    resultado.motivo = `El curso "${curso}" todavia no tiene un producto equivalente cargado en lib/cursosProductos.js, asi que no se empuja (hay que completarlo a mano alla).`;
    return resultado;
  }
  resultado.productId = productId;

  const env = getEnv();
  if (!env) {
    resultado.motivo = 'Faltan BACKOFFICE_API_URL / CLAUDE_STUDENT_API_KEY en las Environment Variables de Vercel.';
    return resultado;
  }

  try {
    const resp = await fetch(env.BASE + '/platform/staff/m2m/admin/profiles/certifications/bulk', {
      method: 'POST',
      headers: { 'X-API-Key': env.STUDENT_KEY, 'Content-Type': 'application/json' },
      // Un solo item y solo "add". Ver regla 5 arriba.
      body: JSON.stringify({ items: [{ email: email, add: [productId] }] }),
    });
    const texto = await resp.text();
    let cuerpo = null;
    try { cuerpo = JSON.parse(texto); } catch (e) { cuerpo = texto; }
    resultado.detalle = cuerpo;

    if (!resp.ok) {
      resultado.motivo = `El back office respondio ${resp.status} al intentar agregar la certificacion.`;
      return resultado;
    }

    // El endpoint agrupa el resultado: updated (se cambio), unchanged (ya la
    // tenia), notFound (no existe esa cuenta o no tiene perfil de staff),
    // ignored (no habia nada que cambiar).
    const grupo = (nombre) => {
      const v = cuerpo && typeof cuerpo === 'object' ? cuerpo[nombre] : null;
      return Array.isArray(v) ? v.length : (v ? 1 : 0);
    };

    if (grupo('notFound')) {
      resultado.motivo = `El back office no encontro un perfil de staff para ${email}.`;
      return resultado;
    }
    if (grupo('unchanged')) {
      resultado.empujado = true;
      resultado.motivo = 'En el back office ya tenia esa certificacion cargada.';
      return resultado;
    }
    if (grupo('updated')) {
      resultado.empujado = true;
      resultado.motivo = 'Se agrego en el back office.';
      return resultado;
    }

    // Respuesta inesperada: no se da por hecho que salio bien.
    resultado.motivo = 'El back office contesto, pero sin confirmar el cambio.';
    return resultado;
  } catch (e) {
    resultado.motivo = 'No se pudo contactar al back office: ' + String(e && e.message ? e.message : e);
    return resultado;
  }
}

module.exports = { empujarCertificacionAlBO, empujarCursoHabilitadoAlBO };
