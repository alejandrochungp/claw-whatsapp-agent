/**
 * core/ai.js — IA con Claude primario + DeepSeek fallback
 *
 * Orden de prioridad:
 *   1. Claude Sonnet   (CLAUDE_API_KEY)     — primario: sigue instrucciones, no alucina
 *   2. DeepSeek V4 Pro (DEEPSEEK_API_KEY)   — fallback si Claude falla/timeout
 *
 * Claude usa prompt caching (cache_control ephemeral) en el system prompt.
 * Cache hit = ~90% descuento en input tokens del system prompt.
 *
 * Imágenes: siempre Claude Vision (DeepSeek no soporta visión).
 */

const axios = require('axios');

// ── Credenciales ─────────────────────────────────────────────────────────────
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const CLAUDE_API_KEY   = process.env.CLAUDE_API_KEY;
const CLAUDE_MODEL     = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const DEEPSEEK_MODEL   = 'deepseek-chat';
const MONTHLY_BUDGET   = parseFloat(process.env.AI_MONTHLY_BUDGET || '100.0');

// ── Pricing por 1M tokens (USD) ──────────────────────────────────────────────
// Claude cache: escritura 125% input, lectura 10% input
const PRICING = {
  'deepseek-chat':              { input: 0.27, output: 1.10 },
  'claude-sonnet-4-6':          { input: 3.00, output: 15.00, cacheWrite: 3.75, cacheRead: 0.30 },
  'claude-3-5-sonnet-20241022': { input: 3.00, output: 15.00, cacheWrite: 3.75, cacheRead: 0.30 },
  'claude-3-5-haiku-20241022':  { input: 0.80, output:  4.00, cacheWrite: 1.00, cacheRead: 0.08 },
  'claude-3-haiku-20240307':    { input: 0.25, output:  1.25, cacheWrite: 0.31, cacheRead: 0.03 },
};

// ── Contadores de uso ────────────────────────────────────────────────────────
let usage = {
  month: new Date().getMonth(),
  inputTokens: 0, outputTokens: 0, totalUSD: 0, requests: 0,
  claudeRequests: 0, deepseekRequests: 0, fallbackCount: 0,
  cacheHits: 0, cacheMisses: 0
};

function checkReset() {
  const m = new Date().getMonth();
  if (m !== usage.month) {
    usage = { month: m, inputTokens: 0, outputTokens: 0, totalUSD: 0, requests: 0,
      claudeRequests: 0, deepseekRequests: 0, fallbackCount: 0, cacheHits: 0, cacheMisses: 0 };
  }
}

function calcCost(model, inputTok, outputTok, cacheHit) {
  const p = PRICING[model] || PRICING['claude-sonnet-4-6'];
  // Con cache hit, el system prompt se cobra al 10%. Sin cache, al 100%.
  // Simplificamos: inputTok ya viene corregido por askClaude
  return (inputTok / 1e6) * p.input + (outputTok / 1e6) * p.output;
}

// ── Construir array de mensajes ──────────────────────────────────────────────
function buildMessages(userMessage, history, windowSize = 16) {
  const messages = [];
  for (const h of history.slice(-Math.max(1, windowSize))) {
    const role = h.role === 'bot' ? 'assistant' : 'user';
    messages.push({ role, content: h.text });
  }
  const last = messages[messages.length - 1];
  if (!last || !(last.role === 'user' && last.content === userMessage)) {
    messages.push({ role: 'user', content: userMessage });
  }
  return messages;
}

// ── DeepSeek (fallback) ─────────────────────────────────────────────────────
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

// ── Claude (primario, con prompt caching) ────────────────────────────────────
async function askClaude(messages, systemPrompt) {
  if (!CLAUDE_API_KEY) return null;

  // Prompt caching: marcar el system prompt completo como cacheable
  // TTL 5 min. Cache hit = ~90% descuento en tokens del system prompt.
  const system = typeof systemPrompt === 'string'
    ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
    : systemPrompt; // array con bloques {text, cache?}

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system,
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
  const usageData = response.data.usage || {};
  const inputTok  = usageData.input_tokens  || 0;
  const outputTok = usageData.output_tokens || 0;
  // Anthropic reporta cache_read_input_tokens y cache_creation_input_tokens
  const cacheRead  = usageData.cache_read_input_tokens  || 0;
  const cacheWrite = usageData.cache_creation_input_tokens || 0;

  // Calcular costo con caché
  const p = PRICING[CLAUDE_MODEL] || PRICING['claude-sonnet-4-6'];
  const regularInput = inputTok - cacheRead - cacheWrite;
  const cost =
    (regularInput / 1e6) * p.input +
    (cacheRead  / 1e6) * (p.cacheRead  || p.input * 0.10) +
    (cacheWrite / 1e6) * (p.cacheWrite || p.input * 1.25) +
    (outputTok  / 1e6) * p.output;

  const cacheHit = cacheRead > 0;

  return { text, inputTok, outputTok, cost, model: CLAUDE_MODEL, cacheHit, cacheRead, cacheWrite, regularInput };
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

  const windowSize = config?.aiHistoryWindow || 16;
  const messages = buildMessages(userMessage, history, windowSize);
  let result = null;

  // 1. Primario: Claude con prompt caching
  if (CLAUDE_API_KEY) {
    try {
      result = await askClaude(messages, systemPrompt);
      if (result && result.text) {
        usage.claudeRequests++;
        if (result.cacheHit) usage.cacheHits++;
        else usage.cacheMisses++;
      } else {
        result = null;
      }
    } catch (err) {
      const errMsg = (err.response && err.response.data) ? JSON.stringify(err.response.data) : err.message;
      console.log('[ai] Claude fallo, usando DeepSeek fallback. Error: ' + errMsg.slice(0, 100));
      usage.fallbackCount++;
      result = null;
    }
  }

  // 2. Fallback a DeepSeek
  if (!result && DEEPSEEK_API_KEY) {
    try {
      result = await askDeepSeek(messages, systemPrompt);
      if (result && result.text) {
        usage.deepseekRequests++;
      } else {
        result = null;
      }
    } catch (err) {
      const errMsg = (err.response && err.response.data) ? JSON.stringify(err.response.data) : err.message;
      console.error('[ai] DeepSeek fallback error: ' + errMsg.slice(0, 150));
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

  const cacheInfo = result.cacheHit
    ? ` [cache ✓ ${result.cacheRead} tok]`
    : (result.model === CLAUDE_MODEL ? ' [cache miss]' : '');
  console.log('[ai] ' + result.model + ' respondio (costo: $' + result.cost.toFixed(4) + ')' + cacheInfo);

  return {
    response: result.text,
    cost: result.cost,
    inputTok: result.inputTok,
    outputTok: result.outputTok,
    model: result.model
  };
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
