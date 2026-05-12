// ════════════════════════════════════════════════════════════════════════
// 🌒 verify-book.js v2 — Verificación externa multi-API NIVEL DIOS
// ════════════════════════════════════════════════════════════════════════
// Llama a 3 APIs gratuitas en paralelo para sugerir corrección de typos:
//   • Apple Books (iTunes Search API) — sin auth, sin límite
//   • Google Books — sin auth, 1000 req/día sin key
//   • OpenLibrary — sin auth, sin límite
//
// CAMBIOS v2 (cuántico-quark):
//   1. Strip de subtítulos antes de comparar (split por ":" "." " - ")
//   2. Jaccard token-set para detectar orden de palabras + número-letra
//   3. Threshold adaptativo: si autor matchea fuerte, baja umbral título
//   4. Queries menos estrictas en Google Books (sin intitle: exacto)
//   5. Comparación contra TODAS las variantes (raw + sin sub + sin art)
//
// Filosofía:
//   • Si ≥2 APIs coinciden en título canónico distinto al input → sugerir
//   • Si solo 1 API sugiere → mostrar con menos énfasis (info)
//   • Si las APIs devuelven IGUAL al input → no interrumpir
//   • Si TODAS fallan → no bloquear, dejar agregar tal cual
//   • Timeout estricto 2.5s para no colgar la UX
// ════════════════════════════════════════════════════════════════════════

const TIMEOUT_MS = 2500;

// Umbrales adaptativos
const STRONG_TITLE_MATCH = 0.85;
const WEAK_TITLE_MATCH = 0.55;
const STRONG_AUTHOR_MATCH = 0.85;
const MIN_AUTHOR_MATCH = 0.70;
const MAX_SIMILARITY_TO_SUGGEST = 0.985;

const STOPWORDS = new Set([
  'de','del','al','a','en','y','o','por','para','con','sin','la','el','los','las','un','una',
  'of','in','on','and','or','to','for','with','without','by','the','an'
]);

