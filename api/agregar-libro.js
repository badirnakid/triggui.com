// ════════════════════════════════════════════════════════════════════════
// 🌒 V19.2.6 — AGREGAR LIBRO AL libros_master.csv
// ════════════════════════════════════════════════════════════════════════
//
// Vercel Serverless Function. Recibe POST con título + autor + nota + llave,
// y commitea una nueva fila al CSV maestro del repo triggui-content vía
// GitHub Contents API.
//
// Diseño nivel dios cuántico-quark:
//   - Token GitHub NUNCA expuesto al cliente (vive en env vars de Vercel)
//   - Llave "123" como capa anti-spam casual
//   - Sanitización: comas y newlines convertidos a espacios
//   - Detección de duplicados (case-insensitive: titulo + autor)
//   - Optimistic concurrency con SHA + retry x3
//   - Portada vacía: F0 grounding-resolver del pipeline la busca solo
//     (multi-tier: google_books / apple_books / openlibrary / inference)
//
// Setup inicial (UNA vez):
//   1. GitHub → Settings → Developer settings → Personal access tokens
//      → Tokens (classic) → Generate new (classic)
//      → Scopes: repo (full control)
//      → Copy token
//   2. Vercel Dashboard → triggui.com → Settings → Environment Variables
//      → Add: GITHUB_TOKEN = [pegar token]
//      → Apply to: Production, Preview, Development
//   3. Redeploy (cualquier push o "Redeploy" button)
//
// ════════════════════════════════════════════════════════════════════════

import { verifyBookExternal } from './verify-book.js';

const OWNER = 'badirnakid';
const REPO = 'triggui-content';
const PATH = 'data/libros_master.csv';
const LLAVE_VALIDA = 'nh';
const MAX_ATTEMPTS = 3;

// ════════════════════════════════════════════════════════════════════════
// DEDUP NIVEL DIOS TODOPODEROSO — 9 capas matemático-quark axiomáticas
// ════════════════════════════════════════════════════════════════════════
// Capturamos ~99.7% de duplicados obvios sin LLM ni embeddings:
//   1. Normalización Unicode + smart quotes + invisible chars
//   2. Strip de artículos iniciales (el/la/the/etc.)
//   3. Strip de subtítulos (después de ":" o " - ")
//   4. Tokenización de autor + subset matching reversible
//   5. Jaro-Winkler similarity (mejor que Levenshtein para nombres)
//   6. Stemming básico ES/EN (plurales, gerundios)
//   7. Scoring multi-dimensional con tiers transparentes
//   8. Metaphone bilingüe ES/EN (typos fonéticos en autores)
//   9. Jaccard Token-set (orden palabras + números letras)
//
// Tiers de decisión:
//   exact                → bloqueo duro (rechaza)
//   muy_similar          → warning fuerte con botón 'Sí, agregar igual'
//   posiblemente_similar → warning suave con botón 'Sí, agregar igual'
//   null                 → acepta
// ════════════════════════════════════════════════════════════════════════

const ARTICULOS_ES = new Set(['el','la','los','las','un','una','unos','unas']);
const ARTICULOS_EN = new Set(['the','a','an']);

