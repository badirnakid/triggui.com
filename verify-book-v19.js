// ════════════════════════════════════════════════════════════════════════
// 🌒 verify-book.js v6.0 — VERSIÓN FINAL NIVEL DIOS TODOPODEROSO
// ════════════════════════════════════════════════════════════════════════
//
// ARQUITECTURA EN CASCADA (optimizada para latencia y costo):
//
//   PASO 1: APIs públicas en paralelo (Apple + Google + OpenLibrary)
//           Timeout 2000ms estricto. Si todas fallan → seguir.
//
//   PASO 2 (opcional): Fallback solo por autor
//           Solo se ejecuta si paso 1 dio <3 candidatos relevantes
//           y el autor parece confiable (≥4 chars).
//
//   PASO 3: Decisión algorítmica
//           ✓ Match fuerte (combinado ≥85% o autor ≥85% + combinado ≥75%):
//             → STRONG sin GPT (AHORRO de tokens)
//           ✓ Match débil pero candidatos válidos: continuar a paso 4
//           ✓ Sin candidatos relevantes: continuar a paso 4
//
//   PASO 4 (GPT cuarto tier): GPT-4o-mini semántico
//           Solo se invoca si APIs no resolvieron con confianza.
//           Costo: ~$0.0003 USD por captura (~$0.006 MXN).
//
//   PASO 5 (sanity check): Double-check GPT contra APIs
//           SOLO si confianza GPT < 0.92 (si ≥0.92, confiar sin verificar).
//           Eleva sources si APIs confirman = high confidence.
//
//   PASO 6: Degradación elegante
//           Si GPT no reconoce + APIs tienen candidatos con autor decente:
//             → WEAK_MATCH (mostrar candidatos)
//           Si nada coincide: → NO_MATCH (tarjeta "Revisa bien")
//
// LATENCIA TÍPICA:
//   - Match exacto APIs:         ~700ms
//   - Match con typo leve APIs:  ~800ms
//   - Typo medio (GPT entra):    ~3-4s
//   - Typo extremo (GPT+check):  ~5-6s
//
// COSTO TÍPICO MENSUAL (10 capturas/mes):
//   - 7 capturas resueltas por APIs:    $0.00 MXN
//   - 3 capturas con GPT:               $0.018 MXN
//   - TOTAL:                            <$0.02 MXN/mes
// ════════════════════════════════════════════════════════════════════════

import { identifyWithGPT } from './verify-book-gpt.js';

// ─── Configuración nivel quark ──────────────────────────────────────────
const TIMEOUT_MS = 2000;                  // ↓ de 3000ms para acelerar
const STRONG_COMBINED_NO_GPT = 0.85;      // combinado ≥85% → sin GPT
const STRONG_AUTHOR_NO_GPT = 0.85;        // autor ≥85% + combinado ≥75% → sin GPT
const STRONG_COMBINED_WITH_AUTHOR = 0.75;
const WEAK_AUTHOR_MIN = 0.65;             // mínimo para mostrar candidatos
const GPT_CONFIDENCE_MIN = 0.80;          // mínimo de GPT para aceptar
const GPT_TRUST_THRESHOLD = 0.92;         // si GPT ≥0.92, saltar double-check
const APIS_CONFIRM_TITLE = 0.85;          // título debe matchear ≥85% para confirmar
const APIS_CONFIRM_AUTHOR = 0.75;         // autor debe matchear ≥75% para confirmar

