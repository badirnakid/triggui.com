#!/usr/bin/env node
// Pruebas de /api/wa (el WhatsApp de los lunes) sin red: Meta, GitHub y el Apps Script son dobles.
// Correr: node scripts/prueba-wa.mjs   ·   con TRIGGUI_APP=<ruta de triggui-app> compara también con el Apps Script.
import assert from 'assert';
import { createHmac } from 'crypto';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const ENV = {
  WA_VERIFY_TOKEN: 'v'.repeat(40), WA_APP_SECRET: 's'.repeat(32), WA_TOKEN: 'TOKEN-DE-PRUEBA', WA_NUMERO_ID: '123',
  WA_PUENTE_URL: 'https://script.google.com/macros/s/ABC_def-1/exec', WA_PUENTE_CLAVE: 'p'.repeat(40)
};
Object.assign(process.env, ENV);
const wa = await import(path.join(AQUI, '..', 'api', 'wa.js'));
const errores = [];
console.error = (x) => errores.push(String(x));

const LIBRO_A = {
  _slug: 'libro-de-prueba', titulo: 'Libro de prueba', _edicion_numero: 112,
  frases: ['🗺 Primera frase.', '🌓 Segunda\nfrase.', '✋ Tercera.'], frases_en: ['First phrase.', 'Second phrase.'], tarjeta_en: { titulo: 'x' },
  _musica: { candidatos: [{ cancion: 'C1', artista: 'A1', pie: 'Pie 1', preview: 'https://x/1' },
    { cancion: 'C2', artista: 'A2', pie: 'Pie 2', preview: 'https://x/2' }, { cancion: 'C3', artista: 'A3', pie: '', preview: null }] },
  _video: { candidatos: [{ id: 'vid1', titulo: 'V1' }, { id: 'vid2', titulo: 'V2' }] }
};
const LIBRO_K = { _slug: 'cuento-de-prueba', titulo: 'Cuento', frases: ['K1', 'K2'],
  _musica: { candidatos: [{ cancion: 'KC', artista: 'KA', pie: 'KP', preview: 'https://k' }] }, _video: { candidatos: [] } };

let llamadas, hayPaginas, faltan, puenteResp, redCaida, catalogoA, puenteLento;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, o = {}) => {
  url = String(url);
  llamadas.push({ url, o });
  if (redCaida && o.method === 'HEAD') throw new Error('red');
  if (url.endsWith('contenido_manual.json')) return json({ libros: catalogoA });
  if (url.endsWith('contenido_kids.json')) return json({ libros: [LIBRO_K] });
  if (o.method === 'HEAD') return new Response(null, { status: (hayPaginas && !faltan.has(url)) ? 200 : 404 });
  if (url.startsWith('https://graph.facebook.com/')) return json({ messages: [{ id: 'wamid.R' }] });
  if (url === ENV.WA_PUENTE_URL) {
    if (puenteLento) throw new Error('tiempo');
    return puenteResp === 'html' ? new Response('<html>error</html>', { status: 200 }) : json(puenteResp);
  }
  throw new Error('URL inesperada: ' + url);
};

const firmar = (cuerpo, secreto = ENV.WA_APP_SECRET) => 'sha256=' + createHmac('sha256', secreto).update(cuerpo).digest('hex');
function aviso(value, field = 'messages') {
  return JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field, value: Object.assign({ messaging_product: 'whatsapp', metadata: { phone_number_id: '123' } }, value) }] }] });
}
async function post(cuerpo, firma = firmar(cuerpo)) {
  const cab = firma === null ? {} : { 'x-hub-signature-256': firma };
  const r = await wa.POST(new Request('https://triggui.com/api/wa', { method: 'POST', headers: cab, body: cuerpo }));
  return { status: r.status, texto: await r.text() };
}
let folio = 0;
const boton = (payload, id = 'wamid.IN' + (++folio), from = '5215511111111') => aviso({ messages: [{ from, id, type: 'button', context: { id: 'wamid.T1' }, button: { payload, text: 'x' } }] });
const texto = (body, id = 'wamid.IN' + (++folio), from = '5215511111111') => aviso({ messages: [{ from, id, type: 'text', text: { body } }] });
const aMeta = () => llamadas.filter((l) => l.url.startsWith('https://graph.facebook.com/')).map((l) => JSON.parse(l.o.body));
const alPuente = () => llamadas.filter((l) => l.url === ENV.WA_PUENTE_URL).map((l) => Object.fromEntries(new URLSearchParams(l.o.body.toString())));
function limpiar() {
  llamadas = []; hayPaginas = true; faltan = new Set(); puenteResp = { ok: true }; redCaida = false; puenteLento = false;
  catalogoA = [LIBRO_A]; errores.length = 0; wa.limpiarCache(); wa.olvidarAtendidos();
}

