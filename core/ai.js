/**
 * core/ai.js — Integración Claude (Anthropic)
 *
 * Genérico: recibe systemPrompt desde el tenant.
 * Tiene control de presupuesto mensual.
 */

const axios = require('axios');

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const CLAUDE_MODEL   = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const MONTHLY_BUDGET = parseFloat(process.env.AI_MONTHLY_BUDGET || '10.0');

// Pricing por 1M tokens
const PRICING = {
  'claude-sonnet-4-6':              { input: 3.00, output: 15.00 },
  'claude-3-5-sonnet-20241022':     { input: 3.00, output: 15.00 },
  'claude-3-5-haiku-20241022':      { input: 0.80, output:  4.00 },
  'claude-3-haiku-20240307':        { input: 0.25, output:  1.25 },
};

let usage = { month: new Date().getMonth(), inputTokens: 0, outputTokens: 0, totalUSD: 0, requests: 0 };

function checkReset() {
  const m = new Date().getMonth();
  if (m !== usage.month) usage = { month: m, inputTokens: 0, outputTokens: 0, totalUSD: 0, requests: 0 };
}

function calcCost(inputTok, outputTok) {
  const p = PRICING[CLAUDE_MODEL] || PRICING['claude-sonnet-4-6'];
  return (inputTok / 1e6) * p.input + (outputTok / 1e6) * p.output;
}

/**
 * Consultar Claude con systemPrompt del tenant
 */
async function ask(userMessage, history, context, systemPrompt, config) {
  checkReset();

  if (!CLAUDE_API_KEY) {
    return { response: null, fallback: config?.fallbackMessage || 'Escribe "humano" para hablar con el equipo.' };
  }

  if (usage.totalUSD >= MONTHLY_BUDGET) {
    console.log(`⚠️ Presupuesto IA agotado ($${usage.totalUSD.toFixed(2)}/${MONTHLY_BUDGET})`);
    return { response: null, fallback: config?.fallbackMessage || 'Escribe "humano" para hablar con el equipo.' };
  }

  // Construir mensajes
  const messages = [];

  // Historial previo
  for (const h of history.slice(-8)) {
    messages.push({
      role: h.role === 'bot' ? 'assistant' : 'user',
      content: h.text
    });
  }

  // Mensaje actual (evitar duplicar si ya está en historial)
  const last = messages[messages.length - 1];
  if (!last || last.content !== userMessage) {
    messages.push({ role: 'user', content: userMessage });
  }

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        messages
      },
      {
        headers: {
          'x-api-key': CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    const text       = response.data.content[0]?.text || '';
    const inputTok   = response.data.usage?.input_tokens  || 0;
    const outputTok  = response.data.usage?.output_tokens || 0;
    const cost       = calcCost(inputTok, outputTok);

    usage.inputTokens  += inputTok;
    usage.outputTokens += outputTok;
    usage.totalUSD     += cost;
    usage.requests++;

    return { response: text, cost, inputTok, outputTok };

  } catch (err) {
    console.error('❌ Error Claude:', err.response?.data || err.message);
    return {
      response: null,
      fallback: config?.fallbackMessage || 'Tuve un problema técnico. Escribe "humano" para hablar con el equipo.',
      error: err.message
    };
  }
}

function getStats() {
  checkReset();
  return { ...usage, budget: MONTHLY_BUDGET, remaining: MONTHLY_BUDGET - usage.totalUSD };
}

/**
 * Analizar una imagen con Claude Vision.
 * @param {string} base64  - imagen en base64
 * @param {string} mimeType
 * @param {object} config
 * @returns {string|null} descripción/respuesta de Claude
 */
async function analyzeImage(base64, mimeType, config) {
  if (!CLAUDE_API_KEY) return null;
  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: CLAUDE_MODEL,
        max_tokens: 512,
        system: 'Eres el asistente de Yeppo, tienda de cosméticos coreanos. Analiza brevemente la imagen que envió el cliente y responde de forma útil y amigable en español. Si es un producto, ayuda a identificarlo. Si es una consulta de piel, da consejos generales y recomienda venir a la tienda para asesoría personalizada gratuita.',
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
            { type: 'text', text: '¿Qué ves en esta imagen? Responde de forma útil como asistente de Yeppo.' }
          ]
        }]
      },
      {
        headers: { 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
        timeout: 30000
      }
    );
    return response.data.content[0]?.text || null;
  } catch (e) {
    console.error('[ai] analyzeImage error:', e.response?.data || e.message);
    return null;
  }
}

module.exports = { ask, getStats, analyzeImage };