// ─── Helpers de red ─────────────────────────────────────────────────────
async function fetchWithTimeout(url, ms = TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    return res;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

// ─── Normalización ──────────────────────────────────────────────────────
function normalize(s) {
  return String(s || '').normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019\u02BC\u00B4\u0060]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, ' ')
    .toLowerCase()
    .replace(/^[\s.,;:!?"'`´¿¡()\[\]{}\-_]+|[\s.,;:!?"'`´¿¡()\[\]{}\-_]+$/g, '')
    .replace(/\s+/g, ' ').trim();
}

function stripSubtitle(n) {
  for (const sep of [':', ' - ', ' — ', '. ', ' / ']) {
    const idx = n.indexOf(sep);
    if (idx > 0) return n.slice(0, idx).trim();
  }
  return n;
}

const ARTICULOS = new Set(['el','la','los','las','un','una','the','a','an']);
function stripArticle(n) {
  const p = n.split(' ');
  return (p.length >= 2 && ARTICULOS.has(p[0])) ? p.slice(1).join(' ') : n;
}

// ─── Algoritmos de scoring ──────────────────────────────────────────────
function bigrams(s) {
  const arr = [];
  for (let i = 0; i < s.length - 1; i++) arr.push(s.slice(i, i + 2));
  return arr;
}
function diceBigrams(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const ba = bigrams(a), bb = bigrams(b);
  const map = new Map();
  ba.forEach(x => map.set(x, (map.get(x) || 0) + 1));
  let inter = 0;
  bb.forEach(x => {
    if (map.get(x) > 0) { inter++; map.set(x, map.get(x) - 1); }
  });
  return (2 * inter) / (ba.length + bb.length);
}

function jaro(s1, s2) {
  if (s1 === s2) return 1;
  if (!s1.length || !s2.length) return 0;
  const md = Math.max(1, Math.floor(Math.max(s1.length, s2.length) / 2) - 1);
  const m1 = new Array(s1.length).fill(false);
  const m2 = new Array(s2.length).fill(false);
  let m = 0;
  for (let i = 0; i < s1.length; i++) {
    const st = Math.max(0, i - md), en = Math.min(i + md + 1, s2.length);
    for (let j = st; j < en; j++) {
      if (m2[j] || s1[i] !== s2[j]) continue;
      m1[i] = true; m2[j] = true; m++; break;
    }
  }
  if (m === 0) return 0;
  let k = 0, t = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!m1[i]) continue;
    while (!m2[k]) k++;
    if (s1[i] !== s2[k]) t++;
    k++;
  }
  t /= 2;
  return (m / s1.length + m / s2.length + (m - t) / m) / 3;
}
function jaroWinkler(s1, s2) {
  const j = jaro(s1, s2);
  if (j < 0.7) return j;
  let p = 0;
  const mp = Math.min(4, s1.length, s2.length);
  for (let i = 0; i < mp; i++) if (s1[i] === s2[i]) p++; else break;
  return j + p * 0.1 * (1 - j);
}

function bestWordPair(wA, wB) {
  if (!wA.length || !wB.length) return 0;
  let total = 0, count = 0;
  for (const x of wA) {
    if (x.length < 3) continue;
    let best = 0;
    for (const y of wB) {
      if (y.length < 3) continue;
      const s = diceBigrams(x, y);
      if (s > best) best = s;
    }
    total += best; count++;
  }
  return count > 0 ? total / count : 0;
}

function scoreTitulo(inputTit, apiTit) {
  const a = normalize(inputTit);
  const b = normalize(apiTit);
  if (a === b) return 1.0;
  const aBare = stripSubtitle(stripArticle(a));
  const bBare = stripSubtitle(stripArticle(b));
  if (aBare === bBare) return 0.97;
  const bg = diceBigrams(aBare, bBare);
  const jw = jaroWinkler(aBare, bBare);
  const wA = aBare.split(/\s+/).filter(t => t.length >= 3);
  const wB = bBare.split(/\s+/).filter(t => t.length >= 3);
  const wp = bestWordPair(wA, wB);
  return Math.max(bg, jw, wp);
}

function scoreAutor(inputAut, apiAut) {
  const a = normalize(inputAut);
  const b = normalize(apiAut);
  if (a === b) return 1.0;

  const tokenize = (s) => {
    let x = s;
    if (x.includes(',')) {
      const [l, r] = x.split(',').map(t => t.trim());
      x = (r + ' ' + l).trim();
    }
    x = x.replace(/\b[a-z]\./g, '').replace(/\s+/g, ' ').trim();
    x = x.split(/\s+&\s+|\s+and\s+|\s+y\s+/)[0].trim();
    return x.split(/\s+/).filter(t => t.length >= 2);
  };
  const ta = tokenize(a), tb = tokenize(b);

  if (ta.length && tb.length) {
    const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
    const longSet = new Set(long);
    let matches = 0;
    for (const t of short) if (longSet.has(t)) matches++;
    if (matches === short.length && matches >= 1) return 0.95;
  }

  const wp = bestWordPair(ta, tb);
  const jw = jaroWinkler(ta.join(' '), tb.join(' '));
  return Math.max(wp, jw);
}

