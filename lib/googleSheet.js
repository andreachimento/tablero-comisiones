// ============================================================================
// Acceso de solo lectura a UNA planilla de Google Sheets privada, usando una
// cuenta de servicio de Google (no un usuario real). No se agrega ninguna
// libreria nueva: se arma "a mano" el JWT firmado que pide Google para dar un
// token de acceso, con el modulo "crypto" que ya trae Node.
//
// Variables de entorno que necesita (se configuran en Vercel > Project
// Settings > Environment Variables), separadas de las de la API de
// Coderhouse:
//   GOOGLE_SERVICE_ACCOUNT_EMAIL  -> el "client_email" del JSON de la cuenta
//                                    de servicio (algo asi como
//                                    nombre@proyecto.iam.gserviceaccount.com)
//   GOOGLE_SERVICE_ACCOUNT_KEY    -> el "private_key" de ese mismo JSON
//                                    (se puede pegar tal cual, con los saltos
//                                    de linea reales o escapados con \n, las
//                                    dos formas andan)
// ============================================================================

const crypto = require('crypto');

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function getCredentials() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!email || !rawKey) {
    throw new Error('Faltan Environment Variables en Vercel (GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_KEY).');
  }
  // Si se pegaron los saltos de linea "escapados" (\n como dos caracteres en
  // vez de un salto real, que es como quedan a veces al copiar un JSON),
  // los convertimos a saltos de linea reales, que es lo que pide la clave PEM.
  const privateKey = rawKey.indexOf('\\n') !== -1 ? rawKey.replace(/\\n/g, '\n') : rawKey;
  return { email, privateKey };
}

let cachedToken = null; // { token, exp } en memoria del proceso (dura mientras la funcion serverless esta "caliente")

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.token;

  const { email, privateKey } = getCredentials();
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const unsigned = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(claim));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = base64url(signer.sign(privateKey));
  const jwt = unsigned + '.' + signature;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + jwt,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) {
    throw new Error('No se pudo autenticar con Google Sheets: ' + JSON.stringify(data));
  }
  cachedToken = { token: data.access_token, exp: now + (data.expires_in || 3600) };
  return data.access_token;
}

// Devuelve el nombre (titulo) de la solapa cuyo gid coincide, para poder
// armar el rango del values.get (esa API pide el NOMBRE de la solapa, no el
// gid que se ve en la URL del navegador).
async function getSheetTitleByGid(spreadsheetId, gid) {
  const token = await getAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error('No se pudo leer la lista de solapas de la planilla: ' + JSON.stringify(data));
  const sheets = (data.sheets || []).map(s => s.properties);
  const match = sheets.find(p => String(p.sheetId) === String(gid));
  if (!match) throw new Error(`No se encontro ninguna solapa con gid=${gid} en la planilla.`);
  return match.title;
}

// Trae TODAS las filas (como matriz de arrays) de una solapa puntual.
async function getSheetValues(spreadsheetId, gid) {
  const title = await getSheetTitleByGid(spreadsheetId, gid);
  const token = await getAccessToken();
  const range = `'${title.replace(/'/g, "''")}'`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error('No se pudo leer la planilla de postulaciones: ' + JSON.stringify(data));
  return data.values || [];
}

module.exports = { getSheetValues };
