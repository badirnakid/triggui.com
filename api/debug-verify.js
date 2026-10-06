// ════════════════════════════════════════════════════════════════════════
// 🌒 /api/debug-verify · diagnóstico INTERNO del verify (ya no es público)
// ════════════════════════════════════════════════════════════════════════
// Usa la misma cerradura que /agregar (AGREGAR_LLAVE en Vercel).
//
// Con el aparato ya reconocido, basta abrir la dirección en el navegador:
//   triggui.com/api/debug-verify?titulo=Abitus%20Tomicus&autor=James%20Claro
//
// Sin aparato reconocido, la llave viaja en una cabecera o en el cuerpo,
// NUNCA en la dirección (lo que va en la dirección queda en historiales):
//   curl -s https://triggui.com/api/debug-verify -H "x-triggui-llave: $LLAVE" -H "Content-Type: application/json" -d '{"titulo":"Abitus Tomicus","autor":"James Claro"}'
//
// Devuelve JSON con:
//   - input recibido
//   - resultado completo de verifyBookExternal
//   - registro de cada paso
// ════════════════════════════════════════════════════════════════════════

import { verifyBookExternal } from './verify-book.js';
import { exigirAcceso } from './_llave.js';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const cabecera = req.headers ? req.headers['x-triggui-llave'] : '';
  if (!(await exigirAcceso(req, res, 'agregar', cabecera || body.llave))) return;

  const titulo = (body.titulo || req.query?.titulo || '').toString().trim();
  const autor = (body.autor || req.query?.autor || '').toString().trim();

  if (!titulo || !autor) {
    return res.status(400).json({
      error: 'Faltan parámetros',
      uso: '/api/debug-verify?titulo=...&autor=...'
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
    console.error('debug-verify:', err);
    return res.status(500).json({
      error: 'Error en verifyBookExternal',
      message: err && err.message ? err.message : String(err)
    });
  }
}