async function fetchWithTimeout(url, opts = {}, ms = TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(timeoutId);
    return res;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

function normalize(s) {
  return String(s || '').normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019\u02BC\u00B4\u0060]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, ' ')
    .toLowerCase()
    .replace(/^[\s.,;:!?"'`´¿¡()\[\]{}\-_]+|[\s.,;:!?"'`´¿¡()\[\]{}\-_]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripSubtitle(normalized) {
  const seps = [':', ' - ', ' — ', '. ', ' / '];
  let cutAt = -1;
  for (const sep of seps) {
    const idx = normalized.indexOf(sep);
    if (idx > 0 && (cutAt === -1 || idx < cutAt)) cutAt = idx;
  }
  if (cutAt > 0) return normalized.slice(0, cutAt).trim();
  return normalized;
}

const ARTICULOS = new Set(['el','la','los','las','un','una','the','a','an']);
function stripArticle(normalized) {
  const parts = normalized.split(' ');
  if (parts.length < 2) return normalized;
  if (ARTICULOS.has(parts[0])) return parts.slice(1).join(' ');
  return normalized;
}

function stem(w) {
  if (w.length < 4) return w;
  if (w.endsWith('mente')) return w.slice(0, -5);
  if (w.endsWith('ciones')) return w.slice(0, -6) + 'cion';
  if (w.endsWith('iones')) return w.slice(0, -5) + 'ion';
  if (w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.endsWith('es') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('s') && w.length > 4) return w.slice(0, -1);
  return w;
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
  for (let i = 0; i < mp; i++) {
    if (s1[i] === s2[i]) p++; else break;
  }
  return j + p * 0.1 * (1 - j);
}

function tokenizeForJaccard(normalized) {
  const noArt = stripArticle(normalized);
  const noSub = stripSubtitle(noArt);
  return noSub.split(/\s+/)
    .filter(t => (t.length >= 2 || /^\d+$/.test(t)) && !STOPWORDS.has(t))
    .map(stem);
}

function jaccardSimilarity(aN, bN) {
  const ta = tokenizeForJaccard(aN);
  const tb = tokenizeForJaccard(bN);
  if (!ta.length || !tb.length) return 0;
  const sa = new Set(ta);
  const sb = new Set(tb);
  let intersection = 0;
  for (const t of sa) if (sb.has(t)) intersection++;
  const union = sa.size + sb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function scoreTituloVsAPI(inputTitulo, apiTitulo) {
  const aN = normalize(inputTitulo);
  const bN = normalize(apiTitulo);
  if (aN === bN) return 1.0;

  const variants = (s) => {
    const noArt = stripArticle(s);
    const noSub = stripSubtitle(s);
    const noBoth = stripSubtitle(stripArticle(s));
    return [...new Set([s, noArt, noSub, noBoth])].filter(Boolean);
  };
  const aVars = variants(aN);
  const bVars = variants(bN);

  for (const a of aVars) for (const b of bVars) {
    if (a === b) return 0.97;
  }

  let maxJaccard = 0;
  for (const a of aVars) for (const b of bVars) {
    const j = jaccardSimilarity(a, b);
    if (j > maxJaccard) maxJaccard = j;
  }

  let maxJW = 0;
  for (const a of aVars) for (const b of bVars) {
    const jw1 = jaroWinkler(a, b);
    if (jw1 > maxJW) maxJW = jw1;
  }

  if (maxJaccard >= 0.8) return Math.max(0.9, maxJW);
  if (maxJaccard >= 0.5 && maxJW >= 0.6) return Math.max(0.75, (maxJaccard + maxJW) / 2);
  return Math.max(maxJW, maxJaccard);
}

function scoreAutor(inputAutor, apiAutor) {
  const aN = normalize(inputAutor);
  const bN = normalize(apiAutor);
  if (aN === bN) return 1.0;

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
  const ta = tokenize(aN);
  const tb = tokenize(bN);

  if (ta.length && tb.length) {
    const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
    const longSet = new Set(long);
    let matches = 0;
    for (const t of short) if (longSet.has(t)) matches++;
    if (matches === short.length && matches >= 1) return 0.95;
  }

  const sa = new Set(ta), sb = new Set(tb);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const jaccardA = (sa.size + sb.size - inter) > 0 ? inter / (sa.size + sb.size - inter) : 0;

  const directJW = jaroWinkler(ta.join(' '), tb.join(' '));

  return Math.max(directJW, jaccardA);
}

async function fetchAppleBooks(titulo, autor) {
  try {
    const q = encodeURIComponent(`${titulo} ${autor}`.trim());
    const url = `https://itunes.apple.com/search?term=${q}&entity=ebook&limit=10&country=mx`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.results?.length) return null;
    const candidates = data.results
      .filter(r => r.trackName && r.artistName)
      .map(r => ({
        titulo: String(r.trackName).trim(),
        autor: String(r.artistName).trim(),
        year: r.releaseDate ? new Date(r.releaseDate).getFullYear() : null,
        source: 'apple_books'
      }));
    return candidates.length ? candidates : null;
  } catch (err) {
    return null;
  }
}

async function fetchGoogleBooks(titulo, autor) {
  try {
    const q = encodeURIComponent(`${titulo} ${autor}`.trim());
    const url = `https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=10&printType=books`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.items?.length) return null;
    return data.items
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
  } catch (err) {
    return null;
  }
}

async function fetchOpenLibrary(titulo, autor) {
  try {
    const q = encodeURIComponent(`${titulo} ${autor}`.trim());
    const url = `https://openlibrary.org/search.json?q=${q}&limit=10&fields=title,author_name,first_publish_year`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.docs?.length) return null;
    return data.docs
      .filter(d => d.title && d.author_name?.length)
      .map(d => ({
        titulo: String(d.title).trim(),
        autor: String(d.author_name[0]).trim(),
        year: d.first_publish_year || null,
        source: 'openlibrary'
      }));
  } catch (err) {
    return null;
  }
}