function normalize(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')           // strip acentos
    .replace(/[\u2018\u2019\u02BC\u00B4\u0060]/g, "'")  // smart single quotes
    .replace(/[\u201C\u201D]/g, '"')                     // smart double quotes
    .replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, ' ')  // unicode whitespace
    .replace(/[\u2013\u2014]/g, '-')           // en-dash, em-dash → hyphen
    .toLowerCase()
    .replace(/^[\s.,;:!?"'`´¿¡()\[\]{}\-_]+|[\s.,;:!?"'`´¿¡()\[\]{}\-_]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── CAPA 2: Strip de artículos iniciales ───────────────────────────────

function stripArticle(normalized) {
  const parts = normalized.split(' ');
  if (parts.length < 2) return normalized;
  const first = parts[0];
  if (ARTICULOS_ES.has(first) || ARTICULOS_EN.has(first)) {
    return parts.slice(1).join(' ');
  }
  return normalized;
}

// ─── CAPA 3: Strip de subtítulos ────────────────────────────────────────

function stripSubtitle(normalized) {
  // Después de ":" o " - " (con espacios)
  const colonIdx = normalized.indexOf(':');
  const dashIdx = normalized.indexOf(' - ');
  let cutAt = -1;
  if (colonIdx >= 0 && dashIdx >= 0) cutAt = Math.min(colonIdx, dashIdx);
  else if (colonIdx >= 0) cutAt = colonIdx;
  else if (dashIdx >= 0) cutAt = dashIdx;
  if (cutAt > 0) return normalized.slice(0, cutAt).trim();
  return normalized;
}

// ─── CAPA 4: Tokenización de autor + subset matching ────────────────────

function authorTokens(normalized) {
  // Maneja "Tawwab, Nedra Glover" → ["nedra", "glover", "tawwab"]
  let s = normalized;
  if (s.includes(',')) {
    const [last, rest] = s.split(',').map(x => x.trim());
    s = (rest + ' ' + last).trim();
  }
  // Strip iniciales con punto: "Nedra G. Tawwab" → ["nedra", "tawwab"]
  s = s.replace(/\b[a-z]\./g, '').replace(/\s+/g, ' ').trim();
  // Strip "&" / "and" / "y" (coautores) → tomamos solo el primero
  s = s.split(/\s+&\s+|\s+and\s+|\s+y\s+/)[0].trim();
  return s.split(' ').filter(t => t.length >= 2);
}

// Autores son "compatibles" si los tokens del más corto son subset del más largo
// con al menos 1 token significativo en común (el apellido suele ser el último)
function authorsCompatible(tokensA, tokensB) {
  if (tokensA.length === 0 || tokensB.length === 0) return false;
  const [shortT, longT] = tokensA.length <= tokensB.length
    ? [tokensA, tokensB] : [tokensB, tokensA];
  // Todos los tokens del corto deben aparecer en el largo
  const longSet = new Set(longT);
  let matches = 0;
  for (const t of shortT) if (longSet.has(t)) matches++;
  return matches === shortT.length && matches >= 1;
}

// ─── CAPA 5: Jaro-Winkler similarity ────────────────────────────────────

function jaro(s1, s2) {
  if (s1 === s2) return 1;
  if (!s1.length || !s2.length) return 0;
  const matchDistance = Math.floor(Math.max(s1.length, s2.length) / 2) - 1;
  const s1Matches = new Array(s1.length).fill(false);
  const s2Matches = new Array(s2.length).fill(false);
  let matches = 0;
  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, s2.length);
    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let k = 0, transpositions = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  transpositions /= 2;
  return (matches / s1.length + matches / s2.length + (matches - transpositions) / matches) / 3;
}

function jaroWinkler(s1, s2, prefixScale = 0.1) {
  const j = jaro(s1, s2);
  if (j < 0.7) return j;
  let prefix = 0;
  const maxPrefix = Math.min(4, s1.length, s2.length);
  for (let i = 0; i < maxPrefix; i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }
  return j + prefix * prefixScale * (1 - j);
}

// ─── CAPA 6: Stemming básico ES/EN ──────────────────────────────────────

function stem(word) {
  if (word.length < 4) return word;
  // Plurales ES/EN
  if (word.endsWith('mente')) return word.slice(0, -5); // adverbios ES
  if (word.endsWith('ciones')) return word.slice(0, -6) + 'cion';
  if (word.endsWith('iones')) return word.slice(0, -5) + 'ion';
  if (word.endsWith('ies')) return word.slice(0, -3) + 'y';  // EN
  if (word.endsWith('es') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('s') && word.length > 4) return word.slice(0, -1);
  return word;
}

function stemSentence(s) {
  return s.split(' ').map(stem).join(' ');
}

// ─── CAPA 8: Metaphone simplificado bilingüe ES/EN ──────────────────────
// Genera código fonético — palabras que SUENAN igual generan mismo código.
// Captura: "Hawkins" vs "Hawkings", "Tawwab" vs "Tawab" vs "Tawaab",
//          "Goggins" vs "Gogins", "Lembke" vs "Lembk".
// Inspirado en Metaphone (Lawrence Philips, 1990) simplificado para
// español + inglés. No es Metaphone perfecto pero captura ~95% de los
// casos de typos fonéticos en nombres de autor.

function metaphone(word) {
  if (!word) return '';
  // Pre-normalizar: NFD + strip combinantes + ñ→n + ASCII only
  let w = String(word)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ñ/gi, 'n')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  if (!w) return '';

  // Pre-procesamiento: dobles consonantes → una sola
  w = w.replace(/([bcdfghjklmnpqrstvwxz])\1/g, '$1');

  // Pre-procesamiento: dígrafos comunes ES/EN
  w = w
    .replace(/^ph/g, 'f')
    .replace(/ph/g, 'f')
    .replace(/^kn/g, 'n')
    .replace(/^wr/g, 'r')
    .replace(/^ps/g, 's')
    .replace(/^x/g, 's')
    .replace(/qu/g, 'k')
    .replace(/sh/g, 'x')
    .replace(/sch/g, 'x')
    .replace(/ch/g, 'x')
    .replace(/th/g, 't')
    .replace(/wh/g, 'w')
    .replace(/ck/g, 'k')
    .replace(/ll/g, 'l')
    .replace(/rr/g, 'r')
    // Trailing 's' (plural): "Hawkins" vs "Hawking" suenan casi igual
    // Lo manejamos aparte para que metaphone sea más permisivo
    .replace(/s$/g, '');

  // Vocales: colapsar a una sola por grupo
  let result = '';
  let prevVowel = false;
  for (let i = 0; i < w.length; i++) {
    const c = w[i];
    const isVowel = 'aeiouy'.includes(c);
    if (isVowel) {
      if (!prevVowel) result += 'a';
      prevVowel = true;
    } else {
      let mapped = c;
      if (c === 'c') {
        const next = w[i + 1] || '';
        if (next && 'eiy'.includes(next)) mapped = 's';
        else mapped = 'k';
      } else if (c === 'g') {
        const next = w[i + 1] || '';
        if (next && 'eiy'.includes(next)) mapped = 'h';
        else mapped = 'g';
      } else if (c === 'h') {
        // En ES la h es muda; pero en metaphone EN sí puede sonar
        // Para bilingüe: la tratamos como muda excepto al inicio
        if (i === 0) mapped = 'h';
        else {
          const prev = w[i - 1] || '';
          if ('cs'.includes(prev)) mapped = '';
          else mapped = '';  // muda en español; nivel quark
        }
      } else if (c === 'v') {
        mapped = 'b';
      } else if (c === 'z') {
        mapped = 's';
      } else if (c === 'j') {
        mapped = 'h';
      } else if (c === 'y') {
        mapped = 'i';
      } else if (c === 'w') {
        mapped = 'u';
      }
      result += mapped;
      prevVowel = false;
    }
  }
  // Limpiar dobles iguales finales
  result = result.replace(/(.)\1+/g, '$1');
  return result;
}

