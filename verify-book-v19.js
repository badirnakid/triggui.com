// ════════════════════════════════════════════════════════════════════════
// 🌒 verify-book.js v3 — Verificación externa NIVEL DIOS TODOPODEROSO
// ════════════════════════════════════════════════════════════════════════
// CAPAS MATEMÁTICAS:
//   1. Normalización Unicode + smart quotes + invisible chars
//   2. Strip subtítulo (": " ". " " - " " — " " / ")
//   3. Strip artículo inicial (el/la/the/etc.)
//   4. Stemming básico ES/EN
//   5. Jaro-Winkler similarity
//   6. Jaccard token-set (orden de palabras + número-letra)
//   7. ⭐ NUEVO: Sørensen-Dice de bigramas (captura typos transpuestos)
//   8. ⭐ NUEVO: Best word-pair score (mejor par palabra-a-palabra)
//   9. Threshold adaptativo dual (título O autor pueden ser anclas)
//   10. ⭐ NUEVO: Fallback query solo por autor si primera no rinde
//
// TIPOS DE RESPUESTA:
//   strong_match    → sugerencia confiable (botón "Usar versión oficial")
//   weak_match      → candidatos posibles (botón "Es este libro" + "Otro")
//   no_match        → no se encontró nada confiable
//                     (botón "Verifica bien" + revisar)
//   already_canonical → input ya es el título canónico
//   no_api_results  → APIs caídas o sin resultados (fallback gracioso)
// ════════════════════════════════════════════════════════════════════════

const TIMEOUT_MS = 2500;

// Umbrales nivel divino
const STRONG_MATCH_THRESHOLD = 0.82;    // título Y autor combinado ≥ esto = strong
const WEAK_MATCH_THRESHOLD = 0.55;       // título O autor + dice palabra-pair = weak
const MIN_AUTHOR_FOR_WEAK = 0.80;        // autor mínimo para weak match
const MAX_SIMILARITY_TO_SUGGEST = 0.985; // ≥99% = canónico, no sugerir

const STOPWORDS = new Set([
  'de','del','al','a','en','y','o','por','para','con','sin','la','el','los','las','un','una',
  'of','in','on','and','or','to','for','with','without','by','the','an'
]);

const ARTICULOS = new Set(['el','la','los','las','un','una','the','a','an']);

// ─── Helpers de red ─────────────────────────────────────────────────────
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

// ─── Normalización ──────────────────────────────────────────────────────
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

function stripSubtitle(n) {
  const seps = [':', ' - ', ' — ', '. ', ' / '];
  let cutAt = -1;
  for (const sep of seps) {
    const idx = n.indexOf(sep);
    if (idx > 0 && (cutAt === -1 || idx < cutAt)) cutAt = idx;
  }
  if (cutAt > 0) return n.slice(0, cutAt).trim();
  return n;
}

function stripArticle(n) {
  const parts = n.split(' ');
  if (parts.length < 2) return n;
  if (ARTICULOS.has(parts[0])) return parts.slice(1).join(' ');
  return n;
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

// ─── Jaro-Winkler ───────────────────────────────────────────────────────
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

// ─── 🌒 Sørensen-Dice de bigramas (NUEVO v3) ────────────────────────────
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
    if (map.get(x) > 0) {
      inter++;
      map.set(x, map.get(x) - 1);
    }
  });
  return (2 * inter) / (ba.length + bb.length);
}

// 🌒 Best word-pair: para cada palabra del input, mejor match en API
function bestWordPairScore(inputWords, apiWords) {
  if (!inputWords.length || !apiWords.length) return 0;
  let totalScore = 0;
  let count = 0;
  for (const iw of inputWords) {
    if (iw.length < 3) continue; // skip palabras chicas
    let bestForThis = 0;
    for (const aw of apiWords) {
      if (aw.length < 3) continue;
      const s = diceBigrams(iw, aw);
      if (s > bestForThis) bestForThis = s;
    }
    totalScore += bestForThis;
    count++;
  }
  return count > 0 ? totalScore / count : 0;
}

// ─── Jaccard token-set ──────────────────────────────────────────────────
function tokenizeForJaccard(n) {
  const noArt = stripArticle(n);
  const noSub = stripSubtitle(noArt);
  return noSub.split(/\s+/)
    .filter(t => (t.length >= 2 || /^\d+$/.test(t)) && !STOPWORDS.has(t))
    .map(stem);
}

