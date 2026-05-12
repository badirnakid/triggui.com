// ════════════════════════════════════════════════════════════════════════
// 🌒 verify-book.js v4 — Confiar en las APIs, no rejuzgar lo que ya saben
// ════════════════════════════════════════════════════════════════════════
// FILOSOFÍA v4:
//   Las APIs (Apple/Google/OpenLibrary) son expertas en búsqueda fuzzy.
//   Mi rol es PRESENTAR sus mejores resultados al usuario, no JUZGAR.
//
// LÓGICA:
//   1. Buscar en 3 APIs con query="titulo autor"
//   2. Si pocos resultados (<5), fallback buscando solo por autor
//   3. Deduplicar por título canónico
//   4. Ordenar por: (a) consenso entre APIs (b) score combinado
//   5. DECISIÓN:
//      - input ≈ top1 → already_canonical (no interrumpe)
//      - top1 score ≥ 0.88 → STRONG (sugerencia única)
//      - autor en top candidatos coincide ≥ 0.65 → WEAK (mostrar candidatos)
//      - sin matches buenos → NO_MATCH (pedir revisar)
//      - APIs caídas → no_api_results (no interrumpe, degrada elegante)
//
// LOGGING: console.log en cada paso → visible en Vercel Dashboard → Logs
// ════════════════════════════════════════════════════════════════════════

const TIMEOUT_MS = 3000;
const STRONG_SCORE = 0.88;
const WEAK_AUTHOR_MIN = 0.65;

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
  let matches = 0;
  for (let i = 0; i < s1.length; i++) {
    const st = Math.max(0, i - md), en = Math.min(i + md + 1, s2.length);
    for (let j = st; j < en; j++) {
      if (m2[j] || s1[i] !== s2[j]) continue;
      m1[i] = true; m2[j] = true; matches++; break;
    }
  }
  if (matches === 0) return 0;
  let k = 0, t = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!m1[i]) continue;
    while (!m2[k]) k++;
    if (s1[i] !== s2[k]) t++;
    k++;
  }
  t /= 2;
  return (matches / s1.length + matches / s2.length + (matches - t) / matches) / 3;
}
function jaroWinkler(s1, s2) {
  const j = jaro(s1, s2);
  if (j < 0.7) return j;
  let p = 0;
  const mp = Math.min(4, s1.length, s2.length);
  for (let i = 0; i < mp; i++) if (s1[i] === s2[i]) p++; else break;
  return j + p * 0.1 * (1 - j);
}

// Score título: combinación de bigramas + jaro-winkler, sin estricteces
function scoreTitulo(inputTit, apiTit) {
  const a = normalize(inputTit);
  const b = normalize(apiTit);
  if (a === b) return 1.0;

  // Strip subtítulos y artículos
  const aBare = stripSubtitle(stripArticle(a));
  const bBare = stripSubtitle(stripArticle(b));
  if (aBare === bBare) return 0.97;

  // Bigrams + Jaro-Winkler en versiones bare
  const bg = diceBigrams(aBare, bBare);
  const jw = jaroWinkler(aBare, bBare);

  // Best word-pair (cada palabra del input vs cada palabra del API)
  const wA = aBare.split(/\s+/).filter(t => t.length >= 3);
  const wB = bBare.split(/\s+/).filter(t => t.length >= 3);
  let bestWP = 0;
  if (wA.length && wB.length) {
    let total = 0, count = 0;
    for (const x of wA) {
      let best = 0;
      for (const y of wB) {
        const s = diceBigrams(x, y);
        if (s > best) best = s;
      }
      total += best; count++;
    }
    bestWP = count > 0 ? total / count : 0;
  }

  return Math.max(bg, jw, bestWP);
}

function scoreAutor(inputAut, apiAut) {
  const a = normalize(inputAut);
  const b = normalize(apiAut);
  if (a === b) return 1.0;

  // Tokens del autor (manejar "Apellido, Nombre")
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

  // Subset match (apellidos compartidos)
  if (ta.length && tb.length) {
    const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
    const longSet = new Set(long);
    let matches = 0;
    for (const t of short) if (longSet.has(t)) matches++;
    if (matches === short.length && matches >= 1) return 0.95;
  }

  // Best word-pair bigramas
  let bestWP = 0;
  if (ta.length && tb.length) {
    let total = 0, count = 0;
    for (const x of ta) {
      if (x.length < 3) continue;
      let best = 0;
      for (const y of tb) {
        if (y.length < 3) continue;
        const s = diceBigrams(x, y);
        if (s > best) best = s;
      }
      total += best; count++;
    }
    bestWP = count > 0 ? total / count : 0;
  }

  const jw = jaroWinkler(ta.join(' '), tb.join(' '));
  return Math.max(bestWP, jw);
}

// ─── APIs ──────────────────────────────────────────────────────────────
async function fetchAppleBooks(q) {
  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=ebook&limit=15&country=mx`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return { results: [], error: `http_${res.status}` };
    const data = await res.json();
    if (!data?.results?.length) return { results: [], error: null };
    const results = data.results
      .filter(r => r.trackName && r.artistName)
      .map(r => ({
        titulo: String(r.trackName).trim(),
        autor: String(r.artistName).trim(),
        year: r.releaseDate ? new Date(r.releaseDate).getFullYear() : null,
        source: 'apple_books'
      }));
    return { results, error: null };
  } catch (err) {
    return { results: [], error: err.message };
  }
}

async function fetchGoogleBooks(q) {
  try {
    const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=15&printType=books`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return { results: [], error: `http_${res.status}` };
    const data = await res.json();
    if (!data?.items?.length) return { results: [], error: null };
    const results = data.items
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
      .filter(Boolean);
    return { results, error: null };
  } catch (err) {
    return { results: [], error: err.message };
  }
}

