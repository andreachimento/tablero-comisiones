// ============================================================================
// FUNCION SERVERLESS: listado de Staff
// ============================================================================
// Trae a TODOS los profesores/tutores que existen como usuarios reales en el
// back office de Coderhouse (rol INSTRUCTOR) y les suma la info que se guarda
// en la base de datos propia del tablero (estado, cursos habilitados,
// rating). Tambien agrega los perfiles "extraidos de Dash" (gente que esta en
// la base de habilitados de Andrea pero todavia no participo en el back
// office).
//
// Esta consulta SI vuelve a pedir la lista de instructores a Coderhouse cada
// vez (son solo ~8 paginas), asi que siempre refleja altas/bajas reales de
// cuentas. Lo que puede tardar un poquito mas es el historial de comisiones
// de cada persona: eso se trae aparte, solo cuando se abre su perfil
// (api/staff-profile.js), para no tener que traer miles de asignaciones acá.
// ============================================================================

const { getAllOverlays, defaultOverlay } = require('../lib/overlay');

const TZ = 'America/Argentina/Buenos_Aires';

function getEnv() {
  const BASE = process.env.BACKOFFICE_API_URL;
  const STUDENT_KEY = process.env.CLAUDE_STUDENT_API_KEY;
  if (!BASE || !STUDENT_KEY) {
    throw new Error('Faltan Environment Variables en Vercel (BACKOFFICE_API_URL / CLAUDE_STUDENT_API_KEY).');
  }
  return { BASE, STUDENT_KEY };
}

async function apiGet(base, path, key, retries) {
  const maxRetries = retries == null ? 2 : retries;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(base + path, { headers: { 'X-API-Key': key } });
      const text = await resp.text();
      if (resp.ok) {
        try { return JSON.parse(text); } catch (e) { /* reintenta */ }
      }
    } catch (e) { /* reintenta */ }
    if (attempt < maxRetries) await new Promise(r => setTimeout(r, 350 * (attempt + 1)));
  }
  return {};
}

async function fetchAllInstructors(env) {
  const first = await apiGet(env.BASE, '/platform/user/m2m/admin/users?role=INSTRUCTOR&page=1&limit=100', env.STUDENT_KEY);
  let all = (first.items || []).slice();
  const totalPages = Math.min(first.totalPages || 1, 30);
  if (totalPages > 1) {
    const proms = [];
    for (let p = 2; p <= totalPages; p++) {
      proms.push(apiGet(env.BASE, `/platform/user/m2m/admin/users?role=INSTRUCTOR&page=${p}&limit=100`, env.STUDENT_KEY));
    }
    const results = await Promise.all(proms);
    results.forEach(d => { all = all.concat(d.items || []); });
  }
  return all;
}

function avgRating(ratings) {
  const vals = Object.values(ratings || {}).filter(v => typeof v === 'number' && v > 0);
  if (!vals.length) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
}

module.exports = async function handler(req, res) {
  try {
    const env = getEnv();
    const [instructors, overlays] = await Promise.all([
      fetchAllInstructors(env),
      getAllOverlays().catch(err => {
        // Si todavia no esta conectada la base de datos, seguimos mostrando
        // el listado del back office igual (sin estado/cursos/rating), en
        // vez de romper toda la pestaña.
        return { __error: String(err && err.message ? err.message : err) };
      }),
    ]);

    const overlayError = overlays && overlays.__error ? overlays.__error : null;
    const overlayMap = overlayError ? {} : overlays;

    const byEmail = {};
    instructors.forEach(u => {
      const email = String(u.email || '').toLowerCase().trim();
      if (!email) return;
      const nombre = `${u.firstName || ''} ${u.lastName || ''}`.trim() || email.split('@')[0];
      byEmail[email] = { email, nombre, source: 'backoffice' };
    });

    // Perfiles "extraidos de Dash": estan en la base de habilitados propia
    // pero no tienen (todavia) una cuenta de instructor real en el back office.
    Object.keys(overlayMap).forEach(email => {
      if (byEmail[email]) return;
      const ov = overlayMap[email];
      if (!ov || !ov.esDash) return;
      const nombre = `${ov.nombre || ''} ${ov.apellido || ''}`.trim() || email.split('@')[0];
      byEmail[email] = { email, nombre, source: 'dash' };
    });

    const staff = Object.values(byEmail).map(p => {
      const ov = overlayMap[p.email] || defaultOverlay();
      const cursos = ov.cursosHabilitados || [];
      const roles = Array.from(new Set(cursos.map(c => c.rol).filter(Boolean)));
      const ratingVals = Object.values(ov.ratings || {}).filter(v => typeof v === 'number' && v > 0);
      return {
        email: p.email,
        nombre: p.nombre,
        source: p.source,
        estado: ov.estado || 'aprobado',
        cursosHabilitados: cursos,
        roles,
        ratingPromedio: avgRating(ov.ratings),
        ratingCount: ratingVals.length,
      };
    });

    staff.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));

    res.status(200).json({
      staff,
      total: staff.length,
      overlayError,
      lastUpdate: new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()).replace(',', ''),
    });
  } catch (err) {
    res.status(200).json({ error: String(err && err.message ? err.message : err) });
  }
};
