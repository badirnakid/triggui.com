// ════════════════════════════════════════════════════════════════════════
// 🌒 IN-EDICIÓN — la última edición intencional, lista para triggui.com/in
// ════════════════════════════════════════════════════════════════════════
// Lee contenido_manual.json (la MISMA fuente que el email del lunes: la vista
// filtrada de ediciones single, libros[0] = la más reciente) del lado servidor
// vía la GitHub Contents API. Devuelve lo que /in necesita para armar el preview
// de LinkedIn: slug, frases, y las URLs de tarjeta/og/edición.
//
// El slug viene del campo _slug que el nucleus persiste (de /tmp/triggui-slug.txt,
// el mismo que build-editions usa). Sin _slug no se arman las URLs, así que si la
// edición no lo trae todavía, se devuelve slug:null y /in muestra "regenera un single".
//
// GET /api/in-edicion -> { ok:true, edicion:{...} | null }
// ════════════════════════════════════════════════════════════════════════

const OWNER = 'badirnakid';
const REPO = 'triggui-content';
const PATH = 'contenido_manual.json';
const REF = 'main';

// Base pública donde viven las ediciones (Vercel triggui-app).
const APP_BASE = 'https://app.triggui.com';

export default async function handler(req, res) {
  // Caché de borde corta: fresco pero instantáneo.
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');

  try {
    const token = process.env.GITHUB_TOKEN_ACTIONS || process.env.GITHUB_TOKEN;
    const headers = {
      'Accept': 'application/vnd.github.raw+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'triggui-in/1.0',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(PATH)}?ref=${REF}`;
    const ghRes = await fetch(url, { headers });

    if (!ghRes.ok) {
      let detail = '';
      try { detail = await ghRes.text(); } catch (_) {}
      return res.status(502).json({
        ok: false,
        error: `No se pudo leer ${PATH} de GitHub (${ghRes.status}).`,
        detail: detail.slice(0, 200),
      });
    }

    // Con Accept: raw, el body ES el JSON crudo del archivo.
    const data = await ghRes.json();
    const libros = (data && Array.isArray(data.libros)) ? data.libros : [];
    const b = libros[0] || null;

    if (!b) {
      // Manual vacío: no hay edición intencional vigente (igual que el email no tendría qué mandar).
      return res.status(200).json({ ok: true, edicion: null });
    }

    const slug = (typeof b._slug === 'string' && b._slug.trim()) ? b._slug.trim() : null;

    // Pools de frases disponibles (de aquí salen bocado/eco; /in deja elegir cuál).
    const arr = (x) => Array.isArray(x) ? x.filter((s) => typeof s === 'string' && s.trim()) : [];
    const frases = arr(b.frases);
    const frases_og = arr(b.frases_og);
    const parrafo = (b.tarjeta && typeof b.tarjeta.parrafoTop === 'string') ? b.tarjeta.parrafoTop.trim() : '';

    const edicion = {
      titulo: String(b.titulo || '').trim(),
      autor: String(b.autor || '').trim(),
      slug,
      edicion_numero: (typeof b._edicion_numero === 'number') ? b._edicion_numero : null,
      // Frases crudas (con emoji); /in las limpia para LinkedIn (§13.9 sin emojis).
      frases,
      frases_og,
      parrafo,
      // URLs públicas (null si aún no hay slug).
      urls: slug ? {
        edicion: `${APP_BASE}/t/${slug}/`,
        tarjeta: `${APP_BASE}/t/${slug}/tarjeta.png`,
        og: `${APP_BASE}/t/${slug}/og.png`,
      } : null,
    };

    return res.status(200).json({ ok: true, edicion });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: 'Error leyendo la edición.',
      detail: err && err.message ? err.message : String(err),
    });
  }
}
