/**
 * core/ai.js — IA con DeepSeek primario + fallback Claude
 *
 * Orden de prioridad:
 *   1. DeepSeek V4 Pro  (DEEPSEEK_API_KEY)  — ~10x más barato
 *   2. Claude Sonnet    (CLAUDE_API_KEY)     — fallback si DeepSeek falla/timeout
 *
 * Imágenes: siempre Claude Vision (DeepSeek no soporta visión).
 */

const axios = require('axios');

// ── Credenciales ─────────────────────────────────────────────────────────────
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const CLAUDE_API_KEY   = process.env.CLAUDE_API_KEY;
const CLAUDE_MODEL     = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const DEEPSEEK_MODEL   = 'deepseek-chat'; // deepseek-v4-pro en la API
const MONTHLY_BUDGET   = parseFloat(process.env.AI_MONTHLY_BUDGET || '100.0');

// ── Pricing por 1M tokens (USD) ──────────────────────────────────────────────
const PRICING = {
  'deepseek-chat':              { input: 0.27, output: 1.10 },
  'claude-sonnet-4-6':          { input: 3.00, output: 15.00 },
  'claude-3-5-sonnet-20241022': { input: 3.00, output: 15.00 },
  'claude-3-5-haiku-20241022':  { input: 0.80, output:  4.00 },
  'claude-3-haiku-20240307':    { input: 0.25, output:  1.25 },
};

// ── Contadores de uso ────────────────────────────────────────────────────────
let usage = {
  month: new Date().getMonth(),
  inputTokens: 0, outputTokens: 0, totalUSD: 0, requests: 0,
  deepseekRequests: 0, claudeRequests: 0, fallbackCount: 0
};

function checkReset() {
  const m = new Date().getMonth();
  if (m !== usage.month) {
    usage = { month: m, inputTokens: 0, outputTokens: 0, totalUSD: 0, requests: 0, deepseekRequests: 0, claudeRequests: 0, fallbackCount: 0 };
  }
}

function calcCost(model, inputTok, outputTok) {
  const p = PRICING[model] || PRICING['claude-sonnet-4-6'];
  return (inputTok / 1e6) * p.input + (outputTok / 1e6) * p.output;
}

// ── Construir array de mensajes (compartido por ambos proveedores) ────────────
function buildMessages(userMessage, history) {
  const messages = [];
  for (const h of history.slice(-16)) {
    const role = h.role === 'bot' ? 'assistant' : 'user';
    messages.push({ role, content: h.text });
  }
  const last = messages[messages.length - 1];
  if (!last || !(last.role === 'user' && last.content === userMessage)) {
    messages.push({ role: 'user', content: userMessage });
  }
  return messages;
}

// ── DeepSeek ─────────────────────────────────────────────────────────────────
async function askDeepSeek(messages, systemPrompt) {
  if (!DEEPSEEK_API_KEY) return null;

  const response = await axios.post(
    'https://api.deepseek.com/v1/chat/completions',
    {
      model: DEEPSEEK_MODEL,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages
      ]
    },
    {
      headers: {
        'Authorization': 'Bearer ' + DEEPSEEK_API_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 25000
    }
  );

  const text      = response.data.choices[0]?.message?.content || '';
  const inputTok  = response.data.usage?.prompt_tokens     || 0;
  const outputTok = response.data.usage?.completion_tokens || 0;
  const cost      = calcCost(DEEPSEEK_MODEL, inputTok, outputTok);

  return { text, inputTok, outputTok, cost, model: DEEPSEEK_MODEL };
}

// ── Claude ───────────────────────────────────────────────────────────────────
async function askClaude(messages, systemPrompt) {
  if (!CLAUDE_API_KEY) return null;

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

  const text      = response.data.content[0]?.text || '';
  const inputTok  = response.data.usage?.input_tokens  || 0;
  const outputTok = response.data.usage?.output_tokens || 0;
  const cost      = calcCost(CLAUDE_MODEL, inputTok, outputTok);

  return { text, inputTok, outputTok, cost, model: CLAUDE_MODEL };
}

