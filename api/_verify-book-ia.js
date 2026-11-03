// ════════════════════════════════════════════════════════════════════════
// 🌒 _verify-book-ia.js v3.0 — Claude Haiku 5.5 para identificación semántica
// ════════════════════════════════════════════════════════════════════════
// Llamado solo cuando las APIs públicas no resuelven con confianza.
//
// CAMBIOS v3 (C278, 2 de noviembre de 2026):
//   - De gpt-4o-mini a Claude Haiku 5.5, por la Messages API, con la misma forma de
//     petición que el horno (triggui-app/ia/ia.cjs): system aparte, max_tokens siempre,
//     sin temperatura, salida estructurada en output_config.format y sin pensar antes
//     de responder (thinking desactivado, como el papel «mini»).
//   - Claude no acepta minimum ni maximum en el esquema: la confianza se valida aquí (0 a 1).
//   - Un rechazo (stop_reason refusal) o un corte (max_tokens) nunca cuentan como
//     reconocimiento: /agregar sigue con las APIs, como cuando falta la llave.
//   - La llave es ANTHROPIC_API_KEY en Vercel. Sin ella este paso no corre.
//   - El guion bajo del nombre hace que Vercel no lo publique como dirección (igual que
//     _llave.js): es un módulo de /api/agregar-libro y /api/debug-verify.
//
// Costo típico: unos 0.0001 USD por captura (Haiku 5.5: 0.10 USD por millón de tokens
// de entrada y 0.50 de salida).
// ════════════════════════════════════════════════════════════════════════

const IA_URL = 'https://api.anthropic.com/v1/messages';
const IA_VERSION = '2023-06-01';
const IA_MODELO = 'claude-haiku-5-5';
const IA_TIMEOUT_MS = 8000;
// El tope de salida no se cobra: con 200, como antes, una respuesta podía cortarse,
// porque el tokenizador de Claude cuenta distinto. Es el mínimo del horno.
const IA_MAX_TOKENS = 1024;

const IA_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reconocido", "titulo_canonico", "autor_canonico", "year", "confianza", "razon"],
  properties: {
    reconocido: {
      type: "boolean",
      description: "true si identificas el libro real pese a typos, false si no"
    },
    titulo_canonico: {
      type: "string",
      description: "Título oficial del libro (idioma original o más popular). Vacío si no reconoces."
    },
    autor_canonico: {
      type: "string",
      description: "Nombre completo del autor canónico. Vacío si no reconoces."
    },
    year: {
      type: ["integer", "null"],
      description: "Año de publicación original o null"
    },
    confianza: {
      type: "number",
      description: "Confianza honesta de 0 a 1. Usa ≥0.95 solo si estás muy seguro."
    },
    razon: {
      type: "string",
      description: "Breve explicación (≤100 chars) de tu decisión"
    }
  }
};

const SYSTEM_PROMPT = `Eres bibliotecario experto que identifica libros desde título y autor con errores ortográficos o letras revueltas.

Reglas:
1. Si reconoces el libro real → reconocido=true, devuelve título y autor canónicos con confianza ≥0.85
2. Si no estás seguro → reconocido=false con confianza ≤0.5
3. NUNCA inventes libros que no existen
4. Maneja typos extremos, traducciones ES↔EN, y autores con typo de 1 letra

Ejemplos:
- "abitus tomicus" + "janes c" → "Atomic Habits" + "James Clear" (2018), conf 0.95
- "Influenza" + "Cialdini" → "Influencia" + "Robert Cialdini" (1984), conf 0.95
- "el podder de la palabar" + "Sigman" → "El poder de la palabra" + "Mariano Sigman" (2017), conf 0.92
- "Sapines" + "Yuval Harari" → "Sapiens" + "Yuval Noah Harari" (2011), conf 0.95
- "xyz123" + "fghjk" → reconocido=false, conf 0.05, razon="no reconozco"`;

const enRango = (x) => Math.min(1, Math.max(0, x));

export async function identificaConIA(titulo, autor, apiKey) {
  if (!apiKey) return { available: false, error: 'no_api_key' };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), IA_TIMEOUT_MS);

  try {
    const startTime = Date.now();
    const res = await fetch(IA_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': IA_VERSION
      },
      body: JSON.stringify({
        model: IA_MODELO,
        max_tokens: IA_MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: `Título: "${titulo}"\nAutor: "${autor}"` }
        ],
        output_config: { format: { type: 'json_schema', schema: IA_SCHEMA } },
        thinking: { type: 'disabled' }
      }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      return {
        available: true,
        error: `http_${res.status}`,
        detail: errBody.slice(0, 200)
      };
    }

    const data = await res.json();
    if (data?.stop_reason === 'refusal' || data?.stop_reason === 'max_tokens') {
      return { available: true, error: data.stop_reason };
    }
    const content = (data?.content || [])
      .filter((b) => b && b.type === 'text')
      .map((b) => b.text || '')
      .join('') || '{}';
    let parsed = {};
    try { parsed = JSON.parse(content); } catch { parsed = {}; }
    const u = data?.usage || {};

    return {
      available: true,
      reconocido: Boolean(parsed.reconocido),
      titulo_canonico: String(parsed.titulo_canonico || '').trim(),
      autor_canonico: String(parsed.autor_canonico || '').trim(),
      year: typeof parsed.year === 'number' ? parsed.year : null,
      confianza: typeof parsed.confianza === 'number' && Number.isFinite(parsed.confianza) ? enRango(parsed.confianza) : 0,
      razon: String(parsed.razon || '').trim(),
      tokens: (u.input_tokens || 0) + (u.output_tokens || 0),
      modelo: data?.model || IA_MODELO,
      elapsed_ms: Date.now() - startTime
    };
  } catch (err) {
    clearTimeout(timeoutId);
    return {
      available: true,
      error: err.name === 'AbortError' ? 'timeout' : err.message
    };
  }
}
