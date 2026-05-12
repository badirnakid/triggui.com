// ════════════════════════════════════════════════════════════════════════
// 🌒 /api/debug-verify — Endpoint público para diagnosticar el verify
// ════════════════════════════════════════════════════════════════════════
// URL ejemplo:
//   triggui.com/api/debug-verify?titulo=Abitus%20Tomicus&autor=James%20Claro
//
// Devuelve JSON crudo con:
//   - input recibido
//   - resultado completo de verifyBookExternal
//   - debug log de cada paso
//
// USO: simplemente abre la URL en el navegador. Te muestra todo el flujo.
// Útil para diagnosticar cuando algo "pasa mantequilla".
// ════════════════════════════════════════════════════════════════════════

import { verifyBookExternal } from './verify-book.js';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  const titulo = (req.query?.titulo || '').toString().trim();
  const autor = (req.query?.autor || '').toString().trim();

  if (!titulo || !autor) {
    return res.status(400).json({
      error: 'Faltan parámetros',
      uso: '/api/debug-verify?titulo=...&autor=...',
      ejemplo: '/api/debug-verify?titulo=Abitus%20Tomicus&autor=James%20Claro'
    });
  }

  try {
    const result = await verifyBookExternal(titulo, autor, { verbose: true });
    return res.status(200).json({
      input: { titulo, autor },
      result,
      hint: result.tipo === 'no_match'
        ? '⚠️ no_match — el frontend mostraría "Revisa bien antes de continuar"'
        : result.tipo === 'weak_match'
        ? '🟡 weak_match — el frontend mostraría candidatos para elegir'
        : result.tipo === 'strong_match'
        ? '🔵 strong_match — el frontend mostraría sugerencia única'
        : result.already_canonical
        ? '✓ already_canonical — el frontend agregaría sin interrumpir'
        : 'otro tipo'
    });
  } catch (err) {
    return res.status(500).json({
      error: 'Error en verifyBookExternal',
      message: err.message,
      stack: err.stack
    });
  }
}
