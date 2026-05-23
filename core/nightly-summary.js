/**
 * core/nightly-summary.js — Resumen nocturno de conversaciones
 *
 * Cada noche (configurable por tenant, default 22:00 Santiago), resume las
 * conversaciones del dia para cada cliente activo y las guarda en context.summary
 * para que el bot recuerde el contexto historico sin recargar todo el historial.
 *
 * Multi-tenant: cada tenant tiene su propia config de Redis + AI.
 * Los resúmenes se guardan con timestamp para crear una linea de tiempo.
 */

const axios = require('axios');

let redisClient = null;
async function getRedis() {
  if (redisClient) return redisClient;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    const { createClient } = require('redis');
    redisClient = createClient({ url });
    redisClient.on('error', () => {});
    await redisClient.connect();
    return redisClient;
  } catch { return null; }
}

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const CLAUDE_API_KEY   = process.env.CLAUDE_API_KEY;

// Minimo de mensajes para generar summary (evita conversaciones triviales)
const MIN_MSG_FOR_SUMMARY = 5;

// Limite de conversaciones a resumir por noche (para control de costos)
const MAX_CONVS_PER_NIGHT = 50;

// ── Helper: obtener tenant desde el path de config en index.js ──────────────
let currentTenantConfig = null;
function setTenantConfig(config) {
  currentTenantConfig = config;
}

// ── Helper: obtener fecha de hoy en Santiago ───────────────────────────────
function todaySantiago() {
  const now = new Date();
  const santiago = new Date(now.toLocaleString('en-US', { timeZone: 'America/Santiago' }));
  return santiago.toISOString().split('T')[0]; // YYYY-MM-DD
}

// ── Helper: limpiar texto de formato Slack/markdown ────────────────────────
function cleanText(text) {
  if (!text) return '';
  return text
    .replace(/:[\w_]+:/g, '')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/`[^`]+`/g, '')
    .replace(/\[template enviado\].*/g, '[template]')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Core: resumir una conversacion ────────────────────────────────────────

/**
 * Genera un resumen de 2-3 lineas de una conversacion.
 * Usa DeepSeek (barato) con fallback a Claude.
 */
async function summarizeConversation(messages, clientLabel) {
  const text = messages.map(m => {
    const who = m.role === 'user' || m.role === 'client' ? 'Cliente'
              : m.role === 'bot' ? 'Bot'
              : m.role === 'human' ? 'Operador'
              : m.role;
    return `${who}: ${cleanText(m.text)}`;
  }).filter(line => line.split(': ')[1]?.length > 2).join('\n');

  if (!text || text.length < 30) return null;

  const prompt = `Resume esta conversacion de atencion al cliente en MAXIMO 3 lineas.
Solo incluye informacion que el bot DEBA recordar para futuras interacciones:
- Que productos recomendo el bot
- Que necesita o prefiere el cliente
- Tipo de piel, preocupaciones, datos personales mencionados
- Decisiones o acuerdos (ej: "quedo en comprar online")
- Problemas o quejas mencionadas

NO incluyas saludos, despedidas ni informacion trivial.

Conversacion (${clientLabel}):
${text}

Responde SOLO con el resumen, sin introducciones ni etiquetas.`;

  // Intentar DeepSeek primero (barato)
  if (DEEPSEEK_API_KEY) {
    try {
      const res = await axios.post('https://api.deepseek.com/v1/chat/completions', {
        model: 'deepseek-chat',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }]
      }, {
        headers: { Authorization: `Bearer ${DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 30000
      });
      const summary = res.data.choices?.[0]?.message?.content?.trim();
      if (summary) return summary;
    } catch (e) {
      console.log('[nightly-summary] DeepSeek fallo, usando Claude: ' + e.message.slice(0, 80));
    }
  }

  // Fallback a Claude
  if (CLAUDE_API_KEY) {
    try {
      const res = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-sonnet-4-6',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }]
      }, {
        headers: { 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
        timeout: 30000
      });
      return res.data.content?.[0]?.text?.trim() || null;
    } catch (e) {
      console.log('[nightly-summary] Claude fallo: ' + e.message.slice(0, 80));
    }
  }

  return null;
}

// ── Core: procesar todas las conversaciones del dia ───────────────────────