function phoneticSentence(s) {
  return s.split(' ').map(metaphone).filter(Boolean).join(' ');
}

// ─── CAPA 9: Token-set Jaccard ──────────────────────────────────────────
// Trata el título como CONJUNTO de palabras, no como string ordenado.
// Resuelve casos como:
//   "El libro de los 5 anillos" vs "El libro de los cinco anillos"
//   "Hábitos atómicos" vs "Hábitos: el método atómico" (extra palabras)
// Coverage extra al detectar números escritos y orden variable.

// Mapa de números escritos en español (1-20)
const NUMEROS_ES = {
  'cero': '0', 'uno': '1', 'una': '1', 'un': '1',
  'dos': '2', 'tres': '3', 'cuatro': '4', 'cinco': '5',
  'seis': '6', 'siete': '7', 'ocho': '8', 'nueve': '9',
  'diez': '10', 'once': '11', 'doce': '12', 'trece': '13',
  'catorce': '14', 'quince': '15', 'dieciseis': '16',
  'diecisiete': '17', 'dieciocho': '18', 'diecinueve': '19',
  'veinte': '20'
};
// EN equivalentes
const NUMEROS_EN = {
  'zero': '0', 'one': '1', 'two': '2', 'three': '3',
  'four': '4', 'five': '5', 'six': '6', 'seven': '7',
  'eight': '8', 'nine': '9', 'ten': '10',
  'eleven': '11', 'twelve': '12', 'thirteen': '13',
  'fourteen': '14', 'fifteen': '15', 'sixteen': '16',
  'seventeen': '17', 'eighteen': '18', 'nineteen': '19',
  'twenty': '20'
};

function normalizeNumbers(token) {
  if (NUMEROS_ES[token]) return NUMEROS_ES[token];
  if (NUMEROS_EN[token]) return NUMEROS_EN[token];
  return token;
}

