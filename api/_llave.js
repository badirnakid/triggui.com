// ════════════════════════════════════════════════════════════════════════
// 🔑 _llave.js · la ÚNICA cerradura de las puertas internas de triggui.com
// ════════════════════════════════════════════════════════════════════════
// La usan /api/detonar, /api/agregar-libro, /api/debug-verify y /api/sesion.
//
// Reglas (viven aquí, en el mecanismo, no en la memoria de nadie):
//   1. La llave vive SOLO en Vercel (variables de entorno). Nunca en el repo.
//   2. No hay llave por defecto: si la variable falta o mide menos de
//      32 caracteres, la puerta queda CERRADA (503). Jamás abierta.
//   3. La comparación es en tiempo constante.
//   4. Llave incorrecta: pausa fija antes de responder 401 (frena la adivinanza).
//   5. Aparato reconocido: al entrar una vez con la llave, el servidor deja una
//      sesión en ese aparato (cookie firmada que el código de la página no puede
//      leer). Dura 90 días y se renueva sola en cada uso. Cambiar la llave en
//      Vercel cierra todas las sesiones de esa puerta.
//   6. Una sesión solo vale para peticiones nacidas en el propio sitio.
//
// El guion bajo del nombre evita que Vercel publique este archivo como ruta.
// ════════════════════════════════════════════════════════════════════════

import { createHash, createHmac, timingSafeEqual } from 'crypto';

export const LARGO_MINIMO = 32;
export const PAUSA_MS = 800;
export const DIAS_SESION = 90;
const SEGUNDOS_SESION = DIAS_SESION * 86400;

// Cada puerta tiene su variable en Vercel y su propia cookie de sesión.
// El prefijo __Host- obliga al navegador a aceptarla solo por HTTPS y solo para este sitio.
export const PUERTAS = {
  agregar: { variable: 'AGREGAR_LLAVE', cookie: '__Host-tg_agregar' },
  detonar: { variable: 'DETONAR_LLAVE', cookie: '__Host-tg_detonar' },
};

function huella(texto) {
  return createHash('sha256').update(String(texto), 'utf8').digest();
}
function iguales(a, b) {
  return timingSafeEqual(huella(a), huella(b));
}
function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function llaveDe(puerta) {
  const p = PUERTAS[puerta];
  const v = p ? String(process.env[p.variable] || '').trim() : '';
  return v.length >= LARGO_MINIMO ? v : '';
}

// ── Sesión: "v1.<vence en segundos>.<firma>" ─────────────────────────────
// La firma depende de la llave de esa puerta: si la llave cambia, la sesión muere.
function firmar(puerta, llave, vence) {
  const claveFirma = createHmac('sha256', llave).update('triggui-sesion-v1').digest();
  return b64url(createHmac('sha256', claveFirma).update('v1|' + puerta + '|' + vence).digest());
}
function crearSesion(puerta, llave, ahoraMs) {
  const vence = Math.floor(ahoraMs / 1000) + SEGUNDOS_SESION;
  return 'v1.' + vence + '.' + firmar(puerta, llave, vence);
}
function sesionValida(puerta, llave, valor, ahoraMs) {
  const partes = String(valor || '').split('.');
  if (partes.length !== 3 || partes[0] !== 'v1') return false;
  const vence = Number(partes[1]);
  if (!Number.isSafeInteger(vence) || String(vence) !== partes[1]) return false;
  if (vence * 1000 <= ahoraMs) return false;
  return iguales(partes[2], firmar(puerta, llave, vence));
}

