#!/usr/bin/env node
// Pruebas del formulario de suscripción (index.html y en/index.html), leyendo el HTML tal cual se publica:
// la casilla de WhatsApp sin marcar, lo que se manda al Apps Script, el texto del botón y la píldora de idioma.
// Correr: node scripts/prueba-formulario.mjs
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CASILLA_ES = 'Quiero recibirlo también por WhatsApp de Triggui. Me doy de baja cuando quiera respondiendo BAJA.';
const CASILLA_EN = "I also want it on Triggui's WhatsApp. I can stop anytime by replying STOP.";
let pasadas = 0;
function prueba(nombre, fn) {
  try { fn(); pasadas++; console.log('  ✔ ' + nombre); }
  catch (e) { console.log('  ✘ ' + nombre + '\n    ' + (e && e.stack || e)); process.exitCode = 1; }
}

console.log('El formulario de triggui.com');

for (const [archivo, lang] of [['index.html', 'es'], ['en/index.html', 'en']]) {
  const html = fs.readFileSync(path.join(RAIZ, archivo), 'utf8');
  prueba(archivo + ': una sola casilla de WhatsApp, sin marcar, dentro del formulario y antes del botón', () => {
    const casillas = html.match(/<input type="checkbox" id="wa_ok"[^>]*>/g) || [];
    assert.strictEqual(casillas.length, 1);
    assert.ok(!/\bchecked\b/.test(casillas[0]), 'nunca marcada de inicio');
    const form = html.slice(html.indexOf('<form onsubmit="handleCapture(event)"'), html.indexOf('</form>', html.indexOf('<form onsubmit="handleCapture(event)"')));
    assert.ok(form.indexOf('id="wa_ok"') !== -1 && form.indexOf('id="wa_ok"') < form.indexOf('id="submitBtn"'));
    assert.ok(form.indexOf(lang === 'es' ? CASILLA_ES : CASILLA_EN) !== -1, 'el texto de la casilla, con BAJA o STOP');
  });
  prueba(archivo + ': el envío lleva wa_ok solo con la casilla y el idioma que se ve', () => {
    assert.ok(html.includes("&wa_ok=${(document.getElementById('wa_ok')||{}).checked?'1':''}&lang=${window.TRIGGUI_LANG==='en'?'en':''}`});"));
    assert.ok(html.includes("const w=document.getElementById('wa_ok');if(w&&w.checked){w.checked=false;w.dispatchEvent(new Event('change'))}"),
      'después de enviar, la casilla vuelve a quedar sin marcar');
  });
  prueba(archivo + ': el botón dice por dónde llega, en los dos idiomas, y la píldora traduce la casilla y el botón', () => {
    assert.ok(html.includes("const T={es:['Probar gratis por correo','Probar gratis por correo y WhatsApp'],en:['Try it free by email','Try it free by email and WhatsApp']}"));
    assert.ok(html.includes('"Probar gratis por correo y WhatsApp": "Try it free by email and WhatsApp"'));
    assert.ok(html.includes('"' + CASILLA_ES + '": "' + CASILLA_EN + '"'));
  });
  prueba(archivo + ': sin rayas largas en lo nuevo', () => {
    for (const t of [CASILLA_ES, CASILLA_EN, 'Probar gratis por correo y WhatsApp', 'Try it free by email and WhatsApp']) assert.ok(!/[—]/.test(t));
  });
}

console.log((process.exitCode ? 'FALLÓ' : 'Todo en verde') + ': ' + pasadas + ' pruebas pasadas.');
