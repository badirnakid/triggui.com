// ════════════════════════════════════════════════════════════════════════
// 🌒 verify-book-gpt.js — Cuarto tier semántico nivel dios
// ════════════════════════════════════════════════════════════════════════
// Cuando Apple/Google/OpenLibrary NO encuentran nada relevante (typos extremos),
// llamamos a GPT-4o-mini para identificar el libro semánticamente.
//
// Solo se ejecuta cuando ya gastamos todo el approach algorítmico.
// Costo típico: ~$0.0003 USD por llamada = $0.006 MXN.
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
        description: "true si reconoces el libro pese a typos, false si no estás seguro"
      },
      titulo_canonico: {
        type: "string",
        description: "El título oficial del libro tal como lo conoces (en el idioma original o el más popular). Vacío si no reconoces."
      },
      autor_canonico: {
        type: "string",
        description: "El nombre completo del autor tal como lo conoces. Vacío si no reconoces."
      },
      year: {
        type: ["integer", "null"],
        description: "Año de publicación original (entero) o null si desconocido."
      },
      confianza: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Tu confianza honesta de 0 a 1. Usa 0.95+ solo si estás muy seguro."
      },
      razon: {
        type: "string",
        description: "Breve explicación (≤120 chars) de por qué reconoces o no el libro."
      }
    }
  }
};

const SYSTEM_PROMPT = `Eres un experto bibliotecario que identifica libros desde título y autor que pueden tener errores ortográficos, letras revueltas, traducciones, o ser muy abreviados.

Tu tarea:
1. Lee el título y autor recibidos (pueden tener typos extremos)
2. Si reconoces el libro real al que se refieren, devuelve titulo_canonico, autor_canonico, year y confianza alta (≥0.85)
3. Si NO estás seguro o no reconoces el libro, marca reconocido=false y confianza ≤0.5
4. NUNCA inventes libros. Solo confirma libros que conoces que existen.
5. Responde siempre en JSON estricto.

Ejemplos:
- Input "abitus atomics" + "janes c" → reconocido=true, titulo="Atomic Habits", autor="James Clear", year=2018, confianza=0.95
- Input "el podder de la palabar" + "Sigman" → reconocido=true, titulo="El poder de la palabra", autor="Mariano Sigman", year=2017, confianza=0.92
- Input "Influenza" + "Cialdini" → reconocido=true, titulo="Influencia", autor="Robert Cialdini", year=1984, confianza=0.95
- Input "zxqwzqx" + "fghjk" → reconocido=false, confianza=0.05, razon="no reconozco este libro"
- Input "Mi diario de viaje 1998" + "Juan Pérez Mendoza" → reconocido=false, confianza=0.2, razon="autor obscuro, libro no reconocido"`;

export async function identifyWithGPT(titulo, autor, apiKey) {
  if (!apiKey) {
    return { available: false, error: 'no_api_key' };
  }

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
        max_tokens: 250,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Identifica este libro:\n\nTítulo: "${titulo}"\nAutor: "${autor}"` }
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

    const elapsed = Date.now() - startTime;
    const tokens = data?.usage?.total_tokens || 0;

    return {
      available: true,
      reconocido: Boolean(parsed.reconocido),
      titulo_canonico: String(parsed.titulo_canonico || '').trim(),
      autor_canonico: String(parsed.autor_canonico || '').trim(),
      year: typeof parsed.year === 'number' ? parsed.year : null,
      confianza: typeof parsed.confianza === 'number' ? parsed.confianza : 0,
      razon: String(parsed.razon || '').trim(),
      tokens,
      elapsed_ms: elapsed
    };
  } catch (err) {
    clearTimeout(timeoutId);
    return {
      available: true,
      error: err.name === 'AbortError' ? 'timeout' : err.message
    };
  }
}