let pasadas = 0;
async function prueba(nombre, fn) {
  limpiar();
  try { await fn(); pasadas++; console.log('  ✔ ' + nombre); }
  catch (e) { console.log('  ✘ ' + nombre + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}

console.log('WhatsApp del lunes · /api/wa');

await prueba('la verificación de Meta: reto con el token correcto, 403 con otro, 503 sin token', async () => {
  const pedir = (t, reto = 'RETO123') => wa.GET(new Request(`https://triggui.com/api/wa?hub.mode=subscribe&hub.verify_token=${t}&hub.challenge=${reto}`));
  let r = await pedir(ENV.WA_VERIFY_TOKEN);
  assert.strictEqual(r.status, 200); assert.strictEqual(await r.text(), 'RETO123');
  r = await pedir('otro'); assert.strictEqual(r.status, 403);
  r = await pedir(ENV.WA_VERIFY_TOKEN, '%3Cscript%3E'); assert.strictEqual(r.status, 403);
  process.env.WA_VERIFY_TOKEN = 'corto';
  r = await pedir('corto'); assert.strictEqual(r.status, 503);
  process.env.WA_VERIFY_TOKEN = ENV.WA_VERIFY_TOKEN;
});

await prueba('puerta cerrada sin sus variables; 401 sin firma o con firma de otro secreto', async () => {
  delete process.env.WA_PUENTE_CLAVE;
  assert.strictEqual((await post(boton('tg1|tarjeta|a|libro-de-prueba|es|0|0'))).status, 503);
  process.env.WA_PUENTE_CLAVE = ENV.WA_PUENTE_CLAVE;
  process.env.WA_PUENTE_URL = 'https://otro-sitio.com/exec';
  assert.strictEqual((await post(boton('tg1|tarjeta|a|libro-de-prueba|es|0|0'))).status, 503);
  process.env.WA_PUENTE_URL = ENV.WA_PUENTE_URL;
  const c = boton('tg1|tarjeta|a|libro-de-prueba|es|0|0');
  assert.strictEqual((await post(c, null)).status, 401);
  assert.strictEqual((await post(c, firmar(c, 'x'.repeat(32)))).status, 401);
  assert.strictEqual((await post(c, 'sha256=zz')).status, 401);
  assert.strictEqual(llamadas.length, 0);
});

await prueba('«La tarjeta»: la imagen de la tarjeta con la siguiente frase de pie, y el botón anotado', async () => {
  assert.strictEqual((await post(boton('tg1|tarjeta|a|libro-de-prueba|es|1|0'))).status, 200);
  assert.deepStrictEqual(aMeta(), [{ messaging_product: 'whatsapp', recipient_type: 'individual', to: '5215511111111', type: 'image',
    image: { link: 'https://app.triggui.com/t/libro-de-prueba/tarjeta.png', caption: '🌓 Segunda frase.' } }]);
  const p = alPuente()[0];
  assert.deepStrictEqual([p.action, p.clave, p.tipo, p.tel, p.wamid, p.accion, p.slug],
    ['wa_puente', ENV.WA_PUENTE_CLAVE, 'boton', '5215511111111', 'wamid.T1', 'tarjeta', 'libro-de-prueba']);
  const meta = llamadas.find((l) => l.url.startsWith('https://graph.facebook.com/'));
  assert.strictEqual(meta.url, 'https://graph.facebook.com/v26.0/123/messages');
  assert.strictEqual(meta.o.headers.Authorization, 'Bearer TOKEN-DE-PRUEBA');
});

await prueba('la pieza sale aunque la hoja no conteste', async () => {
  puenteLento = true;
  assert.strictEqual((await post(boton('tg1|video|a|libro-de-prueba|es|0|0'))).status, 200);
  assert.strictEqual(aMeta().length, 1);
});

await prueba('«La melodía»: el mismo texto de la sala, con su página exacta y su vista previa', async () => {
  await post(boton('tg1|melodia|a|libro-de-prueba|es|1|0'));
  assert.deepStrictEqual(aMeta()[0].text, { preview_url: true,
    body: 'Pie 2\n\n🎧 C2 — A2\nhttps://app.triggui.com/t/libro-de-prueba/pieza/1/?w=s&utm_content=lunes' });
  assert.ok(llamadas.some((l) => l.o.method === 'HEAD' && l.url === 'https://app.triggui.com/t/libro-de-prueba/pieza/1/'), 'mira la página que manda');
  limpiar(); faltan = new Set(['https://app.triggui.com/t/libro-de-prueba/pieza/1/']);
  await post(boton('tg1|melodia|a|libro-de-prueba|es|1|0'));
  assert.strictEqual(aMeta()[0].text.body, 'Pie 2\n\n🎧 C2 — A2\nhttps://app.triggui.com/t/libro-de-prueba/?w=s&utm_content=lunes&p=1&m=1');
  limpiar(); hayPaginas = false;
  await post(boton('tg1|melodia|a|libro-de-prueba|en|0|0'));
  assert.strictEqual(aMeta()[0].text.body, '🎧 C1 — A1\nhttps://app.triggui.com/t/libro-de-prueba/en/?w=s&utm_content=lunes&p=1&m=0');
  limpiar(); redCaida = true;
  await post(boton('tg1|melodia|a|libro-de-prueba|es|0|0'));
  assert.ok(aMeta()[0].text.body.endsWith('/t/libro-de-prueba/pieza/?w=s&utm_content=lunes'), 'si la red falla, usa la página, como la sala');
});

await prueba('«El video»: su página exacta dentro de Triggui; YouTube solo si esa página no existe', async () => {
  await post(boton('tg1|video|a|libro-de-prueba|es|0|1'));
  assert.deepStrictEqual(aMeta()[0].text, { preview_url: true, body: 'https://app.triggui.com/t/libro-de-prueba/video/1/?w=s&utm_content=lunes' });
  limpiar(); faltan = new Set(['https://app.triggui.com/t/libro-de-prueba/video/1/']);
  await post(boton('tg1|video|a|libro-de-prueba|es|0|1'));
  assert.strictEqual(aMeta()[0].text.body, 'https://youtu.be/vid2');
  limpiar();
  await post(boton('tg1|video|a|libro-de-prueba|es|0|0'));
  assert.strictEqual(aMeta()[0].text.body, 'https://app.triggui.com/t/libro-de-prueba/video/?w=s&utm_content=lunes');
});

await prueba('sin la pieza pedida lo dice; sin el libro no contesta; un libro recién publicado se encuentra', async () => {
  await post(boton('tg1|melodia|a|libro-de-prueba|es|5|0'));
  assert.strictEqual(aMeta()[0].text.body, 'Esta edición no trae melodía.');
  limpiar();
  await post(boton('tg1|tarjeta|a|otro-libro|es|0|0'));
  assert.strictEqual(aMeta().length, 0);
  catalogoA = [LIBRO_A, Object.assign({}, LIBRO_A, { _slug: 'otro-libro' })];
  await post(boton('tg1|tarjeta|a|otro-libro|es|0|0'));
  assert.strictEqual(aMeta()[0].image.link, 'https://app.triggui.com/t/otro-libro/tarjeta.png');
});

await prueba('Niños: rutas de Niños, y nunca video', async () => {
  await post(boton('tg1|tarjeta|k|cuento-de-prueba|es|0|0'));
  assert.strictEqual(aMeta()[0].image.link, 'https://app.triggui.com/kids/t/cuento-de-prueba/tarjeta.png');
  assert.strictEqual(aMeta()[0].image.caption, 'K2');
  limpiar();
  await post(boton('tg1|video|k|cuento-de-prueba|es|0|0'));
  assert.strictEqual(llamadas.length, 0);
});

await prueba('cargas que no son nuestras no hacen nada', async () => {
  for (const malo of ['', 'Unsubscribe', 'tg2|tarjeta|a|libro-de-prueba|es|0|0', 'tg1|borrar|a|libro-de-prueba|es|0|0',
    'tg1|tarjeta|x|libro-de-prueba|es|0|0', 'tg1|tarjeta|a|../../etc|es|0|0', 'tg1|tarjeta|a|libro-de-prueba|fr|0|0',
    'tg1|tarjeta|a|libro-de-prueba|es|10|0', 'tg1|tarjeta|a|libro-de-prueba|es|0|0|extra']) {
    await post(boton(malo));
  }
  assert.strictEqual(llamadas.length, 0);
});

await prueba('el mismo aviso dos veces no manda la pieza dos veces', async () => {
  const c = boton('tg1|tarjeta|a|libro-de-prueba|es|0|0', 'wamid.REPETIDO');
  await post(c); await post(c);
  assert.strictEqual(aMeta().length, 1);
});

await prueba('«BAJA» y «STOP»: la baja en la hoja y su confirmación', async () => {
  assert.strictEqual((await post(texto('BAJA'))).status, 200);
  assert.deepStrictEqual([alPuente()[0].tipo, alPuente()[0].tel], ['baja', '5215511111111']);
  assert.strictEqual(aMeta()[0].text.body, 'Listo, ya no te llegará el libro de los lunes. Gracias por leer con Triggui.');
  limpiar();
  await post(texto(' Stop! '));
  assert.ok(aMeta()[0].text.body.startsWith("Done, you won't"));
  limpiar();
  for (const t of ['baja por favor', 'hola', 'no', 'Bajaaa']) await post(texto(t));
  assert.strictEqual(llamadas.length, 0);
  assert.strictEqual(wa.palabraDeBaja('Dar de baja'), 'baja');
  assert.strictEqual(wa.palabraDeBaja('BÁJA'), 'baja');
});

await prueba('una baja que no se pudo anotar por una falla pasajera pide a Meta que repita; nunca se confirma sin anotar', async () => {
  for (const falla of [{ result: 'lock_timeout' }, 'html', { ok: false, error: 'clave' }]) {
    limpiar(); puenteResp = falla;
    const c = texto('BAJA', 'wamid.B1');
    assert.strictEqual((await post(c)).status, 500, JSON.stringify(falla));
    assert.strictEqual(aMeta().length, 0);
    assert.ok(errores.some((e) => /Meta reintentará/.test(e)) && !errores.some((e) => /\d{8}/.test(e)), 'deja rastro, sin teléfono');
    puenteResp = { ok: true };
    assert.strictEqual((await post(c)).status, 200, 'cuando Meta repite, ya queda');
    assert.strictEqual(aMeta().length, 1);
  }
  limpiar(); puenteLento = true;
  assert.strictEqual((await post(texto('BAJA'))).status, 500);
});

await prueba('una baja que la hoja no puede marcar (número que no está) no se repite ni se confirma', async () => {
  puenteResp = { ok: false, error: 'sin_fila' };
  assert.strictEqual((await post(texto('baja.'))).status, 200);
  assert.strictEqual(alPuente().length, 1);
  assert.strictEqual(aMeta().length, 0);
  assert.ok(errores.some((e) => /sin_fila/.test(e)));
});

await prueba('los estados: entregado, leído y fallido al puente; «enviado» no', async () => {
  await post(aviso({ statuses: [
    { id: 'wamid.T1', status: 'sent', recipient_id: '5215511111111' },
    { id: 'wamid.T1', status: 'delivered', recipient_id: '5215511111111' },
    { id: 'wamid.T2', status: 'failed', recipient_id: '525522222222', errors: [{ code: 131050, title: 'stopped marketing' }] }] }));
  assert.deepStrictEqual(alPuente().map((p) => [p.tipo, p.wamid, p.estado, p.codigo, p.detalle]), [
    ['estado', 'wamid.T1', 'delivered', '', ''], ['estado', 'wamid.T2', 'failed', '131050', 'stopped marketing']]);
});

await prueba('otro número, otro campo o un JSON roto: 200 y nada más', async () => {
  const otro = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '999' }, messages: [{ from: '5215511111111', type: 'text', text: { body: 'BAJA' } }] } }] }] });
  assert.strictEqual((await post(otro)).status, 200);
  assert.strictEqual((await post(aviso({ messages: [{ from: '5215511111111', type: 'text', text: { body: 'BAJA' } }] }, 'smb_message_echoes'))).status, 200);
  assert.strictEqual((await post('{roto')).status, 200);
  assert.strictEqual(llamadas.length, 0);
});