function tokenizeSimple(n) {
  return stripSubtitle(stripArticle(n)).split(/\s+/)
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
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

// ─── 🌒 Score título NIVEL DIVINO (multi-señal) ─────────────────────────
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

  // Match exacto en alguna variante
  for (const a of aVars) for (const b of bVars) {
    if (a === b) return 0.97;
  }

  // Señales paralelas
  let maxJaccard = 0;
  let maxJW = 0;
  let maxBigram = 0;  // 🌒 NUEVO: dice bigram word-pair

  for (const a of aVars) {
    for (const b of bVars) {
      const j = jaccardSimilarity(a, b);
      if (j > maxJaccard) maxJaccard = j;

      const jw = jaroWinkler(a, b);
      if (jw > maxJW) maxJW = jw;

      // Word-pair bigram
      const inputWords = tokenizeSimple(a);
      const apiWords = tokenizeSimple(b);
      const wp = bestWordPairScore(inputWords, apiWords);
      if (wp > maxBigram) maxBigram = wp;
    }
  }

  // Decisión inteligente: cualquier señal fuerte gana
  if (maxJaccard >= 0.8) return Math.max(0.9, maxJW);
  if (maxJW >= 0.85) return maxJW;
  if (maxBigram >= 0.7) return Math.max(0.85, maxBigram); // 🌒 typos transpuestos
  if (maxBigram >= 0.55 && maxJW >= 0.5) return (maxBigram + maxJW) / 2 + 0.1;
  if (maxJaccard >= 0.5 && maxJW >= 0.6) return Math.max(0.75, (maxJaccard + maxJW) / 2);

  return Math.max(maxJW, maxJaccard, maxBigram * 0.85);
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

  // Subset match (Apellido completo en ambos)
  if (ta.length && tb.length) {
    const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
    const longSet = new Set(long);
    let matches = 0;
    for (const t of short) if (longSet.has(t)) matches++;
    if (matches === short.length && matches >= 1) return 0.95;
  }

  // 🌒 NUEVO: bigram word-pair para autor también
  const bigramScore = bestWordPairScore(ta, tb);
  if (bigramScore >= 0.85) return Math.max(0.9, bigramScore);
  if (bigramScore >= 0.7) return Math.max(0.82, bigramScore);

  // Jaccard tokens
  const sa = new Set(ta), sb = new Set(tb);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const jaccardA = (sa.size + sb.size - inter) > 0 ? inter / (sa.size + sb.size - inter) : 0;

  // Jaro-Winkler completo
  const directJW = jaroWinkler(ta.join(' '), tb.join(' '));

  return Math.max(directJW, jaccardA, bigramScore);
}

// ─── APIs externas ──────────────────────────────────────────────────────
async function fetchAppleBooks(q) {
  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=ebook&limit=10&country=mx`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.results?.length) return null;
    return data.results
      .filter(r => r.trackName && r.artistName)
      .map(r => ({
        titulo: String(r.trackName).trim(),
        autor: String(r.artistName).trim(),
        year: r.releaseDate ? new Date(r.releaseDate).getFullYear() : null,
        source: 'apple_books'
      }));
  } catch { return null; }
}

async function fetchGoogleBooks(q) {
  try {
    const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=10&printType=books`;
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
  } catch { return null; }
}