// ── Cookies ──────────────────────────────────────────────────────────────
function leerCookies(req) {
  const crudo = String((req && req.headers && req.headers.cookie) || '');
  const mapa = {};
  crudo.split(';').forEach((par) => {
    const i = par.indexOf('=');
    if (i > 0) mapa[par.slice(0, i).trim()] = par.slice(i + 1).trim();
  });
  return mapa;
}
function ponerCookie(res, puerta, valor, segundos) {
  const nombre = PUERTAS[puerta].cookie + '=';
  const texto = nombre + valor + '; Max-Age=' + segundos + '; Path=/; HttpOnly; Secure; SameSite=Strict';
  const previas = res.getHeader('Set-Cookie');
  const lista = previas ? (Array.isArray(previas) ? previas.slice() : [String(previas)]) : [];
  // una sola cookie por puerta en cada respuesta: la última manda
  const limpia = lista.filter((c) => String(c).indexOf(nombre) !== 0);
  limpia.push(texto);
  res.setHeader('Set-Cookie', limpia);
}

// Una sesión por cookie solo vale si la petición nació en el propio sitio.
// (Quien manda la llave en el cuerpo no necesita esta comprobación: ya probó que la tiene.)
export function mismoSitio(req) {
  const h = (req && req.headers) || {};
  const sfs = String(h['sec-fetch-site'] || '').toLowerCase();
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') return false;
  const origen = String(h.origin || '');
  if (origen) {
    const host = String(h['x-forwarded-host'] || h.host || '').toLowerCase();
    let hostOrigen = '';
    try { hostOrigen = new URL(origen).host.toLowerCase(); } catch (_) { return false; }
    if (!host || hostOrigen !== host) return false;
  }
  return true;
}

async function rechazar(res) {
  await new Promise((listo) => setTimeout(listo, PAUSA_MS));
  res.status(401).json({ error: 'Llave inválida.' });
  return false;
}

// Devuelve true si quien llama puede pasar por esa puerta.
// Si no, YA respondió (503, 403 o 401) y devuelve false: quien llama solo hace return.
export async function exigirAcceso(req, res, puerta, llaveRecibida) {
  const p = PUERTAS[puerta];
  const esperada = llaveDe(puerta);
  if (!p || !esperada) {
    res.status(503).json({
      error: 'Puerta cerrada: falta configurar ' + (p ? p.variable : 'la llave') +
        ' en Vercel (mínimo ' + LARGO_MINIMO + ' caracteres).',
    });
    return false;
  }
  const ahora = Date.now();
  const recibida = String(llaveRecibida == null ? '' : llaveRecibida).trim();

  // 1. Llegó una llave: manda la llave.
  if (recibida) {
    if (!iguales(recibida, esperada)) return rechazar(res);
    // El aparato queda reconocido en cada puerta que esa misma llave abre.
    Object.keys(PUERTAS).forEach((otra) => {
      const suLlave = llaveDe(otra);
      if (suLlave && iguales(recibida, suLlave)) {
        ponerCookie(res, otra, crearSesion(otra, suLlave, ahora), SEGUNDOS_SESION);
      }
    });
    return true;
  }

  // 2. Sin llave: ¿este aparato ya está reconocido?
  const valor = leerCookies(req)[p.cookie];
  if (valor && sesionValida(puerta, esperada, valor, ahora)) {
    if (!mismoSitio(req)) {
      res.status(403).json({ error: 'Petición de otro sitio. No se acepta.' });
      return false;
    }
    ponerCookie(res, puerta, crearSesion(puerta, esperada, ahora), SEGUNDOS_SESION);   // se renueva sola
    return true;
  }
  return rechazar(res);
}

// Qué puertas reconoce este aparato. Renueva las sesiones válidas.
export function estadoSesion(req, res) {
  const ahora = Date.now();
  const galletas = leerCookies(req);
  const estado = {};
  Object.keys(PUERTAS).forEach((puerta) => {
    const llave = llaveDe(puerta);
    const valor = galletas[PUERTAS[puerta].cookie];
    const reconocido = !!(llave && valor && sesionValida(puerta, llave, valor, ahora));
    estado[puerta] = reconocido;
    if (reconocido) ponerCookie(res, puerta, crearSesion(puerta, llave, ahora), SEGUNDOS_SESION);
  });
  return estado;
}

// Cierra la sesión de este aparato en todas las puertas.
export function cerrarSesion(res) {
  Object.keys(PUERTAS).forEach((puerta) => ponerCookie(res, puerta, '', 0));
}