async function runNightlySummary(config) {
  const redis = await getRedis();
  if (!redis) {
    console.log('[nightly-summary] Redis no disponible');
    return { summarized: 0, errors: 0 };
  }

  const tenant = config?.name || process.env.TENANT || 'default';
  const today = todaySantiago();
  console.log(`[nightly-summary] Iniciando para ${tenant} - ${today}`);

  try {
    // 1. Buscar todas las keys de historial activas hoy
    const historyKeys = await redis.keys('history:*');
    if (!historyKeys.length) {
      console.log('[nightly-summary] No hay historiales activos');
      return { summarized: 0, errors: 0 };
    }

    // 2. Para cada key, obtener mensajes de hoy y resumir si cumple minimo
    let summarized = 0;
    let errors = 0;
    let processed = 0;

    for (const key of historyKeys) {
      if (processed >= MAX_CONVS_PER_NIGHT) {
        console.log(`[nightly-summary] Limite de ${MAX_CONVS_PER_NIGHT} conversaciones alcanzado`);
        break;
      }

      try {
        // Obtener contexto actual para ver si ya tiene summary de hoy
        const phone = key.replace('history:', '');
        const ctxKey = `context:${phone}`;
        const ctxRaw = await redis.get(ctxKey);
        const ctx = ctxRaw ? JSON.parse(ctxRaw) : {};

        // Si ya tiene summary de hoy, saltar
        if (ctx.summary && ctx.summary.includes(`[${today}]`)) continue;

        // Obtener mensajes de las ultimas 24h
        const allMsgs = await redis.lRange(key, 0, -1);
        const recentMsgs = [];
        const todayStart = new Date(today + 'T00:00:00-04:00').getTime();

        for (const raw of allMsgs) {
          try {
            const msg = JSON.parse(raw);
            if (msg.ts && msg.ts > todayStart) {
              recentMsgs.push(msg);
            }
          } catch {}
        }

        // Saltar si no hay suficientes mensajes hoy
        if (recentMsgs.length < MIN_MSG_FOR_SUMMARY) continue;

        processed++;

        // Generar summary
        const summary = await summarizeConversation(recentMsgs, phone);
        if (summary) {
          // Agregar al contexto existente
          const existingSummary = ctx.summary || '';
          const newEntry = `[${today}] ${summary}\n`;
          ctx.summary = existingSummary + newEntry;

          await redis.set(ctxKey, JSON.stringify(ctx));
          // Sin TTL — memoria infinita

          summarized++;
          console.log(`[nightly-summary] Resumido ${phone}: "${summary.slice(0, 80)}..."`);
        }

        // Pequeña pausa entre llamadas API
        await new Promise(r => setTimeout(r, 500));

      } catch (e) {
        errors++;
        console.error(`[nightly-summary] Error con key ${key}: ${e.message}`);
      }
    }

    console.log(`[nightly-summary] Completo: ${summarized} resumenes, ${errors} errores, ${processed} procesados`);
    return { summarized, errors, processed };

  } catch (e) {
    console.error('[nightly-summary] Error general:', e.message);
    return { summarized: 0, errors: 1 };
  }
}

// ── Scheduler ──────────────────────────────────────────────────────────────

/**
 * Programa el resumen nocturno.
 * @param {object} config — tenant config
 */
function schedule(config) {
  const timeStr = config?.nightlySummaryTime || '22:00';
  const [hour, minute] = timeStr.split(':').map(Number);

  // Calcular proxima ejecucion en zona Santiago
  function getNextRunMs() {
    const now = new Date();
    const santiago = new Date(now.toLocaleString('en-US', { timeZone: 'America/Santiago' }));
    const target = new Date(santiago);
    target.setHours(hour, minute, 0, 0);

    if (target <= santiago) {
      target.setDate(target.getDate() + 1);
    }

    return target.getTime() - now.getTime();
  }

  let initialDelay = getNextRunMs();
  console.log(`[nightly-summary] Programado para ${timeStr} Santiago (en ${Math.round(initialDelay / 60000)} min)`);

  // Primera ejecucion
  setTimeout(async () => {
    await runNightlySummary(config);

    // Luego cada 24h
    setInterval(async () => {
      await runNightlySummary(config);
    }, 24 * 3600 * 1000);

  }, initialDelay);
}

// ── Ejecutar inmediatamente (para pruebas) ────────────────────────────────

async function runNow(config) {
  return await runNightlySummary(config);
}

module.exports = { schedule, runNow };