async function fetchOpenLibrary(q) {
  try {
    const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=10&fields=title,author_name,first_publish_year`;
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
  } catch { return null; }
}

// ─── 🌒 Multi-tier lookup con fallback ──────────────────────────────────
async function gatherCandidates(titulo, autor) {
  // TIER 1: query combinado
  const q1 = `${titulo} ${autor}`.trim();
  const t1 = await Promise.allSettled([
    fetchAppleBooks(q1),
    fetchGoogleBooks(q1),
    fetchOpenLibrary(q1)
  ]);

  const candidates = [];
  const succeeded = [];
  const sourceNames = ['apple_books', 'google_books', 'openlibrary'];

  t1.forEach((r, idx) => {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      if (!succeeded.includes(sourceNames[idx])) succeeded.push(sourceNames[idx]);
      r.value.forEach(c => candidates.push(c));
    }
  });

  // 🌒 TIER 2 (fallback): si autor parece confiable y candidates pocos → buscar solo por autor
  // Esto captura casos como "Abitus Tomicus James Claro" donde "James Clear"
  // matchea fuerte y nos da el libro real
  const needFallback = candidates.length < 5;
  if (needFallback && autor.trim().length >= 4) {
    const q2 = autor.trim();
    const t2 = await Promise.allSettled([
      fetchAppleBooks(q2),
      fetchGoogleBooks(q2)
    ]);
    t2.forEach((r, idx) => {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        if (!succeeded.includes(sourceNames[idx])) succeeded.push(sourceNames[idx]);
        r.value.forEach(c => candidates.push(c));
      }
    });
  }

  return { candidates, succeeded, sourceNames };
}

// ─── 🌒 API público nivel dios ──────────────────────────────────────────
export async function verifyBookExternal(titulo, autor) {
  const startTime = Date.now();

  const { candidates, succeeded, sourceNames } = await gatherCandidates(titulo, autor);
  const elapsed = Date.now() - startTime;

  // Si NADA respondió, devolver no_api_results (frontend mostrará "verifica bien")
  if (candidates.length === 0) {
    return {
      verified: false,
      reason: 'no_api_results',
      sources_attempted: sourceNames,
      sources_succeeded: [],
      elapsed_ms: elapsed
    };
  }

  // Score cada candidato
  const tituloInputN = normalize(titulo);
  candidates.forEach(c => {
    c.sim_titulo = scoreTituloVsAPI(titulo, c.titulo);
    c.sim_autor = scoreAutor(autor, c.autor);
    c.sim_combinado = c.sim_titulo * 0.6 + c.sim_autor * 0.4;
  });

  // De-duplicar por título canónico (consenso entre APIs)
  const consensus = new Map();
  candidates.forEach(c => {
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
    if (c.sim_combinado > entry.max_sim_combinado) entry.max_sim_combinado = c.sim_combinado;
    if (c.year) entry.years.push(c.year);
  });

  // Rankear: por consenso (más fuentes) y por similitud combinada
  const ranked = Array.from(consensus.values()).sort((a, b) => {
    if (b.sources.length !== a.sources.length) return b.sources.length - a.sources.length;
    return b.max_sim_combinado - a.max_sim_combinado;
  });

  // ═══ DECISIÓN NIVEL DIVINO ═══
  // strong_match: combinado ≥ 0.82
  // weak_match: autor ≥ 0.80 y al menos algo de señal de título (≥ 0.40)
  // no_match: nada se parece

  const best = ranked[0];
  const tituloCanonicoN = normalize(best.titulo_canonico);

  // already_canonical
  if (best.max_sim_titulo >= MAX_SIMILARITY_TO_SUGGEST && tituloCanonicoN === tituloInputN) {
    return {
      verified: true,
      already_canonical: true,
      sources_confirmed: best.sources,
      elapsed_ms: elapsed
    };
  }

  // strong_match: confianza alta para sugerencia
  if (best.max_sim_combinado >= STRONG_MATCH_THRESHOLD) {
    const confidence = best.sources.length >= 2 ? 'high' : 'medium';
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
        confidence,
        consensus_count: best.sources.length
      },
      elapsed_ms: elapsed
    };
  }

  // weak_match: autor fuerte (≥0.80) y algo de título → mostrar candidatos
  if (best.max_sim_autor >= MIN_AUTHOR_FOR_WEAK && best.max_sim_titulo >= 0.40) {
    const topCandidates = ranked
      .filter(r => r.max_sim_autor >= MIN_AUTHOR_FOR_WEAK)
      .slice(0, 3)
      .map(r => ({
        titulo: r.titulo_canonico,
        autor: r.autor_canonico,
        year: r.years.length ? Math.min(...r.years) : null,
        sim_titulo: Math.round(r.max_sim_titulo * 100),
        sim_autor: Math.round(r.max_sim_autor * 100),
        sources: r.sources
      }));
    return {
      verified: true,
      tipo: 'weak_match',
      candidates: topCandidates,
      elapsed_ms: elapsed
    };
  }

  // no_match: nada coincide bien → pedir revisión
  return {
    verified: false,
    tipo: 'no_match',
    reason: 'low_confidence',
    sources_succeeded: succeeded,
    elapsed_ms: elapsed
  };
}
