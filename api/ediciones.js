// ════════════════════════════════════════════════════════════════════════
// 🌒 EDICIONES — lista ligera de ediciones ya generadas (para el selector)
// ════════════════════════════════════════════════════════════════════════
// El contenido.json pesa ~3.3 MB; bajarlo entero al navegador (y vía caché
// de jsDelivr) es lento y frágil. Este endpoint lo lee del lado servidor por
// la GitHub Contents API y devuelve SOLO { titulo, autor, num } por edición
// — unos pocos KB. Rápido, siempre fresco, sin caché de terceros.
//
// No necesita token de escritura: el repo triggui-content es público, así que
// leemos por la API pública (con token si está, para subir el rate limit).
//
// GET /api/ediciones  -> { ok:true, ediciones:[{titulo,autor,num}], total }
// ════════════════════════════════════════════════════════════════════════

const OWNER = 'badirnakid';
const REPO = 'triggui-content';
const PATH = 'contenido.json';
const REF = 'main';

export default async function handler(req, res) {
  // Cache de borde corto: 60s fresco + 5min stale-while-revalidate.
  // Suficiente para que se sienta instantáneo sin servir datos viejos.
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');

  try {
    const token = process.env.GITHUB_TOKEN_ACTIONS || process.env.GITHUB_TOKEN;
    const headers = {
      'Accept': 'application/vnd.github.raw+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'triggui-ediciones/1.0',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(PATH)}?ref=${REF}`;
    const ghRes = await fetch(url, { headers });

    if (!ghRes.ok) {
      let detail = '';
      try { detail = await ghRes.text(); } catch (_) {}
      return res.status(502).json({
        ok: false,
        error: `No se pudo leer contenido.json de GitHub (${ghRes.status}).`,
        detail: detail.slice(0, 200),
      });
    }

    // Con Accept: raw, el body ES el JSON crudo del archivo
    const data = await ghRes.json();
    const libros = (data && Array.isArray(data.libros)) ? data.libros : [];

    const ediciones = libros
      .filter(b => b && b.titulo && b.autor)
      .map(b => ({
        titulo: String(b.titulo).trim(),
        autor: String(b.autor).trim(),
        num: (typeof b._edicion_numero === 'number') ? b._edicion_numero : null,
      }));

    return res.status(200).json({ ok: true, ediciones: ediciones, total: ediciones.length });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: 'Error leyendo ediciones.',
      detail: err && err.message ? err.message : String(err),
    });
  }
}
