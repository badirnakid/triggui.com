// Las páginas que reciben el correo y su firma en la dirección (/perfil, /idioma, /entendido y su copia v19) no
// cargan medición ni nada de otro dominio: esa dirección no sale de triggui.com, salvo la llamada al Apps Script
// que la página hace a propósito (fetch). C477, paso 4: objetivo 6 de la revisión del 17 de noviembre de 2026.
// Uso: node scripts/prueba-paginas-privadas.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const paginas = ['perfil.html', 'idioma.html', 'entendido.html', 'entendido-v19.html'];
let n = 0;
for (const p of paginas) {
  const t = readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  assert.ok(/[?&]?email|searchParams|location\.search/.test(t), p + ': ya no lee la dirección; revisa la lista de esta prueba');
  assert.ok(!/_vercel\/insights|_vercel\/speed-insights|googletagmanager|google-analytics|gtag\(|fbq\(|clarity/i.test(t), p + ': carga medición');
  const cargas = [...t.matchAll(/<(?:script|link|img|iframe|source|video|audio|embed|object)\b[^>]*?\b(?:src|href|data)\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]);
  const deFuera = cargas.filter(u => /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(u.trim()));
  assert.deepStrictEqual(deFuera, [], p + ': carga recursos de otro dominio: ' + deFuera.join(', '));
  assert.ok(!/@import\s+url\(\s*["']?(?:https?:)?\/\//i.test(t) && !/url\(\s*["']?(?:https?:)?\/\//i.test(t), p + ': su CSS pide algo de otro dominio');
  n++;
  console.log('✔ ' + p + ': sin medición ni recursos de otro dominio');
}
console.log(n + ' pruebas en verde');