// ─── APIs externas (todas con timeout 2000ms) ──────────────────────────
async function fetchAppleBooks(q) {
  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=ebook&limit=15&country=mx`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return { results: [], error: `http_${res.status}` };
    const data = await res.json();
    if (!data?.results?.length) return { results: [], error: null };
    return {
      results: data.results
        .filter(r => r.trackName && r.artistName)
        .map(r => ({
          titulo: String(r.trackName).trim(),
          autor: String(r.artistName).trim(),
          year: r.releaseDate ? new Date(r.releaseDate).getFullYear() : null,
          source: 'apple_books'
        })),
      error: null
    };
  } catch (err) {
    return { results: [], error: err.name === 'AbortError' ? 'timeout' : err.message };
  }
}

async function fetchGoogleBooks(q) {
  try {
    const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=15&printType=books`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return { results: [], error: `http_${res.status}` };
    const data = await res.json();
    if (!data?.items?.length) return { results: [], error: null };
    return {
      results: data.items
        .map(it => {
          const info = it.volumeInfo || {};
          if (!info.title || !info.authors?.length) return null;
          return {
            titulo: String(info.title).trim(),
            autor: String(info.authors[0]).trim(),
            year: info.publishedDate ? parseInt(info.publishedDate.slice(0, 4)) : null,
            source: 'google_books'
          };
        })
        .filter(Boolean),
      error: null
    };
  } catch (err) {
    return { results: [], error: err.name === 'AbortError' ? 'timeout' : err.message };
  }
}