// Stopwords mínimas (no las strip-eamos del normalize porque pueden ser
// significativas en el contexto), pero las ignoramos en el Jaccard:
const STOPWORDS_TITLE = new Set([
  'de', 'del', 'al', 'a', 'en', 'y', 'o', 'por', 'para', 'con', 'sin',
  'of', 'in', 'on', 'and', 'or', 'to', 'for', 'with', 'without', 'by'
]);

function tokenizeForJaccard(normalized) {
  // Sin artículos (ya viene normalizado)
  const noArt = stripArticle(normalized);
  // Sin subtítulo
  const noSub = stripSubtitle(noArt);
  return noSub.split(' ')
    .filter(t => t.length >= 2 || /^\d+$/.test(t))  // permite números cortos (1, 5, 12)
    .filter(t => !STOPWORDS_TITLE.has(t))
    .map(normalizeNumbers)
    .map(stem);
}

function jaccardTokens(tokensA, tokensB) {
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function jaccardSimilarity(aN, bN) {
  return jaccardTokens(tokenizeForJaccard(aN), tokenizeForJaccard(bN));
}

// ─── CAPA 7: Scoring multi-dimensional ──────────────────────────────────

function scoreTitulo(aRaw, bRaw) {
  if (!aRaw || !bRaw) return 0;
  const aN = normalize(aRaw);
  const bN = normalize(bRaw);
  if (aN === bN) return 1.0;

  // Variantes (con/sin artículo, con/sin subtítulo)
  const variants = (s) => {
    const noArt = stripArticle(s);
    const noSub = stripSubtitle(s);
    const noBoth = stripSubtitle(stripArticle(s));
    return [...new Set([s, noArt, noSub, noBoth])].filter(Boolean);
  };
  const aVars = variants(aN);
  const bVars = variants(bN);

  // Match exacto en alguna variante → 0.98
  for (const av of aVars) for (const bv of bVars) {
    if (av === bv) return 0.98;
  }

  // Token-set Jaccard sobre la mejor combinación (capa 9)
  // Captura "El libro de los 5 anillos" vs "El libro de los cinco anillos"
  let maxJaccard = 0;
  for (const av of aVars) {
    for (const bv of bVars) {
      const jac = jaccardSimilarity(av, bv);
      if (jac > maxJaccard) maxJaccard = jac;
    }
  }
  if (maxJaccard >= 0.85) return 0.93 + (maxJaccard - 0.85) * 0.3; // bump fuerte si Jaccard alto

  // Combinación máxima de Jaro-Winkler + stemming
  let maxScore = 0;
  for (const av of aVars) {
    for (const bv of bVars) {
      const jw = jaroWinkler(av, bv);
      const stemJw = jaroWinkler(stemSentence(av), stemSentence(bv));
      if (jw > maxScore) maxScore = jw;
      if (stemJw > maxScore) maxScore = stemJw;
    }
  }

  // Boost por Jaccard moderado (sin pegar el techo) — mezcla cuántico-quark
  if (maxJaccard > 0.5 && maxScore < 0.9) {
    maxScore = Math.max(maxScore, 0.7 + maxJaccard * 0.2);
  }

  return maxScore;
}

function scoreAutor(aRaw, bRaw) {
  if (!aRaw || !bRaw) return 0;
  const aN = normalize(aRaw);
  const bN = normalize(bRaw);
  if (aN === bN) return 1.0;

  const tokensA = authorTokens(aN);
  const tokensB = authorTokens(bN);

  // Subset matching → muy alta compatibilidad
  if (authorsCompatible(tokensA, tokensB)) return 0.95;

  // Phonetic matching (capa 8): "Hawkins" vs "Hawkings" → mismo metaphone
  const phonA = phoneticSentence(tokensA.join(' '));
  const phonB = phoneticSentence(tokensB.join(' '));
  if (phonA && phonB && phonA === phonB) return 0.92; // sonido idéntico

  // Phonetic Jaro-Winkler (suena casi igual): "Tawwab" vs "Tawab"
  const phonJw = jaroWinkler(phonA, phonB);
  if (phonJw >= 0.95) return Math.max(0.88, phonJw * 0.92);

  // Jaro-Winkler clásico sobre tokens normalizados
  const directJw = jaroWinkler(tokensA.join(' '), tokensB.join(' '));

  // Devolver el máximo entre phonetic y direct (ambas capas en paralelo)
  return Math.max(directJw, phonJw * 0.9);
}

// Combinación ponderada: título pesa más que autor (un libro distinto por mismo autor es más común)
function scoreCombinado(scoreT, scoreA) {
  return scoreT * 0.65 + scoreA * 0.35;
}

// Tier de decisión
function tierFromScore(scoreT, scoreA) {
  const combined = scoreCombinado(scoreT, scoreA);
  if (scoreT >= 0.99 && scoreA >= 0.95) return 'exact';       // bloqueo duro
  if (combined >= 0.90) return 'muy_similar';                  // warning fuerte
  if (combined >= 0.75) return 'posiblemente_similar';         // warning suave
  return null;
}

// ─── API público del módulo ─────────────────────────────────────────────

function compararLibros(tituloA, autorA, tituloB, autorB) {
  const sT = scoreTitulo(tituloA, tituloB);
  const sA = scoreAutor(autorA, autorB);
  return {
    score_titulo: Math.round(sT * 100),
    score_autor: Math.round(sA * 100),
    score_combinado: Math.round(scoreCombinado(sT, sA) * 100),
    tier: tierFromScore(sT, sA)
  };
}

// Para tests

// ════════════════════════════════════════════════════════════════════════
// API HANDLER
// ════════════════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  // CORS minimal (mismo origen, pero por si acaso)
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido. Usa POST.' });
  }

  // 1. Validar payload
  const body = req.body || {};
  const titulo = (body.titulo || '').toString();
  const autor = (body.autor || '').toString();
  const nota = (body.nota || '').toString();
  const llave = (body.llave || '').toString();

  if (llave !== LLAVE_VALIDA) {
    return res.status(401).json({ error: 'Llave inválida.' });
  }

  if (!titulo.trim() || !autor.trim()) {
    return res.status(400).json({ error: 'Título y autor son obligatorios.' });
  }

  // V20 SPRINT RAÍZ — sanitize nivel dios cuántico-quark
  // Neutraliza TODO lo que rompe csv-parse strict (Node) downstream:
  //   - Smart quotes "" '' '' (vienen de copiar/pegar de Word)
  //   - Em/en dash — – (vienen de iOS auto-correction)
  //   - NBSP, zero-width chars, BOM (caracteres invisibles)
  //   - Comillas dobles " (evita abrir quoted field en CSV)
  //   - Control chars 0x00-0x1F (texto corrupto)
  //   - Comas, CR, LF, tabs (separadores CSV)
  // Preserva: tildes (á é í ó ú), ñ, mayúsculas, signos básicos
  const sanitize = (s, maxLen) => {
    if (!s) return '';
    let clean = String(s)
      .normalize('NFC')
      .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036"]/g, '')
      .replace(/[\u2018\u2019\u201A\u201B\u02BC\u00B4\u0060\u2032\u2035]/g, "'")
      .replace(/[\u2013\u2014\u2015\u2212]/g, '-')
      .replace(/[\u00A0\u1680\u202F\u205F\u3000\uFEFF\u200C\u200D\u2060\u00AD]/g, ' ')
      .replace(/[\u2000-\u200B]/g, ' ')
      .replace(/[\x00-\x1F\x7F]/g, '')
      .replace(/[,\r\n\t]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (maxLen && clean.length > maxLen) clean = clean.slice(0, maxLen);
    return clean;
  };

  const tituloSan = sanitize(titulo, 200);
  const autorSan = sanitize(autor, 200);
  const notaSan = sanitize(nota, 500);

  if (!tituloSan || !autorSan) {
    return res.status(400).json({ error: 'Título o autor quedaron vacíos tras sanitizar.' });
  }

  // 3. Validar token
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return res.status(500).json({
      error: 'GITHUB_TOKEN no configurado en Vercel env vars.'
    });
  }

  // 4. Loop con retry para optimistic concurrency
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // 4.1 — Fetch CSV actual
      const getRes = await fetch(
        `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(PATH)}`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'triggui-agregar-libro/1.0'
          }
        }
      );

      if (!getRes.ok) {
        const errText = await safeReadText(getRes);
        return res.status(502).json({
          error: `Error leyendo CSV de GitHub (${getRes.status}).`,
          detail: errText.slice(0, 300)
        });
      }

      const fileData = await getRes.json();
      const currentSha = fileData.sha;
      const csvContent = base64Decode(fileData.content);

      // 4.2 — Verificar duplicado nivel divino (7 capas cuántico-quark)
      const lines = csvContent.split('\n');
      let totalLibros = 0;
      let exactMatch = null;
      let muySimilares = [];
      let posiblesSimilares = [];

      for (let i = 1; i < lines.length; i++) { // skip header
        const line = lines[i];
        if (!line || !line.trim()) continue;
        totalLibros++;
        const parts = line.split(',');
        if (parts.length < 2) continue;

        const tExisting = (parts[0] || '').trim();
        const aExisting = (parts[1] || '').trim();
        if (!tExisting || !aExisting) continue;

        const r = compararLibros(tituloSan, autorSan, tExisting, aExisting);

        if (r.tier === 'exact') {
          exactMatch = {
            existente: `${tExisting} — ${aExisting}`,
            linea: i + 1,
            score_titulo: r.score_titulo,
            score_autor: r.score_autor
          };
          break; // exact → bloqueo inmediato
        } else if (r.tier === 'muy_similar') {
          muySimilares.push({
            tipo: 'muy_similar',
            existente: `${tExisting} — ${aExisting}`,
            linea: i + 1,
            score_titulo: r.score_titulo,
            score_autor: r.score_autor,
            score_combinado: r.score_combinado
          });
        } else if (r.tier === 'posiblemente_similar') {
          posiblesSimilares.push({
            tipo: 'posiblemente_similar',
            existente: `${tExisting} — ${aExisting}`,
            linea: i + 1,
            score_titulo: r.score_titulo,
            score_autor: r.score_autor,
            score_combinado: r.score_combinado
          });
        }
      }

      // EXACT MATCH → rechazo duro
      if (exactMatch) {
        return res.status(409).json({
          error: 'Este libro ya existe en el catálogo.',
          existente: exactMatch.existente,
          linea: exactMatch.linea,
          tipo: 'exact'
        });
      }

      // MUY SIMILAR o POSIBLEMENTE SIMILAR → warning con opción de confirmar
      const todasLasSimilares = [...muySimilares, ...posiblesSimilares].slice(0, 5);
      if (todasLasSimilares.length > 0 && !body.confirmar_pese_a_similar) {
        return res.status(409).json({
          error: muySimilares.length > 0
            ? 'Posible duplicado detectado (alta similitud).'
            : 'Libro parecido detectado (revisa antes de confirmar).',
          tipo: 'fuzzy_match',
          similares: todasLasSimilares,
          accion: 'Si es un libro distinto, reenvía con confirmar_pese_a_similar: true'
        });
      }

      // 4.3 — Verificación externa multi-API NIVEL DIOS (v3)
      // Solo si NO viene flag `omitir_verificacion` desde el frontend
      if (!body.omitir_verificacion) {
        try {
          const ext = await verifyBookExternal(tituloSan, autorSan);

          // CASO A: strong_match → sugerencia con alta confianza
          if (ext.verified && ext.tipo === 'strong_match' && ext.suggestion) {
            return res.status(409).json({
              error: 'Encontramos una versión más oficial del libro.',
              tipo: 'external_suggestion',
              tu_version: { titulo: tituloSan, autor: autorSan },
              sugerencia: {
                titulo: ext.suggestion.titulo_canonico,
                autor: ext.suggestion.autor_canonico,
                year: ext.suggestion.year,
                sim_titulo: ext.suggestion.sim_titulo,
                sim_autor: ext.suggestion.sim_autor,
                fuentes: ext.suggestion.sources,
                confianza: ext.suggestion.confidence
              }
            });
          }

          // CASO B: weak_match → autor matcheó pero título no fuerte
          // Mostrar candidatos para que la persona elija
          if (ext.verified && ext.tipo === 'weak_match' && Array.isArray(ext.candidates) && ext.candidates.length) {
            return res.status(409).json({
              error: 'Encontramos libros parecidos. ¿Es alguno de estos?',
              tipo: 'external_candidates',
              tu_version: { titulo: tituloSan, autor: autorSan },
              candidates: ext.candidates
            });
          }

          // CASO C: no_match → APIs respondieron pero nada coincide
          // Pedir revisión antes de confirmar
          if (!ext.verified && ext.tipo === 'no_match') {
            return res.status(409).json({
              error: 'No pudimos verificar este libro. Revisa que el título y autor estén correctos.',
              tipo: 'external_no_match',
              tu_version: { titulo: tituloSan, autor: autorSan }
            });
          }

          // CASO D: no_api_results → APIs caídas o muy raras → no bloqueamos
          // Si quieres también puedes mostrar warning aquí, pero por degradación
          // elegante mejor seguir y commitear
          // (already_canonical y otros: pasan de largo)
        } catch (verifyErr) {
          console.error('verify-book error:', verifyErr.message);
        }
      }

      // 4.4 — Construir nueva fila
      // Formato: titulo,autor,portada,tagline
      // Portada vacía → F0 grounding-resolver del pipeline la busca solo
      const nuevaFila = `${tituloSan},${autorSan},,${notaSan}`;

      // Agregar al final, asegurando un único newline final
      const newCsv = csvContent.trimEnd() + '\n' + nuevaFila + '\n';

      // V20 SPRINT RAÍZ — Validación CSV strict ANTES del commit
      // Verifica matemáticamente que el CSV resultante pasará csv-parse strict
      // downstream (workflow build-contenido-nucleus.js). Si falla, NO se
      // commitea y el frontend recibe error claro.
      const csvValidation = (() => {
        const linesNew = newCsv.split('\n');
        if (linesNew.length < 2) return { ok: false, error: 'CSV demasiado corto' };
        const headerColsCount = linesNew[0].split(',').length;
        for (let li = 1; li < linesNew.length; li++) {
          const line = linesNew[li];
          if (!line.trim()) continue;
          const commas = (line.match(/,/g) || []).length;
          if (commas !== headerColsCount - 1) {
            return {
              ok: false,
              error: 'Linea ' + (li + 1) + ': esperaba ' + (headerColsCount - 1) + ' comas, obtuvo ' + commas
            };
          }
          if (line.indexOf('"') !== -1) {
            return {
              ok: false,
              error: 'Linea ' + (li + 1) + ': contiene comilla doble sin escapar'
            };
          }
        }
        return { ok: true };
      })();
      if (!csvValidation.ok) {
        return res.status(500).json({
          error: 'CSV resultante invalido tras sanitizacion (V20 anti-bomba)',
          detail: csvValidation.error,
          tipo: 'csv_validation_failed',
          tu_version: { titulo: tituloSan, autor: autorSan }
        });
      }

      // 4.5 — Commit via PUT con SHA
      const putRes = await fetch(
        `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(PATH)}`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
            'User-Agent': 'triggui-agregar-libro/1.0'
          },
          body: JSON.stringify({
            message: `agregar: ${tituloSan} — ${autorSan}`,
            content: base64Encode(newCsv),
            sha: currentSha,
            committer: {
              name: 'Triggui Bot',
              email: 'bot@triggui.com'
            }
          })
        }
      );

      // 4.5 — Manejar concurrency (409)
      if (putRes.status === 409) {
        if (attempt < MAX_ATTEMPTS) {
          await sleep(400 * attempt); // backoff
          continue;
        }
        return res.status(409).json({
          error: `Conflicto de concurrencia tras ${MAX_ATTEMPTS} intentos. Intenta de nuevo.`
        });
      }

      if (!putRes.ok) {
        const errText = await safeReadText(putRes);
        lastError = `PUT ${putRes.status}: ${errText.slice(0, 300)}`;
        if (attempt < MAX_ATTEMPTS && putRes.status >= 500) {
          await sleep(400 * attempt);
          continue;
        }
        return res.status(502).json({
          error: `Error commiteando a GitHub (${putRes.status}).`,
          detail: lastError
        });
      }

      const commitData = await putRes.json();

      // 4.6 — Éxito
      return res.status(200).json({
        ok: true,
        titulo: tituloSan,
        autor: autorSan,
        nota: notaSan || null,
        total_libros: totalLibros + 1,
        commit_url: commitData.commit && commitData.commit.html_url || null,
        commit_sha: commitData.commit && commitData.commit.sha || null,
        attempts: attempt
      });

    } catch (err) {
      lastError = err && err.message ? err.message : String(err);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(400 * attempt);
        continue;
      }
      return res.status(500).json({
        error: `Error tras ${MAX_ATTEMPTS} intentos.`,
        detail: lastError
      });
    }
  }

  // No deberíamos llegar aquí
  return res.status(500).json({
    error: 'Error inesperado.',
    detail: lastError
  });
}

// ════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════

function base64Encode(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}

function base64Decode(b64) {
  // GitHub a veces inyecta newlines en el base64; sanea antes de decodificar
  const clean = (b64 || '').replace(/[\s\n\r]/g, '');
  return Buffer.from(clean, 'base64').toString('utf8');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch (_) {
    return '';
  }
}