export async function verifyBookExternal(titulo, autor) {
  const startTime = Date.now();

  const results = await Promise.allSettled([
    fetchAppleBooks(titulo, autor),
    fetchGoogleBooks(titulo, autor),
    fetchOpenLibrary(titulo, autor)
  ]);

  const allCandidates = [];
  const sourcesAttempted = ['apple_books', 'google_books', 'openlibrary'];
  const sourcesSucceeded = [];

  results.forEach((r, idx) => {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      sourcesSucceeded.push(sourcesAttempted[idx]);
      r.value.forEach(c => allCandidates.push(c));
    }
  });

  const elapsed = Date.now() - startTime;

  if (allCandidates.length === 0) {
    return {
      verified: false,
      reason: 'no_api_results',
      sources_attempted: sourcesAttempted,
      sources_succeeded: [],
      elapsed_ms: elapsed
    };
  }

  const tituloInputN = normalize(titulo);
  allCandidates.forEach(c => {
    c.sim_titulo = scoreTituloVsAPI(titulo, c.titulo);
    c.sim_autor = scoreAutor(autor, c.autor);
  });

  // 🌒 v2: Filtro adaptativo
  // Caso A: título fuerte (≥85%) Y autor mínimo (≥70%)
  // Caso B: autor MUY fuerte (≥85%) Y título suave (≥55%)
  const validCandidates = allCandidates.filter(c => {
    const sT = c.sim_titulo, sA = c.sim_autor;
    if (sT >= STRONG_TITLE_MATCH && sA >= MIN_AUTHOR_MATCH) return true;
    if (sA >= STRONG_AUTHOR_MATCH && sT >= WEAK_TITLE_MATCH) return true;
    return false;
  });

  if (validCandidates.length === 0) {
    return {
      verified: false,
      reason: 'no_strong_match',
      sources_succeeded: sourcesSucceeded,
      total_candidates: allCandidates.length,
      elapsed_ms: elapsed
    };
  }

  const consensus = new Map();
  validCandidates.forEach(c => {
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
    const entry = consensus.get(key);
    if (!entry.sources.includes(c.source)) entry.sources.push(c.source);
    if (c.sim_titulo > entry.max_sim_titulo) {
      entry.max_sim_titulo = c.sim_titulo;
      entry.titulo_canonico = c.titulo;
    }
    if (c.sim_autor > entry.max_sim_autor) {
      entry.max_sim_autor = c.sim_autor;
      entry.autor_canonico = c.autor;
    }
    const combined = c.sim_titulo * 0.6 + c.sim_autor * 0.4;
    if (combined > entry.max_sim_combinado) entry.max_sim_combinado = combined;
    if (c.year) entry.years.push(c.year);
  });

  const ranked = Array.from(consensus.values()).sort((a, b) => {
    if (b.sources.length !== a.sources.length) return b.sources.length - a.sources.length;
    return b.max_sim_combinado - a.max_sim_combinado;
  });

  const best = ranked[0];
  const tituloCanonicoN = normalize(best.titulo_canonico);

  if (best.max_sim_titulo >= MAX_SIMILARITY_TO_SUGGEST && tituloCanonicoN === tituloInputN) {
    return {
      verified: true,
      already_canonical: true,
      sources_confirmed: best.sources,
      elapsed_ms: elapsed
    };
  }

  const confidence = best.sources.length >= 2 ? 'high' : 'medium';

  return {
    verified: true,
    already_canonical: false,
    suggestion: {
      titulo_canonico: best.titulo_canonico,
      autor_canonico: best.autor_canonico,
      year: best.years.length ? Math.min(...best.years) : null,
      sim_titulo: Math.round(best.max_sim_titulo * 100),
      sim_autor: Math.round(best.max_sim_autor * 100),
      sources: best.sources,
      confidence,
      consensus_count: best.sources.length
    },
    elapsed_ms: elapsed
  };
}
