// ═══════════════════════════════════════════════════════════
// 💳 /api/stripe · los pagos de Triggui, sin intervención
// ═══════════════════════════════════════════════════════════
// Stripe avisa aquí cuando alguien paga, renueva, cancela o le falla un cobro. Lo que hace:
//   1. Comprueba la firma de Stripe (Stripe-Signature) sobre los bytes tal cual llegaron, en tiempo
//      constante y con 5 minutos de tolerancia. Sin firma válida, 400.
//   2. Se queda solo con lo de Triggui: la cuenta de Stripe también cobra los servicios de Trestme, así que
//      un pago cuenta como de Triggui solo si su monto en pesos está en STRIPE_TRIGGUI_MONTOS (si falta:
//      $149, $1,490 al año, $129 y el plan viejo de $100).
//   3. Traduce el aviso y lo pasa al Apps Script por el puente (action=stripe_puente):
//        checkout.session.completed de una suscripción pagada, o invoice.paid de alta → alta
//        invoice.paid del mes o de un cambio de plan → renovacion
//        customer.subscription.deleted → baja (cancelada)
//        customer.subscription.updated a «unpaid», «incomplete_expired» o «paused» → baja (sin pago o pausada)
//        invoice.payment_failed → fallo
//        checkout.session.completed de una suscripción con otro monto → ajeno (solo un aviso a Badir)
//      Lo demás se contesta 200 y no se toca nada.
//   3. Si el Apps Script no pudo por una falla pasajera (red, tiempo, candado ocupado, clave mal puesta),
//      contesta 500 para que Stripe repita el aviso más tarde (lo reintenta hasta 3 días). Lo definitivo
//      (sin fila, sin correo) ya le llegó a Badir por correo desde el Apps Script: 200.
//
// Reglas (viven aquí, en el mecanismo):
//   1. Puerta cerrada por defecto: sin STRIPE_WEBHOOK_SECRET (whsec_…), sin STRIPE_PUENTE_URL o con una
//      clave de menos de 32 caracteres, responde 503 y no hace nada.
//   2. Los avisos de modo de prueba se ignoran, salvo con STRIPE_ACEPTA_PRUEBA=si (para probar contra una hoja de prueba).
//   3. El monto define el plan: $149 (o $1,490 al año) y $129, en pesos; el plan viejo de $100 llega como «otro»
//      y el Apps Script lo deja como $149 y le avisa a Badir. Las bajas no traen monto: el Apps Script solo
//      toca una fila que tenga ese cliente de Stripe guardado.
//   4. Cada aviso lleva su id de Stripe: el Apps Script lo atiende una sola vez aunque llegue repetido.
//
// Variables en Vercel: STRIPE_WEBHOOK_SECRET · STRIPE_PUENTE_URL (la dirección /exec del Apps Script) ·
//   STRIPE_PUENTE_CLAVE (la misma que en las Propiedades del script) · (opcionales) STRIPE_ACEPTA_PRUEBA y
//   STRIPE_TRIGGUI_MONTOS («centavos=plan» separados por comas, con plan 149, 129 u otro; por ejemplo
//   «14900=149,149000=149,12900=129,10000=otro»)
// ═══════════════════════════════════════════════════════════

import { createHmac, timingSafeEqual } from 'crypto';

const LARGO_MINIMO = 32;
const TOLERANCIA_S = 300;
const MOTIVOS_DE_ALTA = ['subscription_create'];
const MOTIVOS_DE_RENOVACION = ['subscription_cycle', 'subscription_update'];
const MONTOS_DE_TRIGGUI = '14900=149,149000=149,12900=129,10000=otro';
const ESTADOS_DE_BAJA = { unpaid: 'sin_pago', incomplete_expired: 'sin_pago', paused: 'pausada' };

const env = (k) => String(process.env[k] || '').trim();

