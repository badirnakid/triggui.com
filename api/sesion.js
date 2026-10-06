// ════════════════════════════════════════════════════════════════════════
// 🔑 /api/sesion · ¿este aparato ya está reconocido?
// ════════════════════════════════════════════════════════════════════════
// GET   responde { agregar: true|false, detonar: true|false } según la sesión
//       de este aparato, y de paso la renueva. No revela nada más.
// POST  con { "cerrar": true } cierra la sesión de este aparato.
//
// Los formularios /agregar y /detonar la consultan al abrir para saber si
// todavía tienen que pedir la llave.
// ════════════════════════════════════════════════════════════════════════

import { estadoSesion, cerrarSesion, mismoSitio } from './_llave.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    return res.status(200).json(estadoSesion(req, res));
  }

  if (req.method === 'POST') {
    if (!mismoSitio(req)) {
      return res.status(403).json({ error: 'Petición de otro sitio. No se acepta.' });
    }
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    if (body.cerrar === true) {
      cerrarSesion(res);
      return res.status(200).json({ ok: true, agregar: false, detonar: false });
    }
    return res.status(400).json({ error: 'Petición no reconocida.' });
  }

  return res.status(405).json({ error: 'Método no permitido.' });
}
