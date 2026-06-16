// ════════════════════════════════════════════════════════════════════════
// 🖼️ IN-IMAGEN — proxy de descarga limpia para /in
// ════════════════════════════════════════════════════════════════════════
// Las imágenes viven en app.triggui.com (otro dominio). Este proxy las trae
// del lado servidor y las devuelve same-origin: para descarga limpia en compu
// y para construir el File del menú de compartir en cel.
//
// GET /api/in-imagen?slug=nonzero&tipo=tarjeta|og  -> PNG (attachment)
// Seguridad: slug sanitizado (a-z 0-9 -), host/ruta fijos.
// ════════════════════════════════════════════════════════════════════════

const APP_BASE = 'https://app.triggui.com';

export default async function handler(req, res) {
  const rawSlug = String((req.query && req.query.slug) || '').trim().toLowerCase();
  const slug = rawSlug.replace(/[^a-z0-9-]/g, '');
  const tipo = ((req.query && req.query.tipo) === 'og') ? 'og' : 'tarjeta';

  if (!slug) {
    return res.status(400).json({ ok: false, error: 'falta slug' });
  }

  const url = `${APP_BASE}/t/${slug}/${tipo}.png`;

  try {
    const r = await fetch(url);
    if (!r.ok) {
      return res.status(502).json({ ok: false, error: `no se pudo traer la imagen (${r.status})` });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="triggui-${slug}-${tipo}.png"`);
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).send(buf);
  } catch (err) {
    return res.status(500).json({ ok: false, error: (err && err.message) ? err.message : String(err) });
  }
}