// ── ask() principal ──────────────────────────────────────────────────────────
async function ask(userMessage, history, context, systemPrompt, config) {
  checkReset();

  if (!DEEPSEEK_API_KEY && !CLAUDE_API_KEY) {
    return { response: null, fallback: config?.fallbackMessage || 'Escribe "humano" para hablar con el equipo.' };
  }

  if (usage.totalUSD >= MONTHLY_BUDGET) {
    console.log('[ai] Presupuesto agotado $' + usage.totalUSD.toFixed(2) + '/' + MONTHLY_BUDGET);
    return { response: null, fallback: config?.fallbackMessage || 'Escribe "humano" para hablar con el equipo.' };
  }

  const messages = buildMessages(userMessage, history);
  let result = null;

  // 1. Intentar DeepSeek
  if (DEEPSEEK_API_KEY) {
    try {
      result = await askDeepSeek(messages, systemPrompt);
      if (result && result.text) {
        usage.deepseekRequests++;
      } else {
        result = null;
      }
    } catch (err) {
      const errMsg = (err.response && err.response.data) ? JSON.stringify(err.response.data) : err.message;
      console.log('[ai] DeepSeek fallo, usando Claude fallback. Error: ' + errMsg.slice(0, 100));
      usage.fallbackCount++;
      result = null;
    }
  }

  // 2. Fallback a Claude si DeepSeek falló
  if (!result && CLAUDE_API_KEY) {
    try {
      result = await askClaude(messages, systemPrompt);
      if (result && result.text) {
        usage.claudeRequests++;
      } else {
        result = null;
      }
    } catch (err) {
      const errMsg = (err.response && err.response.data) ? JSON.stringify(err.response.data) : err.message;
      console.error('[ai] Claude error: ' + errMsg.slice(0, 150));
      result = null;
    }
  }

  if (!result || !result.text) {
    return {
      response: null,
      fallback: config?.fallbackMessage || 'Tuve un problema tecnico. Escribe "humano" para hablar con el equipo.',
      error: 'Ambos proveedores fallaron'
    };
  }

  // Actualizar contadores
  usage.inputTokens  += result.inputTok;
  usage.outputTokens += result.outputTok;
  usage.totalUSD     += result.cost;
  usage.requests++;

  console.log('[ai] ' + result.model + ' respondio (costo: $' + result.cost.toFixed(4) + ')');

  return { response: result.text, cost: result.cost, inputTok: result.inputTok, outputTok: result.outputTok, model: result.model };
}

function getStats() {
  checkReset();
  return {
    ...usage,
    budget: MONTHLY_BUDGET,
    remaining: MONTHLY_BUDGET - usage.totalUSD
  };
}

// ── analyzeImage: siempre Claude Vision ──────────────────────────────────────
async function analyzeImage(base64, mimeType, systemPrompt, opts) {
  if (!CLAUDE_API_KEY) return null;
  opts = opts || {};
  try {
    const imageSystem = systemPrompt
      ? systemPrompt
      : (
        'Eres un asistente de atencion al cliente. ' +
        'El cliente acaba de enviarte una imagen. Analizala brevemente y responde de forma natural. ' +
        'Si es un producto, ayuda a identificarlo. Si es una consulta de piel, da un consejo breve y sugiere venir a la tienda para asesoria gratuita. ' +
        'Maximo 2-3 oraciones. Usa el mismo tono natural que usarias en cualquier otro mensaje.'
      );

    const userText  = opts.userText  || 'que ves en esta imagen?';
    const maxTokens = opts.maxTokens || (systemPrompt ? 600 : 300);

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: CLAUDE_MODEL,
        max_tokens: maxTokens,
        system: imageSystem,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
            { type: 'text', text: userText }
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
    const errMsg = (e.response && e.response.data) ? JSON.stringify(e.response.data) : e.message;
    console.error('[ai] analyzeImage error: ' + errMsg.slice(0, 150));
    return null;
  }
}

module.exports = { ask, getStats, analyzeImage };
