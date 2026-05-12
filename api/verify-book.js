// ════════════════════════════════════════════════════════════════════════
// 🌒 verify-book.js — Verificación externa multi-API nivel dios
// ════════════════════════════════════════════════════════════════════════
// Llama a 3 APIs gratuitas en paralelo para sugerir corrección de typos:
//   • Apple Books (iTunes Search API) — sin auth, sin límite
//   • Google Books — sin auth, 1000 req/día sin key
//   • OpenLibrary — sin auth, sin límite
//
// Filosofía:
//   • Si ≥2 APIs coinciden en título canónico distinto al input → sugerir
//   • Si solo 1 API sugiere → mostrar con menos énfasis (info)
//   • Si las APIs devuelven IGUAL al input → no interrumpir
//   • Si TODAS fallan → no bloquear, dejar agregar tal cual
//   • Timeout estricto 2s para no colgar la UX
//
// Reusa las mismas técnicas de normalización + Jaro-Winkler del backend.
// ════════════════════════════════════════════════════════════════════════

const TIMEOUT_MS = 2000;
const MIN_SIMILARITY_TO_SUGGEST = 0.85; // similitud mínima para considerar "match"
const MAX_SIMILARITY_TO_SUGGEST = 0.99;  // si es ≥99% es básicamente lo mismo
const MIN_AUTHOR_SIMILARITY = 0.70;       // autor también debe coincidir razonablemente

// ─── Helper: fetch con timeout ──────────────────────────────────────────
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

// ─── Normalización + Jaro-Winkler (subset del módulo principal) ─────────
function normalizeForCompare(s) {
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

function jaro(s1, s2) {
  if (s1 === s2) return 1;
  if (!s1.length || !s2.length) return 0;
  const md = Math.floor(Math.max(s1.length, s2.length) / 2) - 1;
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

// ─── API 1: Apple iTunes Search ─────────────────────────────────────────
async function fetchAppleBooks(titulo, autor) {
  try {
    const q = encodeURIComponent(`${titulo} ${autor}`.trim());
    const url = `https://itunes.apple.com/search?term=${q}&entity=ebook&limit=5&country=mx`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.results?.length) return null;
    // Tomar el mejor match: que tenga ambos title y artistName
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

// ─── API 2: Google Books ────────────────────────────────────────────────
async function fetchGoogleBooks(titulo, autor) {
  try {
    const q = encodeURIComponent(`intitle:"${titulo}" inauthor:"${autor}"`);
    const url = `https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=5&printType=books`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.items?.length) {
      // Reintentar sin filtros estrictos
      const q2 = encodeURIComponent(`${titulo} ${autor}`.trim());
      const url2 = `https://www.googleapis.com/books/v1/volumes?q=${q2}&maxResults=5&printType=books`;
      const res2 = await fetchWithTimeout(url2);
      if (!res2.ok) return null;
      const data2 = await res2.json();
      if (!data2?.items?.length) return null;
      return parseGoogleItems(data2.items);
    }
    return parseGoogleItems(data.items);
  } catch (err) {
    return null;
  }
}

function parseGoogleItems(items) {
  return items
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
}

// ─── API 3: OpenLibrary ─────────────────────────────────────────────────
async function fetchOpenLibrary(titulo, autor) {
  try {
    const q = encodeURIComponent(`${titulo} ${autor}`.trim());
    const url = `https://openlibrary.org/search.json?q=${q}&limit=5&fields=title,author_name,first_publish_year`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.docs?.length) return null;
    const candidates = data.docs
      .filter(d => d.title && d.author_name?.length)
      .map(d => ({
        titulo: String(d.title).trim(),
        autor: String(d.author_name[0]).trim(),
        year: d.first_publish_year || null,
        source: 'openlibrary'
      }));
    return candidates.length ? candidates : null;
  } catch (err) {
    return null;
  }
}

// ─── Lookup multi-API en paralelo ───────────────────────────────────────
export async function verifyBookExternal(titulo, autor) {
  const startTime = Date.now();

  // Lanzar las 3 en paralelo con timeout colectivo
  const results = await Promise.allSettled([
    fetchAppleBooks(titulo, autor),
    fetchGoogleBooks(titulo, autor),
    fetchOpenLibrary(titulo, autor)
  ]);

  const elapsed = Date.now() - startTime;

  // Recolectar candidatos de todas las APIs
  const allCandidates = [];
  const sourcesAttempted = ['apple_books', 'google_books', 'openlibrary'];
  const sourcesSucceeded = [];

  results.forEach((r, idx) => {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      sourcesSucceeded.push(sourcesAttempted[idx]);
      r.value.forEach(c => allCandidates.push(c));
    }
  });

  // Si ninguna API respondió → no podemos sugerir, dejar pasar
  if (allCandidates.length === 0) {
    return {
      verified: false,
      reason: 'no_api_results',
      sources_attempted: sourcesAttempted,
      sources_succeeded: [],
      elapsed_ms: elapsed
    };
  }

  // Scoring de cada candidato vs input
  const tituloInputN = normalizeForCompare(titulo);
  const autorInputN = normalizeForCompare(autor);

  allCandidates.forEach(c => {
    c.tituloN = normalizeForCompare(c.titulo);
    c.autorN = normalizeForCompare(c.autor);
    c.sim_titulo = jaroWinkler(tituloInputN, c.tituloN);
    c.sim_autor = jaroWinkler(autorInputN, c.autorN);
    c.sim_combinado = c.sim_titulo * 0.65 + c.sim_autor * 0.35;
  });

  // Filtro: solo candidatos con autor consistente Y similitud razonable
  const validCandidates = allCandidates.filter(c =>
    c.sim_autor >= MIN_AUTHOR_SIMILARITY && c.sim_titulo >= MIN_SIMILARITY_TO_SUGGEST
  );

  if (validCandidates.length === 0) {
    return {
      verified: false,
      reason: 'no_strong_match',
      sources_succeeded: sourcesSucceeded,
      total_candidates: allCandidates.length,
      elapsed_ms: elapsed
    };
  }

  // Agrupar candidatos por título canónico normalizado (consenso entre APIs)
  const consensus = new Map();
  validCandidates.forEach(c => {
    const key = c.tituloN;
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
      entry.titulo_canonico = c.titulo; // mejor versión del título
    }
    if (c.sim_autor > entry.max_sim_autor) {
      entry.max_sim_autor = c.sim_autor;
      entry.autor_canonico = c.autor;
    }
    if (c.sim_combinado > entry.max_sim_combinado) {
      entry.max_sim_combinado = c.sim_combinado;
    }
    if (c.year) entry.years.push(c.year);
  });

  // Convertir a array y ordenar por: número de fuentes (desc) → similitud (desc)
  const ranked = Array.from(consensus.values()).sort((a, b) => {
    if (b.sources.length !== a.sources.length) return b.sources.length - a.sources.length;
    return b.max_sim_combinado - a.max_sim_combinado;
  });

  const best = ranked[0];
  const bestTituloN = normalizeForCompare(best.titulo_canonico);

  // ═══ DECISIÓN ═══
  // Si el título canónico es IGUAL al input (post-normalización) → input ya OK
  if (bestTituloN === tituloInputN && best.max_sim_titulo >= MAX_SIMILARITY_TO_SUGGEST) {
    return {
      verified: true,
      already_canonical: true,
      sources_confirmed: best.sources,
      elapsed_ms: elapsed
    };
  }

  // Si hay diferencia → sugerir corrección
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
