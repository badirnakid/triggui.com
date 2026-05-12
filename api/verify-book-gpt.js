// ════════════════════════════════════════════════════════════════════════
// 🌒 verify-book-gpt.js v2.0 — GPT-4o-mini para identificación semántica
// ════════════════════════════════════════════════════════════════════════
// Llamado solo cuando las APIs públicas no resuelven con confianza.
// Costo típico: ~$0.0003 USD por captura = ~$0.006 MXN
//
// CAMBIOS v2:
//   - System prompt 40% más conciso (menos tokens, igual calidad)
//   - max_tokens 200 (de 250)
//   - Schema strict mantenido para garantizar JSON válido
// ════════════════════════════════════════════════════════════════════════

const GPT_TIMEOUT_MS = 8000;

const GPT_SCHEMA = {
  name: "BookIdentification",
  strict: true,
  schema: {
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
        minimum: 0,
        maximum: 1,
        description: "Confianza honesta 0-1. Usa ≥0.95 solo si estás muy seguro."
      },
      razon: {
        type: "string",
        description: "Breve explicación (≤100 chars) de tu decisión"
      }
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

export async function identifyWithGPT(titulo, autor, apiKey) {
  if (!apiKey) return { available: false, error: 'no_api_key' };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GPT_TIMEOUT_MS);

  try {
    const startTime = Date.now();
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.1,
        max_tokens: 200,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Título: "${titulo}"\nAutor: "${autor}"` }
        ],
        response_format: { type: 'json_schema', json_schema: GPT_SCHEMA }
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
    const content = data?.choices?.[0]?.message?.content || '{}';
    let parsed = {};
    try { parsed = JSON.parse(content); } catch { parsed = {}; }

    return {
      available: true,
      reconocido: Boolean(parsed.reconocido),
      titulo_canonico: String(parsed.titulo_canonico || '').trim(),
      autor_canonico: String(parsed.autor_canonico || '').trim(),
      year: typeof parsed.year === 'number' ? parsed.year : null,
      confianza: typeof parsed.confianza === 'number' ? parsed.confianza : 0,
      razon: String(parsed.razon || '').trim(),
      tokens: data?.usage?.total_tokens || 0,
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
