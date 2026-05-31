/* ════════════════════════════════════════════════════════════════════════
   🌒 BookSearch — motor de búsqueda-y-selección NIVEL DIOS
   ════════════════════════════════════════════════════════════════════════
   Filosofía: el algoritmo difuso NO decide (juez) — solo ORDENA (bibliotecario).
   La decisión final la toma el humano reconociendo de una lista. Eso da
   exactitud 100% real: reconocer es perfecto; adivinar de un fragmento, no.

   Usado idéntico en /agregar (contra libros_master.csv) y /detonar (contra
   las ediciones de contenido.json). Determinista, sin LLM, sin red extra.

   API:
     BookSearch.rank(query, items, opts) -> [{ item, score, titleHits, ... }]
     BookSearch.highlight(text, query)   -> HTML con <mark> en lo que coincide
     BookSearch.normalize(s)             -> forma normalizada (acentos fuera)

   Bug histórico que esto MATA: el preview viejo hacía `a || libro.autor`,
   inventando autor=100% cuando el campo autor estaba vacío → +35 pts a TODOS
   → "puros libros que ni se parecen". Aquí: si no hay autor, se puntúa SOLO
   por título. Cero inflación.
   ════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  // ─── Normalización (acentos fuera, minúsculas, espacios colapsados) ───
  function normalize(s) {
    return String(s == null ? '' : s)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[\u2018\u2019\u02BC\u00B4\u0060]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, ' ')
      .replace(/[\u2013\u2014]/g, '-')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  function stripEdges(n) {
    return n.replace(/^[\s.,;:!?"'`´¿¡()\[\]{}\-_]+|[\s.,;:!?"'`´¿¡()\[\]{}\-_]+$/g, '');
  }

  const ARTICULOS = new Set(['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'the', 'a', 'an']);
  const STOP = new Set(['de', 'del', 'al', 'a', 'en', 'y', 'o', 'por', 'para', 'con', 'sin', 'of', 'in', 'on', 'and', 'or', 'to', 'for', 'with', 'without', 'by']);
  // Palabras reales pero de BAJO valor de señal: aparecen en muchísimos títulos,
  // así que compartir SOLO una de éstas no convierte a dos libros en parecidos.
  // (Sin esto, "mi libro inventado" matcheaba "El libro del ego" por "libro".)
  const GENERIC = new Set([
    'libro', 'libros', 'guia', 'guias', 'manual', 'metodo', 'arte', 'poder', 'vida',
    'mundo', 'historia', 'historias', 'ser', 'hacer', 'como', 'tu', 'tus', 'mi', 'mis',
    'work', 'book', 'guide', 'art', 'life', 'world', 'way', 'ways', 'how', 'your', 'self'
  ]);

  function stripArticle(n) {
    const p = n.split(' ');
    if (p.length < 2) return n;
    return ARTICULOS.has(p[0]) ? p.slice(1).join(' ') : n;
  }
  function stripSubtitle(n) {
    const c = n.indexOf(':'), d = n.indexOf(' - ');
    let a = -1;
    if (c >= 0 && d >= 0) a = Math.min(c, d);
    else if (c >= 0) a = c;
    else if (d >= 0) a = d;
    return a > 0 ? n.slice(0, a).trim() : n;
  }

  // ─── Jaro-Winkler (typos) ───
  function jaro(s1, s2) {
    if (s1 === s2) return 1;
    if (!s1.length || !s2.length) return 0;
    const md = Math.floor(Math.max(s1.length, s2.length) / 2) - 1;
    const m1 = new Array(s1.length).fill(false), m2 = new Array(s2.length).fill(false);
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
  function jw(s1, s2) {
    const j = jaro(s1, s2);
    if (j < 0.7) return j;
    let p = 0;
    const mp = Math.min(4, s1.length, s2.length);
    for (let i = 0; i < mp; i++) { if (s1[i] === s2[i]) p++; else break; }
    return j + p * 0.1 * (1 - j);
  }

  // ─── Jaccard de tokens (orden de palabras, subtítulos) ───
  function tokens(n) {
    return stripSubtitle(stripArticle(n)).split(' ')
      .filter(t => t.length >= 2 || /^\d+$/.test(t))
      .filter(t => !STOP.has(t));
  }
  function jaccard(aN, bN) {
    const ta = tokens(aN), tb = tokens(bN);
    if (!ta.length || !tb.length) return 0;
    const sa = new Set(ta), sb = new Set(tb);
    let i = 0;
    for (const t of sa) if (sb.has(t)) i++;
    return i / (sa.size + sb.size - i);
  }

  // ─── Relevancia de un campo contra la query (substring/prefix/fuzzy) ───
  // Devuelve 0..1. Pensado para BÚSQUEDA: substring exacto manda, fuzzy ayuda.
  function fieldRelevance(queryN, fieldN) {
    if (!queryN) return 0;
    if (!fieldN) return 0;
    if (fieldN === queryN) return 1;

    // Substring directo (acento-insensible ya, por normalize)
    const idx = fieldN.indexOf(queryN);
    if (idx === 0) return 0.97;           // prefijo del campo
    if (idx > 0) return 0.90;             // contiene la query

    // Cada palabra de la query es prefijo de alguna palabra del campo
    const qWords = queryN.split(' ').filter(Boolean);
    const fWords = fieldN.split(' ').filter(Boolean);
    if (qWords.length) {
      const allPrefix = qWords.every(qw => fWords.some(fw => fw.startsWith(qw)));
      if (allPrefix) return 0.86;
    }

    // Fuzzy SOLO con evidencia léxica REAL y SIGNIFICATIVA: comparten una
    // palabra de fondo (≥4 letras) por prefijo largo o por similitud fuerte.
    // Un prefijo corto genérico ("mi", "gra", "lib") NO cuenta — eso es lo que
    // hacía salir "La gramática del vino" al escribir "gratitud". Esta guarda
    // mata el ruido sin perder typos reales dentro de una misma palabra.
    const qToks = tokens(queryN).filter(t => t.length >= 4 && !GENERIC.has(t));
    const fToks = tokens(fieldN).filter(t => t.length >= 4 && !GENERIC.has(t));
    let lexicalOverlap = false;
    for (const qt of qToks) {
      for (const ft of fToks) {
        const a = qt.length <= ft.length ? qt : ft;
        const b = qt.length <= ft.length ? ft : qt;
        // comparten prefijo largo (≥4) Y las palabras completas se parecen
        // de verdad (no solo el arranque): "inventado" vs "invertir" comparten
        // "inve" pero NO son la misma palabra → fuera.
        if (b.startsWith(a.slice(0, Math.min(4, a.length))) && a.length >= 4) {
          if (jw(qt, ft) >= 0.86) { lexicalOverlap = true; break; }
        }
        // o typo dentro de la misma palabra (muy parecidas completas)
        if (jw(qt, ft) >= 0.90) { lexicalOverlap = true; break; }
      }
      if (lexicalOverlap) break;
    }
    if (!lexicalOverlap) return 0;   // sin palabra significativa en común → NO candidato

    // Fuzzy: Jaccard de tokens (reorden/subtítulo) + Jaro-Winkler (typos)
    const jac = jaccard(queryN, fieldN);
    let best = jac >= 0.85 ? 0.84 : 0;
    const jwScore = jw(stripSubtitle(stripArticle(queryN)), stripSubtitle(stripArticle(fieldN)));
    if (jwScore > best) best = jwScore;
    if (jac > 0.5 && best < 0.8) best = Math.max(best, 0.6 + jac * 0.2);
    return best;
  }

  // ─── Ranking principal ───
  // query: string crudo. Si trae "|", la parte izq = título, der = autor.
  // items: [{ titulo, autor, ... }]
  // opts.floor: relevancia mínima de título para MOSTRAR (default 0.55).
  // opts.limit: cuántos devolver (default 8).
  // Devuelve [{ item, score, titleRel, authorRel }] ordenado desc.
  function rank(query, items, opts) {
    opts = opts || {};
    const floor = typeof opts.floor === 'number' ? opts.floor : 0.55;
    const limit = typeof opts.limit === 'number' ? opts.limit : 8;

    const raw = String(query == null ? '' : query);
    let titleQ = raw, authorQ = '';
    if (raw.indexOf('|') !== -1) {
      const parts = raw.split('|');
      titleQ = parts[0] || '';
      authorQ = parts.slice(1).join('|') || '';
    }
    const titleQN = stripEdges(normalize(titleQ));
    const authorQN = stripEdges(normalize(authorQ));
    if (!titleQN && !authorQN) return [];

    const out = [];
    for (const item of items) {
      if (!item) continue;
      const itemTitleN = stripEdges(normalize(item.titulo));
      const itemAuthorN = stripEdges(normalize(item.autor));

      let titleRel, authorRel, passTitle, passCombo, score;

      if (authorQN) {
        // El usuario separó con "|": título a la izquierda, autor a la derecha.
        titleRel = titleQN ? fieldRelevance(titleQN, itemTitleN) : 0;
        authorRel = fieldRelevance(authorQN, itemAuthorN);
        passTitle = titleRel >= floor;
        passCombo = (titleRel * 0.6 + authorRel * 0.4) >= floor && titleRel >= 0.4;
        if (!passTitle && !passCombo) continue;
        score = titleRel * 0.7 + authorRel * 0.3;
      } else {
        // Sin "|": el texto puede ser TÍTULO o AUTOR. Probamos ambos y nos
        // quedamos con el mejor — así "tu momento" (título) y "victor hugo"
        // (autor) funcionan igual, sin que tú sepas cuál es cuál.
        const relAsTitle = fieldRelevance(titleQN, itemTitleN);
        const relAsAuthor = fieldRelevance(titleQN, itemAuthorN);
        titleRel = relAsTitle;
        authorRel = relAsAuthor;
        const best = Math.max(relAsTitle, relAsAuthor);
        if (best < floor) continue;
        score = best;
      }

      out.push({ item: item, score: score, titleRel: titleRel, authorRel: authorRel });
    }

    out.sort((x, y) => {
      if (y.score !== x.score) return y.score - x.score;
      // desempate estable: título más corto primero (match más "limpio")
      return String(x.item.titulo || '').length - String(y.item.titulo || '').length;
    });
    return out.slice(0, limit);
  }

  // ─── Resaltado (acento-insensible) ───
  // Marca, dentro de `text`, el tramo que corresponde a `query` (substring
  // sobre la versión normalizada, mapeado de vuelta a los índices originales).
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  // Normaliza char por char manteniendo un mapa al índice original.
  function normalizeWithMap(text) {
    let norm = '';
    const map = []; // map[posEnNorm] = posEnOriginal
    const chars = Array.from(String(text == null ? '' : text));
    for (let i = 0; i < chars.length; i++) {
      let n = chars[i]
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[\u2018\u2019\u02BC\u00B4\u0060]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, ' ')
        .replace(/[\u2013\u2014]/g, '-')
        .toLowerCase();
      // n puede ser 0..n chars; cada uno apunta al mismo índice original i
      for (let k = 0; k < n.length; k++) { norm += n[k]; map.push(i); }
    }
    return { norm: norm, map: map, chars: chars };
  }

  function highlight(text, query) {
    const original = String(text == null ? '' : text);
    const raw = String(query == null ? '' : query);
    // usa solo la parte de título de la query
    const titleQ = raw.indexOf('|') !== -1 ? raw.split('|')[0] : raw;
    const qn = stripEdges(normalize(titleQ));
    if (!qn) return escapeHtml(original);

    const { norm, map, chars } = normalizeWithMap(original);
    const at = norm.indexOf(qn);
    if (at === -1) return escapeHtml(original); // sin substring directo → sin marca (honesto)

    const startOrig = map[at];
    const endOrig = map[at + qn.length - 1];
    const before = chars.slice(0, startOrig).join('');
    const mid = chars.slice(startOrig, endOrig + 1).join('');
    const after = chars.slice(endOrig + 1).join('');
    return escapeHtml(before) + '<mark>' + escapeHtml(mid) + '</mark>' + escapeHtml(after);
  }

  // slugify idéntico al del pipeline (validate-book.js) — para derivar URL
  function slugify(text) {
    return stripEdges(normalize(text)).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  global.BookSearch = {
    rank: rank,
    highlight: highlight,
    normalize: function (s) { return stripEdges(normalize(s)); },
    slugify: slugify,
    escapeHtml: escapeHtml,
    _fieldRelevance: fieldRelevance // expuesto para tests
  };
})(typeof window !== 'undefined' ? window : this);
