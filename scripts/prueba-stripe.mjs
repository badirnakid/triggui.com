#!/usr/bin/env node
// Pruebas de /api/stripe (los pagos de Triggui sin intervención) sin red: Stripe y el Apps Script son dobles.
// Correr: node scripts/prueba-stripe.mjs
import assert from 'assert';
import { createHmac } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const ENV = {
  STRIPE_WEBHOOK_SECRET: 'whsec_' + 'a1B2'.repeat(8), STRIPE_PUENTE_URL: 'https://script.google.com/macros/s/ABC_def-1/exec',
  STRIPE_PUENTE_CLAVE: 'p'.repeat(40), STRIPE_ACEPTA_PRUEBA: ''
};
Object.assign(process.env, ENV);
const st = await import(path.join(AQUI, '..', 'api', 'stripe.js'));
const errores = [];
console.error = (x) => errores.push(String(x));

let llamadas = [], puenteResp = { ok: true }, puenteFalla = '';
globalThis.fetch = async (url, o = {}) => {
  url = String(url);
  llamadas.push({ url, o });
  if (url === ENV.STRIPE_PUENTE_URL) {
    if (puenteFalla === 'red') throw new Error('red');
    if (puenteFalla === 'http') return new Response('error', { status: 502 });
    if (puenteFalla === 'html') return new Response('<html>error</html>', { status: 200 });
    return new Response(JSON.stringify(puenteResp), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error('URL inesperada: ' + url);
};

const ahora = () => Math.floor(Date.now() / 1000);
const firmar = (cuerpo, t = ahora(), secreto = ENV.STRIPE_WEBHOOK_SECRET) =>
  't=' + t + ',v1=' + createHmac('sha256', secreto).update(t + '.' + cuerpo).digest('hex');
let folio = 0;
const evento = (type, object, extra = {}) => JSON.stringify(Object.assign({ id: 'evt_PRUEBA' + String(++folio).padStart(6, '0'),
  object: 'event', type, livemode: true, data: { object } }, extra));
async function post(cuerpo, firma = firmar(cuerpo)) {
  const cab = firma === null ? {} : { 'stripe-signature': firma };
  const r = await st.POST(new Request('https://triggui.com/api/stripe', { method: 'POST', headers: cab, body: cuerpo }));
  return { status: r.status, texto: await r.text() };
}
const alPuente = () => llamadas.filter((l) => l.url === ENV.STRIPE_PUENTE_URL).map((l) => Object.fromEntries(new URLSearchParams(String(l.o.body))));

const SESION = { object: 'checkout.session', mode: 'subscription', payment_status: 'paid', amount_subtotal: 14900, amount_total: 14900,
  currency: 'mxn', customer: 'cus_ANA123', subscription: 'sub_ANA123', customer_email: null,
  customer_details: { email: 'ana@x.com', name: 'Ana Pérez', phone: '+525511111111' } };
const FACTURA = { object: 'invoice', billing_reason: 'subscription_cycle', customer: 'cus_ANA123', customer_email: 'ana@x.com',
  customer_name: 'Ana Pérez', customer_phone: null, subtotal: 14900, amount_paid: 14900, amount_due: 14900, currency: 'mxn',
  subscription: 'sub_ANA123', attempt_count: 1, next_payment_attempt: null };

let pasadas = 0;
async function prueba(nombre, fn) {
  llamadas = []; puenteResp = { ok: true }; puenteFalla = ''; errores.length = 0; process.env.STRIPE_ACEPTA_PRUEBA = '';
  try { await fn(); pasadas++; console.log('  ✔ ' + nombre); }
  catch (e) { console.log('  ✘ ' + nombre + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}

console.log('/api/stripe · los pagos de Triggui');

await prueba('puerta cerrada: sin secreto, sin dirección del puente o con clave corta, 503 y nada más', async () => {
  for (const [k, v] of [['STRIPE_WEBHOOK_SECRET', ''], ['STRIPE_WEBHOOK_SECRET', 'otra-cosa-de-mas-de-16'], ['STRIPE_PUENTE_URL', 'https://otro.com/exec'],
    ['STRIPE_PUENTE_CLAVE', 'corta']]) {
    process.env[k] = v;
    const cuerpo = evento('checkout.session.completed', SESION);
    assert.strictEqual((await post(cuerpo)).status, 503, k);
    process.env[k] = ENV[k];
  }
  assert.strictEqual(llamadas.length, 0);
  assert.strictEqual((await st.GET()).status, 405);
});

await prueba('la firma: válida pasa; otro secreto, cuerpo tocado, vieja, sin v1 o sin cabecera, 400', async () => {
  const cuerpo = evento('checkout.session.completed', SESION);
  assert.strictEqual((await post(cuerpo)).status, 200);
  assert.strictEqual((await post(cuerpo, firmar(cuerpo, ahora(), 'whsec_otro' + 'x'.repeat(20)))).status, 400);
  assert.strictEqual((await post(cuerpo.replace('14900', '100'), firmar(cuerpo))).status, 400);
  assert.strictEqual((await post(cuerpo, firmar(cuerpo, ahora() - 301))).status, 400);
  assert.strictEqual((await post(cuerpo, firmar(cuerpo, ahora() + 301))).status, 400);
  assert.strictEqual((await post(cuerpo, firmar(cuerpo).replace('v1=', 'v0='))).status, 400);
  assert.strictEqual((await post(cuerpo, null)).status, 400);
  const t = ahora();
  const doble = 't=' + t + ',v1=' + 'f'.repeat(64) + ',' + firmar(cuerpo, t).split(',')[1];
  assert.strictEqual((await post(cuerpo, doble)).status, 200, 'basta un v1 que coincida');
  assert.strictEqual(alPuente().length, 2);
});

await prueba('el pago completado de una suscripción: alta con correo, nombre, teléfono, cliente, suscripción y plan', async () => {
  const cuerpo = evento('checkout.session.completed', SESION);
  assert.strictEqual((await post(cuerpo)).status, 200);
  const p = alPuente()[0];
  assert.deepStrictEqual(p, { action: 'stripe_puente', clave: ENV.STRIPE_PUENTE_CLAVE, evento: JSON.parse(cuerpo).id, tipo: 'alta',
    email: 'ana@x.com', nombre: 'Ana Pérez', tel: '+525511111111', cliente: 'cus_ANA123', suscripcion: 'sub_ANA123', plan: '149',
    monto: '149.00', moneda: 'mxn' });
});

await prueba('lo que no es de la suscripción no llega al puente: pago suelto, sesión sin pagar, factura suelta, otros avisos y JSON roto', async () => {
  for (const c of [evento('checkout.session.completed', Object.assign({}, SESION, { mode: 'payment' })),
    evento('checkout.session.completed', Object.assign({}, SESION, { payment_status: 'unpaid' })),
    evento('invoice.paid', Object.assign({}, FACTURA, { billing_reason: 'manual' })),
    evento('customer.created', { id: 'cus_X' }), evento('charge.refunded', { id: 'ch_X' })]) {
    assert.strictEqual((await post(c)).status, 200);
  }
  assert.strictEqual((await post('no es json')).status, 200);
  assert.strictEqual((await post(JSON.stringify({ id: 'raro', type: 'invoice.paid', livemode: true, data: { object: FACTURA } }))).status, 200);
  assert.strictEqual(alPuente().length, 0);
});

await prueba('las facturas: de alta es alta, del mes y de cambio de plan es renovación; la suscripción también en parent (API nueva)', async () => {
  await post(evento('invoice.paid', Object.assign({}, FACTURA, { billing_reason: 'subscription_create' })));
  await post(evento('invoice.paid', FACTURA));
  const nueva = Object.assign({}, FACTURA, { billing_reason: 'subscription_update', subscription: undefined,
    parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_NUEVA9' } }, customer: { id: 'cus_EXP123', object: 'customer' } });
  await post(evento('invoice.paid', nueva));
  const p = alPuente();
  assert.deepStrictEqual(p.map((x) => [x.tipo, x.suscripcion, x.cliente, x.plan, x.monto]), [
    ['alta', 'sub_ANA123', 'cus_ANA123', '149', '149.00'], ['renovacion', 'sub_ANA123', 'cus_ANA123', '149', '149.00'],
    ['renovacion', 'sub_NUEVA9', 'cus_EXP123', '149', '149.00']]);
});

await prueba('la baja y el cobro fallido', async () => {
  await post(evento('customer.subscription.deleted', { object: 'subscription', id: 'sub_ANA123', customer: 'cus_ANA123', status: 'canceled' }));
  await post(evento('invoice.payment_failed', Object.assign({}, FACTURA, { attempt_count: 2, next_payment_attempt: Date.UTC(2026, 10, 20, 12) / 1000 })));
  const p = alPuente();
  assert.deepStrictEqual([p[0].tipo, p[0].cliente, p[0].suscripcion, p[0].email], ['baja', 'cus_ANA123', 'sub_ANA123', undefined]);
  assert.deepStrictEqual([p[1].tipo, p[1].email, p[1].monto, p[1].moneda, p[1].intento, p[1].siguiente], ['fallo', 'ana@x.com', '149.00', 'mxn', '2', '2026-11-20']);
});

await prueba('el plan sale del monto en pesos: $149 al mes o $1,490 al año, $129; lo demás es «otro»', async () => {
  assert.deepStrictEqual([st.planDe(14900, 'mxn'), st.planDe(149000, 'MXN'), st.planDe(12900, 'mxn'), st.planDe(10000, 'mxn'),
    st.planDe(14900, 'usd'), st.planDe(undefined, 'mxn')], ['149', '149', '129', 'otro', 'otro', 'otro']);
});

await prueba('el modo de prueba se ignora, salvo con STRIPE_ACEPTA_PRUEBA=si', async () => {
  const c = evento('checkout.session.completed', SESION, { livemode: false });
  assert.deepStrictEqual(await post(c), { status: 200, texto: 'ok (modo de prueba)' });
  assert.strictEqual(alPuente().length, 0);
  process.env.STRIPE_ACEPTA_PRUEBA = 'si';
  assert.strictEqual((await post(evento('checkout.session.completed', SESION, { livemode: false }))).status, 200);
  assert.strictEqual(alPuente().length, 1);
});

await prueba('lo que contesta el puente: ok y definitivo, 200; pasajero, de configuración o sin respuesta, 500 para que Stripe repita', async () => {
  const casos = [[{ ok: true }, '', 200], [{ ok: true, repetido: true }, '', 200], [{ ok: false, error: 'sin_fila' }, '', 200],
    [{ ok: false, error: 'sin_correo' }, '', 200], [{ ok: false, error: '' }, '', 500], [{ result: 'lock_timeout' }, '', 500],
    [{ ok: false, error: 'clave' }, '', 500], [{ ok: true }, 'html', 500], [{ ok: true }, 'red', 500], [{ ok: true }, 'http', 500]];
  for (const [r, falla, esperado] of casos) {
    puenteResp = r; puenteFalla = falla;
    assert.strictEqual((await post(evento('invoice.payment_failed', FACTURA))).status, esperado, JSON.stringify(r) + ' ' + falla);
  }
  assert.ok(errores.length === 6 && errores.every((x) => /Stripe lo repetirá/.test(x)), errores.join('\n'));
  assert.ok(llamadas.every((l) => l.o.signal), 'el puente lleva tiempo límite');
});

console.log((process.exitCode ? 'FALLÓ' : 'Todo en verde') + ': ' + pasadas + ' pruebas pasadas.');