await prueba('el puente manda su clave y distingue lo definitivo de lo pasajero', async () => {
  assert.deepStrictEqual(await wa.puente({ tipo: 'baja', tel: '1' }), { ok: true, definitivo: true, error: '' });
  puenteResp = { ok: false, error: 'sin_fila' };
  assert.deepStrictEqual(await wa.puente({ tipo: 'baja', tel: '1' }), { ok: false, definitivo: true, error: 'sin_fila' });
  puenteResp = { result: 'lock_timeout' };
  assert.deepStrictEqual(await wa.puente({ tipo: 'baja', tel: '1' }), { ok: false, definitivo: false, error: 'pasajero' });
  puenteResp = { ok: false, error: 'clave' };
  assert.strictEqual((await wa.puente({ tipo: 'baja', tel: '1' })).definitivo, false);
  puenteResp = 'html';
  assert.deepStrictEqual(await wa.puente({ tipo: 'baja', tel: '1' }), { ok: false, definitivo: false, error: 'red' });
  assert.ok(alPuente().every((p) => p.clave === ENV.WA_PUENTE_CLAVE && p.action === 'wa_puente'));
});

const APP_DIR = process.env.TRIGGUI_APP || path.join(AQUI, '..', '..', '..', 'triggui-app');
const AS = path.join(APP_DIR, 'apps-script', 'Triggui WhatsApp.js');
if (fs.existsSync(AS)) {
  await prueba('mismo criterio que el Apps Script: melodías, videos, inglés y la carga de cada botón', async () => {
    const ctx = vm.createContext({});
    vm.runInContext(fs.readFileSync(AS, 'utf8'), ctx);
    const raro = { _slug: 'raro', titulo: 'R', frases: ['a'], frases_en: ['b'], tarjeta_en: {}, _edicion_numero: 7,
      _musica: { candidatos: [null, { cancion: 'a', preview: 'p' }, { cancion: 'b' }, { cancion: 'c', preview: 'p' }, { cancion: 'd', preview: 'p' }, { cancion: 'e', preview: 'p' }] },
      _video: { candidatos: [{ id: '' }, { id: 'x' }, { id: 'y' }, null, { id: 'z' }, { id: 'w' }] } };
    for (const b of [raro, LIBRO_A, LIBRO_K]) {
      assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.waMusica_(b))), wa.musica(b));
      assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.waVideos_(b))), wa.videos(b));
      assert.strictEqual(ctx.waTieneEn_(b), wa.tieneEn(b));
    }
    const cfg = { idioma: { es: 'es_MX', en: 'en_US' } };
    for (const [persona, libro] of [[{ tel: '525511111111', clave: '525511111111', lang: 'es', cat: 'adultos' }, LIBRO_A],
      [{ tel: '15125550101', clave: '15125550101', lang: 'en', cat: 'adultos' }, LIBRO_A],
      [{ tel: '525522222222', clave: '525522222222', lang: 'es', cat: 'kids' }, LIBRO_K]]) {
      const c = ctx.waPayload_(persona, libro, cfg);
      for (const b of c.template.components.slice(2)) {
        const p = wa.leerCarga(b.parameters[0].payload);
        assert.ok(p, 'la carga del Apps Script la lee /api/wa: ' + b.parameters[0].payload);
        assert.strictEqual(p.slug, libro._slug);
      }
    }
  });
} else {
  console.log('  · (sin la comparación con el Apps Script: no encontré ' + AS + ')');
}

console.log((process.exitCode ? 'FALLÓ' : 'Todo en verde') + ': ' + pasadas + ' pruebas pasadas.');