async function fetchOpenLibrary(q) {
  try {
    const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=15&fields=title,author_name,first_publish_year`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return { results: [], error: `http_${res.status}` };
    const data = await res.json();
    if (!data?.docs?.length) return { results: [], error: null };
    return {
      results: data.docs
        .filter(d => d.title && d.author_name?.length)
        .map(d => ({
          titulo: String(d.title).trim(),
          autor: String(d.author_name[0]).trim(),
          year: d.first_publish_year || null,
          source: 'openlibrary'
        })),
      error: null
    };
  } catch (err) {
    return { results: [], error: err.name === 'AbortError' ? 'timeout' : err.message };
  }
}

async function searchAllAPIs(query) {
  const [apple, google, ol] = await Promise.all([
    fetchAppleBooks(query),
    fetchGoogleBooks(query),
    fetchOpenLibrary(query)
  ]);
  return {
    apple: apple.results,
    google: google.results,
    openlibrary: ol.results,
    errors: { apple: apple.error, google: google.error, openlibrary: ol.error },
    total: apple.results.length + google.results.length + ol.results.length
  };
}

// ─── Análisis y ranking de candidatos ──────────────────────────────────
function analyzeCandidates(titulo, autor, allCandidates) {
  if (!allCandidates.length) return [];

  allCandidates.forEach(c => {
    c.sim_titulo = scoreTitulo(titulo, c.titulo);
    c.sim_autor = scoreAutor(autor, c.autor);
    c.sim_combinado = c.sim_titulo * 0.55 + c.sim_autor * 0.45;
  });

  const consensus = new Map();
  allCandidates.forEach(c => {
    const key = normalize(stripSubtitle(stripArticle(normalize(c.titulo))));
    if (!consensus.has(key)) {
      consensus.set(key, {
        titulo_canonico: c.titulo,
        autor_canonico: c.autor,
        sources: [],
        max_sim_titulo: 0,
        max_sim_autor: 0,
        max_sim_combinado: 0,
        years: []
      });
    }
    const e = consensus.get(key);
    if (!e.sources.includes(c.source)) e.sources.push(c.source);
    if (c.sim_titulo > e.max_sim_titulo) {
      e.max_sim_titulo = c.sim_titulo;
      e.titulo_canonico = c.titulo;
    }
    if (c.sim_autor > e.max_sim_autor) {
      e.max_sim_autor = c.sim_autor;
      e.autor_canonico = c.autor;
    }
    if (c.sim_combinado > e.max_sim_combinado) e.max_sim_combinado = c.sim_combinado;
    if (c.year) e.years.push(c.year);
  });

  return Array.from(consensus.values()).sort((a, b) => {
    if (b.sources.length !== a.sources.length) return b.sources.length - a.sources.length;
    return b.max_sim_combinado - a.max_sim_combinado;
  });
}

// ─── FUNCIÓN PRINCIPAL NIVEL DIOS ──────────────────────────────────────
export async function verifyBookExternal(titulo, autor, opts = {}) {
  const verbose = opts.verbose || false;
  const startTime = Date.now();
  const debugLog = [];
  const log = (...args) => {
    const line = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    debugLog.push(line);
    if (verbose) console.log('[verify-book]', line);
  };

  log('input:', { titulo, autor });

  const apiKey = process.env.OPENAI_API_KEY;
  const useGPT = opts.useGPT !== false && Boolean(apiKey);
  if (!useGPT) log('warning: GPT no disponible — solo APIs');

  // ═══ PASO 1: APIs en paralelo ═════════════════════════════════════════
  log('paso1: APIs query="' + titulo + ' ' + autor + '"');
  const tier1 = await searchAllAPIs(`${titulo} ${autor}`.trim());
  log('paso1 results:', {
    apple: tier1.apple.length,
    google: tier1.google.length,
    openlibrary: tier1.openlibrary.length,
    errors: tier1.errors
  });

  let allCandidates = [...tier1.apple, ...tier1.google, ...tier1.openlibrary];
  let rankedInitial = analyzeCandidates(titulo, autor, allCandidates);
  const topInitial = rankedInitial[0] || null;

  // ═══ PASO 2 (opcional): Fallback solo por autor ═══════════════════════
  // Solo si paso 1 NO encontró candidato con autor decente
  const needsFallback = !topInitial || topInitial.max_sim_autor < 0.70;
  if (needsFallback && autor.trim().length >= 4) {
    log('paso2: fallback search by author only');
    const tier2 = await searchAllAPIs(autor.trim());
    log('paso2 results:', {
      apple: tier2.apple.length,
      google: tier2.google.length,
      openlibrary: tier2.openlibrary.length
    });
    allCandidates = allCandidates.concat(tier2.apple, tier2.google, tier2.openlibrary);
  }

  const ranked = analyzeCandidates(titulo, autor, allCandidates);
  const top = ranked[0] || null;

  if (top) {
    log('paso3 top:', {
      t: top.titulo_canonico.slice(0, 50),
      a: top.autor_canonico.slice(0, 30),
      sT: Math.round(top.max_sim_titulo * 100),
      sA: Math.round(top.max_sim_autor * 100),
      sC: Math.round(top.max_sim_combinado * 100),
      src: top.sources.length
    });
  }

  const tituloInputN = normalize(titulo);
  const autorInputN = normalize(autor);

  // ═══ PASO 3: Decisión algorítmica nivel divino ════════════════════════

  // CASO A: APIs encontraron match muy fuerte → SIN GPT
  if (top && top.max_sim_combinado >= STRONG_COMBINED_NO_GPT) {
    const tituloBestN = normalize(top.titulo_canonico);
    const autorBestN = normalize(top.autor_canonico);

    if (tituloBestN === tituloInputN && autorBestN === autorInputN) {
      log('decision: already_canonical (apis_only)');
      return {
        verified: true,
        already_canonical: true,
        via: 'apis_only',
        elapsed_ms: Date.now() - startTime,
        debug: debugLog
      };
    }

    log('decision: strong_match (apis_only)', { score: top.max_sim_combinado });
    return {
      verified: true,
      tipo: 'strong_match',
      suggestion: {
        titulo_canonico: top.titulo_canonico,
        autor_canonico: top.autor_canonico,
        year: top.years.length ? Math.min(...top.years) : null,
        sim_titulo: Math.round(top.max_sim_titulo * 100),
        sim_autor: Math.round(top.max_sim_autor * 100),
        sources: top.sources,
        confidence: top.sources.length >= 2 ? 'high' : 'medium'
      },
      via: 'apis_only',
      elapsed_ms: Date.now() - startTime,
      debug: debugLog
    };
  }

  // CASO B: Match medio con autor fuerte → SIN GPT
  if (top &&
      top.max_sim_autor >= STRONG_AUTHOR_NO_GPT &&
      top.max_sim_combinado >= STRONG_COMBINED_WITH_AUTHOR) {
    log('decision: strong_match (apis_only, medium score)', {
      sT: top.max_sim_titulo, sA: top.max_sim_autor, sC: top.max_sim_combinado
    });
    return {
      verified: true,
      tipo: 'strong_match',
      suggestion: {
        titulo_canonico: top.titulo_canonico,
        autor_canonico: top.autor_canonico,
        year: top.years.length ? Math.min(...top.years) : null,
        sim_titulo: Math.round(top.max_sim_titulo * 100),
        sim_autor: Math.round(top.max_sim_autor * 100),
        sources: top.sources,
        confidence: top.sources.length >= 2 ? 'high' : 'medium'
      },
      via: 'apis_only',
      elapsed_ms: Date.now() - startTime,
      debug: debugLog
    };
  }

  // ═══ PASO 4: GPT-4o-mini (cuarto tier semántico) ══════════════════════
  if (!useGPT) {
    log('warning: APIs insuficientes y GPT no disponible');
    const topByAuthor = ranked.filter(r => r.max_sim_autor >= WEAK_AUTHOR_MIN);
    if (topByAuthor.length > 0) {
      return {
        verified: true,
        tipo: 'weak_match',
        candidates: topByAuthor.slice(0, 4).map(r => ({
          titulo: r.titulo_canonico,
          autor: r.autor_canonico,
          year: r.years.length ? Math.min(...r.years) : null,
          sim_titulo: Math.round(r.max_sim_titulo * 100),
          sim_autor: Math.round(r.max_sim_autor * 100),
          sources: r.sources
        })),
        via: 'apis_only_no_gpt',
        elapsed_ms: Date.now() - startTime,
        debug: debugLog
      };
    }
    return {
      verified: false,
      tipo: 'no_match',
      reason: 'apis_weak_no_gpt',
      via: 'apis_only_no_gpt',
      elapsed_ms: Date.now() - startTime,
      debug: debugLog
    };
  }

  log('paso4: APIs insuficientes → invoking GPT-4o-mini');
  const gpt = await identifyWithGPT(titulo, autor, apiKey);
  log('paso4 gpt:', {
    available: gpt.available,
    reconocido: gpt.reconocido,
    confianza: gpt.confianza,
    titulo_gpt: (gpt.titulo_canonico || '').slice(0, 50),
    autor_gpt: (gpt.autor_canonico || '').slice(0, 30),
    tokens: gpt.tokens,
    elapsed_ms: gpt.elapsed_ms,
    error: gpt.error
  });

  // CASO C: GPT reconoció con confianza suficiente
  if (gpt.available && gpt.reconocido &&
      gpt.confianza >= GPT_CONFIDENCE_MIN &&
      gpt.titulo_canonico && gpt.autor_canonico) {

    const gptTitN = normalize(gpt.titulo_canonico);
    const gptAutN = normalize(gpt.autor_canonico);

    if (gptTitN === tituloInputN && gptAutN === autorInputN) {
      log('decision: already_canonical (gpt)');
      return {
        verified: true,
        already_canonical: true,
        via: 'gpt',
        elapsed_ms: Date.now() - startTime,
        debug: debugLog
      };
    }

    // ═══ PASO 5: Double-check con APIs SOLO si GPT < 0.92 ════════════════
    // Si GPT está muy seguro (≥0.92), confiar sin verificar → ahorra ~2s
    let apisConfirmed = false;
    let confirmingSources = [];
    let confirmedYear = gpt.year;

    if (gpt.confianza < GPT_TRUST_THRESHOLD) {
      log('paso5: double-check GPT vs APIs');
      const validation = await searchAllAPIs(
        `${gpt.titulo_canonico} ${gpt.autor_canonico}`.trim()
      );
      const validationCandidates = [
        ...validation.apple,
        ...validation.google,
        ...validation.openlibrary
      ];
      for (const c of validationCandidates) {
        const cT = scoreTitulo(gpt.titulo_canonico, c.titulo);
        const cA = scoreAutor(gpt.autor_canonico, c.autor);
        if (cT >= APIS_CONFIRM_TITLE && cA >= APIS_CONFIRM_AUTHOR) {
          apisConfirmed = true;
          if (!confirmingSources.includes(c.source)) confirmingSources.push(c.source);
          if (c.year && !confirmedYear) confirmedYear = c.year;
        }
      }
      log('paso5 result:', { apisConfirmed, confirmingSources });
    } else {
      log('paso5: skipped (GPT confidence ≥ ' + GPT_TRUST_THRESHOLD + ')');
    }

    const finalSources = apisConfirmed
      ? ['gpt-4o-mini', ...confirmingSources]
      : ['gpt-4o-mini'];
    const confidenceLevel = apisConfirmed
      ? 'high'
      : (gpt.confianza >= 0.9 ? 'high' : 'medium');
    const via = apisConfirmed ? 'gpt+apis' : 'gpt';

    log('decision: strong_match (' + via + ')', {
      gpt_conf: gpt.confianza,
      apis_confirmed: apisConfirmed
    });

    return {
      verified: true,
      tipo: 'strong_match',
      suggestion: {
        titulo_canonico: gpt.titulo_canonico,
        autor_canonico: gpt.autor_canonico,
        year: confirmedYear || gpt.year,
        sim_titulo: Math.round(gpt.confianza * 100),
        sim_autor: Math.round(gpt.confianza * 100),
        sources: finalSources,
        confidence: confidenceLevel,
        razon: gpt.razon,
        apis_confirmed: apisConfirmed
      },
      via,
      elapsed_ms: Date.now() - startTime,
      debug: debugLog
    };
  }

  // ═══ PASO 6: Degradación elegante ═════════════════════════════════════
  // GPT no reconoció → mostrar candidatos APIs si los hay, sino "Revisa bien"
  log('paso6: GPT did not recognize, checking weak APIs fallback');

  const topByAuthor = ranked.filter(r => r.max_sim_autor >= WEAK_AUTHOR_MIN);
  if (topByAuthor.length > 0) {
    log('decision: weak_match (apis fallback after gpt)');
    return {
      verified: true,
      tipo: 'weak_match',
      candidates: topByAuthor.slice(0, 4).map(r => ({
        titulo: r.titulo_canonico,
        autor: r.autor_canonico,
        year: r.years.length ? Math.min(...r.years) : null,
        sim_titulo: Math.round(r.max_sim_titulo * 100),
        sim_autor: Math.round(r.max_sim_autor * 100),
        sources: r.sources
      })),
      gpt_razon: gpt.razon || null,
      via: 'apis_fallback',
      elapsed_ms: Date.now() - startTime,
      debug: debugLog
    };
  }

  log('decision: no_match (nothing matches anywhere)');
  return {
    verified: false,
    tipo: 'no_match',
    reason: 'no_strong_match_anywhere',
    gpt_razon: gpt.razon || null,
    sample: ranked.slice(0, 2).map(r => ({
      titulo: r.titulo_canonico,
      autor: r.autor_canonico,
      sim_titulo: Math.round(r.max_sim_titulo * 100),
      sim_autor: Math.round(r.max_sim_autor * 100)
    })),
    elapsed_ms: Date.now() - startTime,
    debug: debugLog
  };
}
