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

  const productId = productoDeCurso(cert.curso);
  if (!productId) {
    resultado.motivo = `El curso "${cert.curso}" todavia no tiene un producto equivalente cargado en lib/cursosProductos.js, asi que no se empuja (hay que completarlo a mano alla).`;
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
      body: JSON.stringify({ items: [{ email: cert.email, add: [productId] }] }),
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
      resultado.motivo = `El back office no encontro un perfil de staff para ${cert.email}.`;
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

module.exports = { empujarCertificacionAlBO };
