// ============================================================================
// Envio de mails transaccionales via Loops (app.loops.so), la misma
// plataforma de mail que ya usa Coderhouse para el resto de las
// comunicaciones a Staff (recordatorios de validaciones, avisos de
// suplencias, etc.) - no se suma un servicio de mail nuevo.
//
// Variable de entorno que necesita (se configura en Vercel > Project
// Settings > Environment Variables):
//   LOOPS_API_KEY  -> API key de Loops (Settings > API en app.loops.so).
//                     Tiene que ser una key del team "Coderhouse Staff".
//
// Las dos plantillas de "Certificacion aprobada/desaprobada" ya estan
// creadas y publicadas en Loops (mismo remitente y estilo que el resto de
// los mails a Staff: from "gestioninterna@<dominio de Coderhouse en
// Loops>", reply-to operaciones@coderhouse.com). Sus IDs son fijos (no
// cambian salvo que alguien las borre y las rehaga en Loops), asi que se
// dejan hardcodeados aca en vez de sumar mas Environment Variables:
//   - "Staff · Certificación aprobada"     -> cmuftu5cq07980jwpl7sqc9mq
//   - "Staff · Certificación desaprobada"  -> cmuftu6y2074n0jyz7p58x6qz
// Se pueden editar el asunto/texto desde app.loops.so cuando haga falta,
// sin tocar este archivo (mientras no se borren o se creen de nuevo).
// ============================================================================

const LOOPS_API_URL = 'https://app.loops.so/api/v1/transactional';

const TRANSACTIONAL_IDS = {
  aprobado: 'cmuftu5cq07980jwpl7sqc9mq',
  desaprobado: 'cmuftu6y2074n0jyz7p58x6qz',
};

// Envia un mail transaccional de Loops. No tira excepcion si falla (un mail
// que no sale no tiene por que romper el flujo de aprobar/desaprobar una
// certificacion) - siempre devuelve { enviado, motivo? }.
async function enviarMailLoops(transactionalId, email, dataVariables) {
  const apiKey = process.env.LOOPS_API_KEY;
  if (!apiKey) {
    console.log('[loops] Falta LOOPS_API_KEY en las Environment Variables de Vercel, no se envia mail a', email);
    return { enviado: false, motivo: 'Falta configurar LOOPS_API_KEY en Vercel' };
  }
  try {
    const resp = await fetch(LOOPS_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify({ transactionalId, email, dataVariables }),
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || data.success !== true) {
      const motivo = (data && data.message) || ('HTTP ' + resp.status);
      console.log('[loops] No se pudo enviar el mail a', email, ':', motivo);
      return { enviado: false, motivo };
    }
    return { enviado: true };
  } catch (e) {
    console.log('[loops] Error de red enviando mail a', email, ':', e && e.message);
    return { enviado: false, motivo: String(e && e.message ? e.message : e) };
  }
}

async function enviarMailCertificacionAprobada({ email, nombre, curso, rol, nota }) {
  return enviarMailLoops(TRANSACTIONAL_IDS.aprobado, email, {
    nombre: nombre || '',
    curso: curso || '',
    rol: rol === 'profesor' ? 'Profesor' : 'Tutor Adjunto',
    nota: nota != null ? String(nota) : '',
  });
}

async function enviarMailCertificacionDesaprobada({ email, nombre, curso, rol, cooldownHasta }) {
  return enviarMailLoops(TRANSACTIONAL_IDS.desaprobado, email, {
    nombre: nombre || '',
    curso: curso || '',
    rol: rol === 'profesor' ? 'Profesor' : 'Tutor Adjunto',
    cooldownHasta: cooldownHasta ? new Date(cooldownHasta).toLocaleDateString('es-AR') : '',
  });
}

module.exports = { enviarMailCertificacionAprobada, enviarMailCertificacionDesaprobada };