function respuesta(texto, status) {
  return new Response(texto, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export function listo() {
  return /^whsec_\S{16,}$/.test(env('STRIPE_WEBHOOK_SECRET')) &&
    /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(env('STRIPE_PUENTE_URL')) &&
    env('STRIPE_PUENTE_CLAVE').length >= LARGO_MINIMO;
}

// «t=…,v1=…[,v1=…][,v0=…]»: la firma es HMAC-SHA256 de «t.cuerpo» con el secreto; basta un v1 que coincida.
export function firmaValida(bytes, cabecera, secreto, ahora = Math.floor(Date.now() / 1000)) {
  let t = null;
  const firmas = [];
  for (const parte of String(cabecera || '').split(',')) {
    const i = parte.indexOf('=');
    if (i < 1) continue;
    const k = parte.slice(0, i).trim(), v = parte.slice(i + 1).trim();
    if (k === 't' && /^\d{1,12}$/.test(v)) t = Number(v);
    else if (k === 'v1' && /^[0-9a-f]{64}$/i.test(v)) firmas.push(Buffer.from(v, 'hex'));
  }
  if (!secreto || t === null || !firmas.length || Math.abs(ahora - t) > TOLERANCIA_S) return false;
  const esperada = createHmac('sha256', secreto).update(t + '.').update(bytes).digest();
  return firmas.some((f) => f.length === esperada.length && timingSafeEqual(f, esperada));
}

// Los montos de Triggui, en centavos de peso: { '14900': '149', … }. Una variable mal escrita no deja la tabla vacía.
export function montosDeTriggui() {
  const leer = (texto) => {
    const m = {};
    for (const par of String(texto || '').split(',')) {
      const [c, p] = par.split('=').map((s) => String(s || '').trim());
      if (/^\d{3,9}$/.test(c) && ['149', '129', 'otro'].includes(p)) m[String(Number(c))] = p;
    }
    return m;
  };
  const propia = leer(env('STRIPE_TRIGGUI_MONTOS'));
  return Object.keys(propia).length ? propia : leer(MONTOS_DE_TRIGGUI);
}

// '149', '129' u 'otro' si es de Triggui; vacío si no lo es (otra moneda u otro monto: un servicio de Trestme).
export function planDe(centavos, moneda) {
  if (String(moneda || '').toLowerCase() !== 'mxn') return '';
  const c = Number(centavos);
  if (!Number.isInteger(c) || c <= 0) return '';
  return montosDeTriggui()[String(c)] || '';
}

const pesos = (c) => (c === null || c === undefined || c === '' || !Number.isFinite(Number(c)) ? '' : (Number(c) / 100).toFixed(2));
const idDe = (x) => (typeof x === 'string' ? x : String((x && x.id) || ''));   // el cliente o la suscripción pueden venir expandidos
const fechaDe = (unix) => (Number(unix) > 0 ? new Date(Number(unix) * 1000).toISOString().slice(0, 10) : '');
// Desde la versión 2025-03-31 de la API, la suscripción de una factura vive en parent.subscription_details.
const suscripcionDeFactura = (f) => idDe(f.subscription) || idDe(((f.parent || {}).subscription_details || {}).subscription);

export function traducir(evento) {
  const o = (evento && evento.data && evento.data.object) || {};
  switch (evento && evento.type) {
    case 'checkout.session.completed': {
      if (o.mode !== 'subscription' || !['paid', 'no_payment_required'].includes(o.payment_status)) return null;
      const c = o.customer_details || {};
      const monto = o.amount_subtotal ?? o.amount_total;
      const plan = planDe(monto, o.currency);
      const datos = { email: c.email || o.customer_email || '', cliente: idDe(o.customer), suscripcion: idDe(o.subscription),
        monto: pesos(monto), moneda: o.currency || '' };
      if (!plan) return Object.assign({ tipo: 'ajeno' }, datos);   // no es un monto de Triggui: solo se le avisa a Badir
      return Object.assign({ tipo: 'alta', nombre: c.name || '', tel: c.phone || '', plan }, datos);
    }
    case 'invoice.paid': {
      const alta = MOTIVOS_DE_ALTA.includes(o.billing_reason);
      if (!alta && !MOTIVOS_DE_RENOVACION.includes(o.billing_reason)) return null;   // facturas sueltas: no son de la suscripción
      const monto = o.subtotal ?? o.amount_paid;
      const plan = planDe(monto, o.currency);
      if (!plan) return null;   // de Trestme, no de Triggui
      return { tipo: alta ? 'alta' : 'renovacion', email: o.customer_email || '', nombre: o.customer_name || '', tel: o.customer_phone || '',
        cliente: idDe(o.customer), suscripcion: suscripcionDeFactura(o), plan, monto: pesos(monto), moneda: o.currency || '' };
    }
    case 'customer.subscription.deleted':
      return { tipo: 'baja', motivo: 'cancelada', cliente: idDe(o.customer), suscripcion: String(o.id || '') };
    case 'customer.subscription.updated': {
      const antes = (evento.data && evento.data.previous_attributes) || {};
      const motivo = ESTADOS_DE_BAJA[o.status];
      if (!motivo || !('status' in antes) || antes.status === o.status) return null;   // solo cuando el estado cambia a uno de esos
      return { tipo: 'baja', motivo, cliente: idDe(o.customer), suscripcion: String(o.id || '') };
    }
    case 'invoice.payment_failed': {
      const monto = o.subtotal ?? o.amount_due;
      if (!planDe(monto, o.currency)) return null;   // de Trestme, no de Triggui
      return { tipo: 'fallo', email: o.customer_email || '', cliente: idDe(o.customer), suscripcion: suscripcionDeFactura(o),
        monto: pesos(o.amount_due), moneda: o.currency || '', intento: String(o.attempt_count || ''), siguiente: fechaDe(o.next_payment_attempt) };
    }
    default:
      return null;
  }
}

export async function GET() {
  return respuesta('Solo avisos de Stripe (POST).', 405);
}

export async function POST(request) {
  if (!listo()) return respuesta('Puerta cerrada.', 503);
  const bytes = Buffer.from(await request.arrayBuffer());
  if (!firmaValida(bytes, request.headers.get('stripe-signature'), env('STRIPE_WEBHOOK_SECRET'))) return respuesta('Firma inválida.', 400);
  let evento;
  try { evento = JSON.parse(bytes.toString('utf8')); } catch { return respuesta('ok', 200); }
  if (!evento || !/^evt_[A-Za-z0-9]{8,}$/.test(String(evento.id || ''))) return respuesta('ok', 200);
  if (evento.livemode !== true && env('STRIPE_ACEPTA_PRUEBA').toLowerCase() !== 'si') return respuesta('ok (modo de prueba)', 200);
  const datos = traducir(evento);
  if (!datos) return respuesta('ok', 200);
  const r = await puente(Object.assign({ evento: evento.id }, datos));
  if (r.ok || r.definitivo) return respuesta('ok', 200);
  console.error('stripe: el aviso ' + evento.id + ' (' + datos.tipo + ') no se pudo anotar en la hoja (' + r.error + '); Stripe lo repetirá');
  return respuesta('Reintentar.', 500);
}

// El puente al Apps Script (doPost, action=stripe_puente).
//   ok: el Apps Script dijo ok.  definitivo: dijo que no con su razón («sin_fila», «sin_correo»…): reintentar no cambia nada.
//   Lo demás (red, tiempo, candado ocupado, respuesta que no es JSON, «clave») es pasajero o de configuración: se reintenta.
export async function puente(datos) {
  const cuerpo = new URLSearchParams({ action: 'stripe_puente', clave: env('STRIPE_PUENTE_CLAVE') });
  for (const [k, v] of Object.entries(datos)) cuerpo.set(k, String(v == null ? '' : v));
  try {
    const r = await fetch(env('STRIPE_PUENTE_URL'), { method: 'POST', body: cuerpo, signal: AbortSignal.timeout(9000) });
    if (!r.ok) return { ok: false, definitivo: false, error: 'http' };
    const j = await r.json();
    if (j && j.ok === true) return { ok: true, definitivo: true, error: '' };
    const error = (j && typeof j.error === 'string') ? j.error : '';
    return { ok: false, definitivo: !!error && error !== 'clave', error: error || 'pasajero' };
  } catch { return { ok: false, definitivo: false, error: 'red' }; }
}
