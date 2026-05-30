// ════════════════════════════════════════════════════════════════════════
// 🌒 DETONAR — dispara el workflow triggui.yml (GitHub Actions)
// ════════════════════════════════════════════════════════════════════════
//
// Vercel Serverless Function. Recibe POST con los campos del formulario +
// llave, y dispara un workflow_dispatch en el repo triggui-app vía la
// GitHub Actions REST API.
//
// Diseño nivel dios cuántico-quark:
//   - Token GitHub NUNCA expuesto al cliente (vive en env vars de Vercel)
//   - Llave 'nh' validada del lado SERVIDOR (igual que /agregar)
//   - Booleanos se mandan como booleanos JSON (el workflow los usa como
//     boolean: `if: ${{ inputs.x }}`, `!inputs.modo_prueba`,
//     `inputs.modo_prueba != true`). Mandar "false" string sería truthy = bug.
//   - Choices/strings se mandan como strings.
//   - Solo se mandan inputs que DIFIEREN del default (respeta el límite de
//     ~10 inputs del dispatch y mantiene la llamada limpia). `modo` siempre va.
//   - workflow_dispatch responde 204 sin body: devolvemos link a la corrida.
//
// Setup (UNA vez):
//   1. Token con permiso Actions:write sobre triggui-app. Dos opciones:
//      a) REUSAR el GITHUB_TOKEN existente SI es classic con scope `repo`
//         (cubre todos tus repos, incluido triggui-app). Más simple.
//      b) RECOMENDADO (mínimo privilegio): fine-grained token, solo repo
//         triggui-app, permiso "Actions: Read and write" + "Metadata: Read".
//         Guárdalo en Vercel como GITHUB_TOKEN_ACTIONS.
//   2. Vercel → triggui.com → Settings → Environment Variables
//      → (si elegiste b) Add GITHUB_TOKEN_ACTIONS = [token]
//      → Production, Preview, Development
//   3. Redeploy.
//
// ════════════════════════════════════════════════════════════════════════

const OWNER = 'badirnakid';
const REPO = 'triggui-app';          // donde vive triggui.yml
const WORKFLOW = 'triggui.yml';
const REF = 'main';
// Llave: por defecto 'nh' (igual que /agregar, funciona de una vez). RECOMENDADO:
// define DETONAR_LLAVE en Vercel con un secreto largo → así NO vive en el repo público
// y detonar (que cuesta $ de OpenAI) queda protegido de verdad.
const LLAVE_VALIDA = process.env.DETONAR_LLAVE || 'nh';

// Defaults EXACTOS del workflow (on.workflow_dispatch.inputs).
// Un campo solo se manda si su valor != default (y no está vacío).
const DEFAULTS = {
  modo: '📘 Un libro específico',
  catalogo: 'adulto',
  batch_size: '20',
  libro_input: '',
  sentimiento: '',
  lente: '',
  nota_libro: '',
  generar_imagenes: true,
  preservar_manuales: true,
  cronobiologia: true,
  modo_prueba: false,
  punto_ciclo: 'auto',
  pilar: 'auto',
  hawkins_target: 'auto',
  lente_hawkins: true,
  lente_pilares: true,
  lente_game_theory: true,
  lente_self_knowledge: true,
};

const MODOS_VALIDOS = [
  '📘 Un libro específico',
  '💭 Triggui elige de catálogo',
  '🌍 Triggui busca el del mundo',
  '🎲 Batch para la app',
  '🧪 Batch shadow (no toca app)',
];

const BOOLEAN_KEYS = new Set([
  'generar_imagenes', 'preservar_manuales', 'cronobiologia', 'modo_prueba',
  'lente_hawkins', 'lente_pilares', 'lente_game_theory', 'lente_self_knowledge',
]);

const CHOICE_OPTIONS = {
  catalogo: ['adulto', 'kids'],
  punto_ciclo: ['auto', '0 — Cero (contemplación)', '1 — Creativo (insight)', '2 — Activo (flow)', '3 — Máximo (peak)'],
  pilar: ['auto', 'cuerpo', 'mente', 'negocio', 'familia', 'espiritu', 'relaciones', 'finanzas'],
  hawkins_target: ['auto', 'coraje (200)', 'voluntad (310)', 'aceptación (350)', 'razón (400)', 'amor (500)', 'alegría (540)', 'paz (600)'],
};

const STRING_MAXLEN = { libro_input: 200, sentimiento: 200, lente: 200, nota_libro: 500, batch_size: 6 };

function asBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v === 'true' || v === '1' || v === 'on';
  return Boolean(v);
}

