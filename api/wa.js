// ═══════════════════════════════════════════════════════════
// 💬 /api/wa · las respuestas del WhatsApp de los lunes
// ═══════════════════════════════════════════════════════════
// Meta avisa aquí cuando alguien toca un botón de la plantilla del lunes, cuando
// escribe y cuando un mensaje se entrega, se lee o falla. Lo que hace:
//   1. «La tarjeta», «La melodía», «El video»: le manda esa pieza, igual que la sala
//      de envío (/wa), dentro de la conversación que abrió el toque: sin plantilla.
//   2. «BAJA» o «STOP» (solo esa palabra): marca la baja en la hoja por el puente del
//      Apps Script y, si quedó marcada, se lo confirma. Si no se pudo por una falla
//      pasajera, contesta 500 para que Meta repita el aviso más tarde.
//   3. Entregado, leído, fallido y cada botón: los anota en la hoja para el resumen.
//   4. user_preferences (C485): quien deja de aceptar el marketing desde el menú de
//      WhatsApp queda de baja en la hoja; si lo vuelve a aceptar, solo se anota.
//   5. message_template_status_update (C485): si Meta pausa, desactiva, marca o rechaza
//      una plantilla nuestra (triggui_…), el Apps Script le escribe a Badir.
// Lo demás que escriban le llega a Badir en su app de WhatsApp Business: aquí no se contesta.
//
// Reglas (viven aquí, en el mecanismo):
//   1. Puerta cerrada por defecto: si falta una variable o una clave mide menos de
//      32 caracteres, responde 503 y no hace nada.
//   2. Cada aviso trae la firma de Meta (X-Hub-Signature-256): se comprueba sobre los
//      bytes tal cual llegaron, en tiempo constante. Sin firma válida, 401.
//   3. Solo se atiende el número de WA_NUMERO_ID; lo demás se ignora. Los avisos de
//      plantillas no traen número: se atienden solo las que se llaman triggui_….
//   4. La carga de cada botón la arma el Apps Script al mandar; aquí se valida campo
//      por campo antes de usarla.
//   5. Lo que no se pudo anotar por una falla pasajera se le devuelve a Meta con 500,
//      para que repita el aviso (lección 559 del Cerebro).
//
// Variables en Vercel: WA_VERIFY_TOKEN · WA_APP_SECRET · WA_TOKEN · WA_NUMERO_ID ·
//   WA_PUENTE_URL (la dirección /exec del Apps Script) · WA_PUENTE_CLAVE · (opcional) WA_VERSION
// ═══════════════════════════════════════════════════════════

import { createHmac, timingSafeEqual } from 'crypto';

const LARGO_MINIMO = 32;
const APP = 'https://app.triggui.com/';
const RAW = 'https://raw.githubusercontent.com/badirnakid/triggui-content/main/';
const MARCA = '?w=s&utm_content=lunes';   // la página la vuelve utm_source=whatsapp · utm_medium=sala
const CACHE_MS = 10 * 60 * 1000;
const ADIOS = {
  es: 'Listo, ya no te llegará el libro de los lunes. Gracias por leer con Triggui 💛 Cuando se te antoje otro libro, te espera en la app: https://app.triggui.com',
  en: "Done, you won't get the Monday book anymore. Thanks for reading with Triggui 💛 Whenever you feel like another book, it's waiting for you in the app: https://app.triggui.com"
};
const cache = new Map();

const env = (k) => String(process.env[k] || '').trim();
const version = () => (/^v\d{2}\.\d$/.test(env('WA_VERSION')) ? env('WA_VERSION') : 'v26.0');