async function fetchOpenLibrary(q) {
  try {
    const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=15&fields=title,author_name,first_publish_year`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return { results: [], error: `http_${res.status}` };
    const data = await res.json();
    if (!data?.docs?.length) return { results: [], error: null };
    const results = data.docs
      .filter(d => d.title && d.author_name?.length)
      .map(d => ({
        titulo: String(d.title).trim(),
        autor: String(d.author_name[0]).trim(),
        year: d.first_publish_year || null,
        source: 'openlibrary'
      }));
    return { results, error: null };
  } catch (err) {
    return { results: [], error: err.message };
  }
}

// ─── Multi-tier search con fallback inteligente ─────────────────────────
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
    errors: {
      apple: apple.error,
      google: google.error,
      openlibrary: ol.error
    },
    total: apple.results.length + google.results.length + ol.results.length
  };
}

// ─── 🌒 Función principal nivel divino ──────────────────────────────────
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

  // TIER 1: query principal
  const q1 = `${titulo} ${autor}`.trim();
  log('tier1 query:', q1);
  const tier1 = await searchAllAPIs(q1);
  log('tier1 results:', {
    apple: tier1.apple.length,
    google: tier1.google.length,
    openlibrary: tier1.openlibrary.length,
    errors: tier1.errors
  });

  let allCandidates = [...tier1.apple, ...tier1.google, ...tier1.openlibrary];

  // TIER 2 (fallback): si pocos resultados, buscar solo por autor
  if (allCandidates.length < 8 && autor.trim().length >= 4) {
    log('tier2 fallback: searching by author only');
    const tier2 = await searchAllAPIs(autor.trim());
    log('tier2 results:', {
      apple: tier2.apple.length,
      google: tier2.google.length,
      openlibrary: tier2.openlibrary.length
    });
    allCandidates = allCandidates.concat(tier2.apple, tier2.google, tier2.openlibrary);
  }

  const elapsed = Date.now() - startTime;

  // Si TOTAL = 0, las APIs no devolvieron NADA
  if (allCandidates.length === 0) {
    log('decision: no_api_results');
    return {
      verified: false,
      tipo: 'no_match', // 🌒 tratamos como no_match para mostrar "revisar bien"
      reason: 'apis_no_results',
      elapsed_ms: elapsed,
      debug: debugLog
    };
  }

  // Score cada candidato
  allCandidates.forEach(c => {
    c.sim_titulo = scoreTitulo(titulo, c.titulo);
    c.sim_autor = scoreAutor(autor, c.autor);
    c.sim_combinado = c.sim_titulo * 0.55 + c.sim_autor * 0.45;
  });

  // Deduplicar por título canónico
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

  // Rankear por: consenso (más fuentes) → similitud combinada
  const ranked = Array.from(consensus.values()).sort((a, b) => {
    if (b.sources.length !== a.sources.length) return b.sources.length - a.sources.length;
    return b.max_sim_combinado - a.max_sim_combinado;
  });

  log('top 5 candidates:', ranked.slice(0, 5).map(r => ({
    t: r.titulo_canonico.slice(0, 50),
    a: r.autor_canonico.slice(0, 30),
    sT: Math.round(r.max_sim_titulo * 100),
    sA: Math.round(r.max_sim_autor * 100),
    sC: Math.round(r.max_sim_combinado * 100),
    src: r.sources.length
  })));

  const best = ranked[0];
  const tituloInputN = normalize(titulo);
  const autorInputN = normalize(autor);
  const tituloBestN = normalize(best.titulo_canonico);
  const autorBestN = normalize(best.autor_canonico);

  // CASO A: ya canónico
  if (tituloBestN === tituloInputN && autorBestN === autorInputN) {
    log('decision: already_canonical');
    return {
      verified: true,
      already_canonical: true,
      sources_confirmed: best.sources,
      elapsed_ms: elapsed,
      debug: debugLog
    };
  }

  // CASO B: STRONG match (combinado ≥ 0.88)
  if (best.max_sim_combinado >= STRONG_SCORE) {
    log('decision: strong_match', { score: best.max_sim_combinado });
    return {
      verified: true,
      tipo: 'strong_match',
      suggestion: {
        titulo_canonico: best.titulo_canonico,
        autor_canonico: best.autor_canonico,
        year: best.years.length ? Math.min(...best.years) : null,
        sim_titulo: Math.round(best.max_sim_titulo * 100),
        sim_autor: Math.round(best.max_sim_autor * 100),
        sources: best.sources,
        confidence: best.sources.length >= 2 ? 'high' : 'medium'
      },
      elapsed_ms: elapsed,
      debug: debugLog
    };
  }

  // CASO C: WEAK match — autor matchea aunque sea decentemente → mostrar candidatos
  const topByAuthor = ranked.filter(r => r.max_sim_autor >= WEAK_AUTHOR_MIN);
  if (topByAuthor.length > 0) {
    log('decision: weak_match (candidates)', { count: topByAuthor.length });
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
      elapsed_ms: elapsed,
      debug: debugLog
    };
  }

  // CASO D: APIs respondieron pero nada coincide con el autor → REVISAR
  log('decision: no_match — sample top:', ranked.slice(0, 2));
  return {
    verified: false,
    tipo: 'no_match',
    reason: 'no_author_match',
    sample: ranked.slice(0, 2).map(r => ({
      titulo: r.titulo_canonico,
      autor: r.autor_canonico,
      sim_titulo: Math.round(r.max_sim_titulo * 100),
      sim_autor: Math.round(r.max_sim_autor * 100)
    })),
    elapsed_ms: elapsed,
    debug: debugLog
  };
}