function sanitizeStr(s, maxLen) {
  let clean = String(s == null ? '' : s)
    .normalize('NFC')
    .replace(/[\x00-\x1F\x7F]/g, '')   // control chars
    .replace(/\s+/g, ' ')
    .trim();
  if (maxLen && clean.length > maxLen) clean = clean.slice(0, maxLen);
  return clean;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido. Usa POST.' });
  }

  const body = req.body || {};

  // 1. Llave (server-side)
  if (String(body.llave || '') !== LLAVE_VALIDA) {
    return res.status(401).json({ error: 'Llave inválida.' });
  }

  // 2. modo (obligatorio + whitelist)
  const modo = String(body.modo || DEFAULTS.modo);
  if (!MODOS_VALIDOS.includes(modo)) {
    return res.status(400).json({ error: 'Modo inválido.' });
  }

  // 3. Validaciones por modo
  const esLibro = modo === '📘 Un libro específico';
  const esBatch = modo === '🎲 Batch para la app' || modo === '🧪 Batch shadow (no toca app)';
  const libroInput = sanitizeStr(body.libro_input, STRING_MAXLEN.libro_input);

  if (esLibro && !libroInput) {
    return res.status(400).json({ error: 'Para “📘 Un libro específico” necesitas el campo “Título | Autor”.' });
  }
  if (esLibro && !libroInput.includes('|')) {
    return res.status(400).json({ error: 'Formato del libro: Título | Autor (con la barra |).' });
  }

  // 4. Construir inputs: SOLO los que difieren del default. `modo` siempre va.
  const inputs = { modo };

  const setIfChanged = (key, value) => {
    if (value === undefined || value === null) return;
    if (BOOLEAN_KEYS.has(key)) {
      const b = asBool(value);
      if (b !== DEFAULTS[key]) inputs[key] = b;          // boolean JSON
    } else {
      const s = sanitizeStr(value, STRING_MAXLEN[key]);
      if (s !== '' && s !== DEFAULTS[key]) inputs[key] = s; // string
    }
  };

  // strings / choices
  setIfChanged('catalogo', body.catalogo);
  setIfChanged('batch_size', esBatch ? body.batch_size : undefined);
  setIfChanged('libro_input', esLibro ? libroInput : undefined);
  setIfChanged('sentimiento', body.sentimiento);
  setIfChanged('lente', body.lente);
  setIfChanged('nota_libro', body.nota_libro);
  setIfChanged('punto_ciclo', body.punto_ciclo);
  setIfChanged('pilar', body.pilar);
  setIfChanged('hawkins_target', body.hawkins_target);
  // booleanos
  setIfChanged('generar_imagenes', body.generar_imagenes);
  setIfChanged('preservar_manuales', body.preservar_manuales);
  setIfChanged('cronobiologia', body.cronobiologia);
  setIfChanged('modo_prueba', body.modo_prueba);
  setIfChanged('lente_hawkins', body.lente_hawkins);
  setIfChanged('lente_pilares', body.lente_pilares);
  setIfChanged('lente_game_theory', body.lente_game_theory);
  setIfChanged('lente_self_knowledge', body.lente_self_knowledge);

  // Validar opciones de choices (defensa extra)
  for (const [key, opts] of Object.entries(CHOICE_OPTIONS)) {
    if (inputs[key] !== undefined && !opts.includes(inputs[key])) {
      return res.status(400).json({ error: `Valor inválido para ${key}.` });
    }
  }
  // batch_size numérico razonable
  if (inputs.batch_size !== undefined) {
    const n = parseInt(inputs.batch_size, 10);
    if (!Number.isFinite(n) || n < 1 || n > 200) {
      return res.status(400).json({ error: 'Cantidad batch debe ser un número entre 1 y 200.' });
    }
    inputs.batch_size = String(n);
  }

  // Guardrail límite dispatch (~10 inputs). modo + 9 = 10.
  if (Object.keys(inputs).length > 10) {
    return res.status(400).json({
      error: 'Demasiadas opciones no-default a la vez (límite del dispatch es 10). Deja algunas en su valor por defecto.',
      enviados: Object.keys(inputs).length,
    });
  }

  // 5. Token (server-side)
  const token = process.env.GITHUB_TOKEN_ACTIONS || process.env.GITHUB_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'Falta GITHUB_TOKEN_ACTIONS (o GITHUB_TOKEN) en Vercel env vars.' });
  }

  // 6. Disparar workflow_dispatch
  try {
    const url = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${encodeURIComponent(WORKFLOW)}/dispatches`;
    const ghRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'triggui-detonar/1.0',
      },
      body: JSON.stringify({ ref: REF, inputs }),
    });

    // Éxito = 204 No Content (sin body)
    if (ghRes.status === 204) {
      return res.status(200).json({
        ok: true,
        modo,
        enviados: inputs,
        mensaje: 'Workflow disparado.',
        actions_url: `https://github.com/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}`,
      });
    }

    // Errores de GitHub
    let detail = '';
    try { detail = await ghRes.text(); } catch (_) {}
    let parsed = null;
    try { parsed = JSON.parse(detail); } catch (_) {}

    if (ghRes.status === 401 || ghRes.status === 403) {
      return res.status(502).json({
        error: 'GitHub rechazó el token (¿permiso Actions:write sobre triggui-app?).',
        detail: (parsed && parsed.message) || detail.slice(0, 300),
        status: ghRes.status,
      });
    }
    if (ghRes.status === 404) {
      return res.status(502).json({
        error: 'GitHub 404: el token no ve triggui-app, o el workflow/branch no existe.',
        detail: (parsed && parsed.message) || detail.slice(0, 300),
      });
    }
    if (ghRes.status === 422) {
      return res.status(502).json({
        error: 'GitHub 422: input inválido o el workflow no tiene workflow_dispatch en esta rama.',
        detail: (parsed && parsed.message) || detail.slice(0, 300),
        enviados: inputs,
      });
    }
    return res.status(502).json({
      error: `GitHub respondió ${ghRes.status}.`,
      detail: (parsed && parsed.message) || detail.slice(0, 300),
    });
  } catch (err) {
    return res.status(500).json({
      error: 'Error de red al hablar con GitHub.',
      detail: err && err.message ? err.message : String(err),
    });
  }
}