function respuesta(texto, status) {
  return new Response(texto, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export function iguales(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export function firmaValida(bytes, cabecera, secreto) {
  const m = /^sha256=([0-9a-f]{64})$/i.exec(String(cabecera || '').trim());
  if (!m || !secreto) return false;
  const esperada = createHmac('sha256', secreto).update(bytes).digest();
  const recibida = Buffer.from(m[1], 'hex');
  return recibida.length === esperada.length && timingSafeEqual(recibida, esperada);
}

export function listo() {
  return ['WA_APP_SECRET', 'WA_TOKEN', 'WA_NUMERO_ID'].every((k) => env(k)) &&
    /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(env('WA_PUENTE_URL')) &&
    env('WA_PUENTE_CLAVE').length >= LARGO_MINIMO;
}

// Meta comprueba la dirección una vez, al configurarla: devuelve el reto si el token coincide.
export async function GET(request) {
  const esperado = env('WA_VERIFY_TOKEN');
  if (esperado.length < LARGO_MINIMO) return respuesta('Puerta cerrada.', 503);
  const q = new URL(request.url).searchParams;
  const reto = q.get('hub.challenge') || '';
  if (q.get('hub.mode') === 'subscribe' && iguales(q.get('hub.verify_token') || '', esperado) && /^[0-9A-Za-z_-]{1,200}$/.test(reto)) {
    return respuesta(reto, 200);
  }
  return respuesta('No.', 403);
}

export async function POST(request) {
  if (!listo()) return respuesta('Puerta cerrada.', 503);
  const bytes = Buffer.from(await request.arrayBuffer());
  if (!firmaValida(bytes, request.headers.get('x-hub-signature-256'), env('WA_APP_SECRET'))) return respuesta('Firma inválida.', 401);
  let datos;
  try { datos = JSON.parse(bytes.toString('utf8')); } catch { return respuesta('ok', 200); }
  const tareas = [];
  for (const entrada of (Array.isArray(datos && datos.entry) ? datos.entry : [])) {
    for (const cambio of (Array.isArray(entrada && entrada.changes) ? entrada.changes : [])) {
      const v = (cambio && cambio.value) || {};
      const nuestro = String((v.metadata || {}).phone_number_id || '') === env('WA_NUMERO_ID');
      if (cambio && cambio.field === 'messages' && nuestro) {
        for (const m of (Array.isArray(v.messages) ? v.messages : [])) tareas.push(atenderMensaje(m));
        for (const s of (Array.isArray(v.statuses) ? v.statuses : [])) tareas.push(anotarEstado(s));
      } else if (cambio && cambio.field === 'user_preferences' && nuestro) {
        for (const u of (Array.isArray(v.user_preferences) ? v.user_preferences : [])) tareas.push(anotarPreferencia(u));
      } else if (cambio && cambio.field === 'message_template_status_update') {
        tareas.push(anotarPlantilla(v, entrada && entrada.id, entrada && entrada.time));
      }
    }
  }
  const resultados = await Promise.allSettled(tareas);
  // Una baja, una preferencia o un aviso de plantilla que no se pudo anotar por una falla pasajera (candado, red,
  // Apps Script lento) no se pierde:
  // se contesta 500 para que Meta vuelva a mandar el aviso más tarde.
  if (resultados.some((r) => r.status === 'fulfilled' && r.value === REINTENTAR)) return respuesta('Reintentar.', 500);
  return respuesta('ok', 200);
}

const REINTENTAR = 'reintentar';
const atendidos = new Map();   // ids de mensajes ya atendidos en esta instancia (Meta puede repetir un aviso)
function yaAtendido(id) {
  const ahora = Date.now();
  for (const [k, t] of atendidos) if (ahora - t > CACHE_MS) atendidos.delete(k);
  return !!id && atendidos.has(id);
}
function marcarAtendido(id) { if (id) atendidos.set(id, Date.now()); }
export function olvidarAtendidos() { atendidos.clear(); }

export async function atenderMensaje(m) {
  const tel = String((m && m.from) || '').replace(/\D/g, '');
  if (!/^\d{8,15}$/.test(tel)) return;
  const id = String(m.id || '');
  if (yaAtendido(id)) return;
  if (m.type === 'button' && m.button) {
    const p = leerCarga(m.button.payload);
    if (!p) return;
    const anotar = puente({ tipo: 'boton', tel, wamid: String((m.context || {}).id || ''), accion: p.accion, slug: p.slug });
    const pieza = await armarPieza(p);   // la pieza no espera a la hoja: sale en cuanto está lista
    const [, salio] = await Promise.all([anotar, pieza ? mandar(tel, pieza) : Promise.resolve(false)]);
    if (salio) marcarAtendido(id);
    return;
  }
  if (m.type === 'text' && m.text) {
    const palabra = palabraDeBaja(m.text.body);
    if (!palabra) return;
    const r = await puente({ tipo: 'baja', tel, motivo: 'BAJA' });
    if (r.ok) {
      marcarAtendido(id);
      await mandar(tel, { type: 'text', text: { body: palabra === 'stop' ? ADIOS.en : ADIOS.es } });
      return;
    }
    if (!r.definitivo) {
      console.error('wa: una baja no se pudo anotar en la hoja (' + r.error + '); Meta reintentará el aviso');
      return REINTENTAR;
    }
    console.error('wa: una baja que la hoja no pudo marcar (' + r.error + '); le llega a Badir en su app');
  }
}

export async function anotarEstado(s) {
  const estado = String((s && s.status) || '');
  if (!['delivered', 'read', 'failed'].includes(estado)) return;
  const err = (Array.isArray(s.errors) && s.errors[0]) || {};
  await puente({ tipo: 'estado', wamid: String(s.id || ''), tel: String(s.recipient_id || ''), estado,
    codigo: String(err.code || ''), detalle: String(err.title || err.message || '').slice(0, 200) });
}

// Lo que Meta documenta para message_template_status_update (página del 17 de noviembre de 2026).
const EVENTOS_PLANTILLA = ['APPROVED', 'ARCHIVED', 'UNARCHIVED', 'DELETED', 'DISABLED', 'FLAGGED', 'IN_APPEAL',
  'LIMIT_EXCEEDED', 'LOCKED', 'PAUSED', 'PENDING', 'REINSTATED', 'PENDING_DELETION', 'REJECTED'];

// C485 · user_preferences: «stop» deja a la persona de baja en la hoja; «resume» solo se anota (volver a mandarle
// lo decide Badir). Sin teléfono (nombre de usuario sin número compartido) no hay con qué buscarla en la hoja.
export async function anotarPreferencia(u) {
  if (!u || u.category !== 'marketing_messages' || !['stop', 'resume'].includes(u.value)) return;
  const tel = String(u.wa_id || '').replace(/\D/g, '');
  if (!/^\d{8,15}$/.test(tel)) { console.error('wa: una preferencia de marketing llegó sin teléfono; no se pudo anotar'); return; }
  const id = 'up|' + tel + '|' + u.value + '|' + String(u.timestamp || '');
  if (yaAtendido(id)) return;
  // «cuando» deja que el Apps Script atienda una sola vez el mismo aviso aunque Meta lo repita en otra instancia.
  const r = await puente({ tipo: 'preferencia', tel, valor: u.value, cuando: String(u.timestamp || '').replace(/\D/g, '').slice(0, 12) });
  if (r.ok || r.definitivo) {
    marcarAtendido(id);
    if (!r.ok) console.error('wa: una preferencia de marketing que la hoja no marcó (' + r.error + ')');
    return;
  }
  console.error('wa: una preferencia de marketing no se pudo anotar (' + r.error + '); Meta reintentará el aviso');
  return REINTENTAR;
}

// C485 · message_template_status_update: solo plantillas nuestras (triggui_…) y solo los eventos que documenta Meta.
export async function anotarPlantilla(v, waba, cuando) {
  const nombre = String((v && v.message_template_name) || '');
  const evento = String((v && v.event) || '');
  if (!/^triggui_[a-z0-9_]{1,60}$/.test(nombre) || !EVENTOS_PLANTILLA.includes(evento)) return;
  const otro = (v.other_info && typeof v.other_info === 'object') ? v.other_info : {};
  const id = 'pl|' + String(v.message_template_id || nombre) + '|' + String(v.message_template_language || '') + '|' + evento + '|' + String(cuando || '');
  if (yaAtendido(id)) return;
  const r = await puente({ tipo: 'plantilla', nombre, evento, idioma: limpia(v.message_template_language, 12),
    motivo: limpia(v.reason, 60), titulo: limpia(otro.title, 60), descripcion: limpia(otro.description, 300),
    waba: String(waba || '').replace(/\D/g, '').slice(0, 30), id: String(v.message_template_id || '').replace(/\D/g, '').slice(0, 30),
    cuando: String(cuando || '').replace(/\D/g, '').slice(0, 12) });
  if (r.ok || r.definitivo) { marcarAtendido(id); return; }
  console.error('wa: un aviso de plantilla no se pudo anotar (' + r.error + '); Meta reintentará el aviso');
  return REINTENTAR;
}

// «tg1|accion|a o k|slug|es o en|melodía|video»: la arma waPayload_ del Apps Script.
export function leerCarga(texto) {
  const p = String(texto || '').split('|');
  if (p.length !== 7 || p[0] !== 'tg1') return null;
  const [, accion, cat, slug, lang, m, v] = p;
  if (!['tarjeta', 'melodia', 'video'].includes(accion) || !['a', 'k'].includes(cat) || !/^[a-z0-9-]{1,120}$/.test(slug) ||
      !['es', 'en'].includes(lang) || !/^[0-9]$/.test(m) || !/^[0-9]$/.test(v)) return null;
  if (cat === 'k' && accion === 'video') return null;
  return { accion, cat, slug, lang, m: Number(m), v: Number(v) };
}

// Solo la palabra sola: «BAJA», «baja.», «Dar de baja», «STOP». Una frase más larga la contesta Badir.
export function palabraDeBaja(texto) {
  const t = String(texto || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (t === 'baja' || t === 'dar de baja' || t === 'darme de baja') return 'baja';
  if (t === 'stop' || t === 'unsubscribe') return 'stop';
  return '';
}

// Lo mismo que la sala (/wa) y el Apps Script: las tres primeras con vista previa o con video.
export const tieneEn = (b) => !!(b && b.tarjeta_en && (b.frases_en || []).length);
export const musica = (b) => ((b._musica || {}).candidatos || []).filter((c) => c && c.preview).slice(0, 3);
export const videos = (b) => ((b._video || {}).candidatos || []).filter((c) => c && c.id).slice(0, 3);
const limpia = (t, max) => {
  let s = String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
  if (max && s.length > max) s = s.slice(0, max - 1).trim() + '…';
  return s;
};

async function cargarCatalogo(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const j = await r.json();
    const c = { t: Date.now(), libros: Array.isArray(j && j.libros) ? j.libros : [] };
    cache.set(url, c);
    return c;
  } catch { return null; }
}

// Con la caché tibia, un slug que no aparece hace releer el catálogo una vez (puede ser una edición recién publicada).
export async function libroPorSlug(slug, kids) {
  const url = RAW + (kids ? 'contenido_kids.json' : 'contenido_manual.json');
  let c = cache.get(url);
  let fresco = false;
  if (!c || Date.now() - c.t > CACHE_MS) { c = await cargarCatalogo(url); fresco = true; }
  if (!c) return null;
  let libro = c.libros.find((b) => b && b._slug === slug) || null;
  if (!libro && !fresco) {
    c = await cargarCatalogo(url);
    libro = c ? (c.libros.find((b) => b && b._slug === slug) || null) : null;
  }
  return libro;
}
export function limpiarCache() { cache.clear(); }

// Como la sala: solo un 404 (u otra respuesta de error) cuenta como «no hay página»; si la red falla, se usa la página.
async function existe(url) {
  try { return (await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(2000) })).ok; } catch { return true; }
}

// La pieza que pidió, con el mismo texto y las mismas ligas que arma la sala de envío.
export async function armarPieza(p) {
  const libro = await libroPorSlug(p.slug, p.cat === 'k');
  if (!libro) return null;
  const en = p.lang === 'en' && tieneEn(libro);
  const ruta = APP + (p.cat === 'k' ? 'kids/t/' : 't/') + p.slug + '/';
  if (p.accion === 'tarjeta') {
    const f = (en ? libro.frases_en : libro.frases) || [];
    return { type: 'image', image: { link: ruta + (en ? 'tarjeta_en.png' : 'tarjeta.png'),
      caption: limpia(f[1 % Math.max(1, f.length)] || f[0] || '', 1024) } };   // la tarjeta lleva la SIGUIENTE frase
  }
  if (p.accion === 'melodia') {
    const c = musica(libro)[p.m];
    if (!c) return { type: 'text', text: { body: en ? 'This edition has no music.' : 'Esta edición no trae melodía.' } };
    const pagina = ruta + 'pieza/' + (p.m ? p.m + '/' : '');   // se mira la página exacta que se va a mandar
    const url = (await existe(pagina)) ? pagina + MARCA : ruta + (en ? 'en/' : '') + MARCA + '&p=1&m=' + p.m;
    return { type: 'text', text: { preview_url: true,
      body: ((!en && c.pie) ? c.pie + '\n\n' : '') + '🎧 ' + c.cancion + ' — ' + c.artista + '\n' + url } };
  }
  const c = videos(libro)[p.v];
  if (!c) return { type: 'text', text: { body: en ? 'This edition has no video.' : 'Esta edición no trae video.' } };
  const pagina = ruta + 'video/' + (p.v ? p.v + '/' : '');
  return { type: 'text', text: { preview_url: true, body: (await existe(pagina)) ? pagina + MARCA : 'https://youtu.be/' + c.id } };
}

export async function mandar(tel, mensaje) {
  try {
    const r = await fetch(`https://graph.facebook.com/${version()}/${encodeURIComponent(env('WA_NUMERO_ID'))}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env('WA_TOKEN'), 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ messaging_product: 'whatsapp', recipient_type: 'individual', to: tel }, mensaje)),
      signal: AbortSignal.timeout(5000)
    });
    return r.ok;
  } catch { return false; }
}

// El puente al Apps Script (doPost, action=wa_puente).
//   ok: el Apps Script dijo ok.  definitivo: dijo que no con su razón («sin_fila», «clave», «tel»…): reintentar no cambia nada.
//   Lo demás (red, tiempo, candado ocupado, respuesta que no es JSON) es pasajero: definitivo es false.
export async function puente(datos) {
  const cuerpo = new URLSearchParams({ action: 'wa_puente', clave: env('WA_PUENTE_CLAVE') });
  for (const [k, v] of Object.entries(datos)) cuerpo.set(k, String(v == null ? '' : v));
  try {
    const r = await fetch(env('WA_PUENTE_URL'), { method: 'POST', body: cuerpo, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return { ok: false, definitivo: false, error: 'http' };
    const j = await r.json();
    if (j && j.ok === true) return { ok: true, definitivo: true, error: '' };
    const error = (j && typeof j.error === 'string') ? j.error : '';
    // «clave» es de configuración: se arregla en Vercel o en el Apps Script, así que tampoco es definitivo.
    return { ok: false, definitivo: !!error && error !== 'clave', error: error || 'pasajero' };
  } catch { return { ok: false, definitivo: false, error: 'red' }; }
}
