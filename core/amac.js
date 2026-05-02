/**
 * core/amac.js — Agente de Mejora Continua de Atención al Cliente
 *
 * Corre semanalmente. Analiza conversaciones de Slack y produce:
 *   1. Actualizaciones al knowledge_doc.md (auto-aprobadas)
 *   2. Feature requests → GitHub Issues
 *   3. Casos mal escalados → nuevos criterios de escalación
 *   4. KPIs de agentes (tiempos de respuesta, casos ignorados)
 *
 * Principio rector: entregar valor excepcional al cliente
 * a través de excelente atención al cliente.
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

// ── Config ────────────────────────────────────────────────────────────────────
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';

function getDeepSeekKey() {
  const envKey = process.env.DEEPSEEK_API_KEY;
  if (envKey) return envKey;
  // Fallback: leer desde archivo (solo en local)
  try {
    const keyPath = path.join(__dirname, '..', '..', '..', '..', '.openclaw', 'workspace', '.secrets', 'deepseek_key.txt');
    return fs.readFileSync(keyPath, 'utf8').trim();
  } catch { return null; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function callAI(messages, maxTokens = 3000) {
  const key = getDeepSeekKey();
  if (!key) throw new Error('DEEPSEEK_API_KEY no configurado');

  const res = await axios.post(
    DEEPSEEK_BASE + '/chat/completions',
    { model: 'deepseek-v4-pro', max_tokens: maxTokens, messages },
    {
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      timeout: 120000
    }
  );
  return res.data.choices[0].message.content;
}

function cleanSlackText(text) {
  if (!text) return '';
  return text
    .replace(/<@[A-Z0-9]+>/g, '[agente]')
    .replace(/<#[A-Z0-9]+\|[^>]+>/g, '')
    .replace(/:[a-z_]+:/g, '')
    .replace(/<https?:\/\/[^|>]+\|([^>]+)>/g, '$1')
    .replace(/<https?:\/\/[^>]+>/g, '[link]')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .trim();
}

// ── Extractor de conversaciones Slack ─────────────────────────────────────────

async function fetchSlackConversations(slackToken, channelId, sinceTs) {
  const headers = { Authorization: 'Bearer ' + slackToken };
  const conversations = [];
  let cursor = null;

  // Obtener mensajes del canal desde sinceTs
  while (true) {
    const params = { channel: channelId, limit: 200, oldest: sinceTs };
    if (cursor) params.cursor = cursor;

    const r = await axios.get('https://slack.com/api/conversations.history', { params, headers, timeout: 15000 });
    if (!r.data.ok) break;

    const msgs = r.data.messages || [];
    const threads = msgs.filter(m => m.reply_count > 0);

    for (const t of threads) {
      await sleep(300);
      const tr = await axios.get('https://slack.com/api/conversations.replies', {
        params: { channel: channelId, ts: t.ts, limit: 200 },
        headers,
        timeout: 15000
      });
      if (!tr.data.ok) continue;

      const replies = tr.data.messages || [];
      const lines = [];
      let hasHumanAgent = false;
      let firstBotTs = null;
      let firstHumanTs = null;
      let threadStartTs = parseFloat(t.ts);

      for (const msg of replies) {
        const text = cleanSlackText(msg.text || '');
        if (!text || text.length < 5) continue;
        const ts = parseFloat(msg.ts);

        if (msg.bot_id || msg.username) {
          // Mensaje del bot
          if (!firstBotTs) firstBotTs = ts;
          lines.push({ role: 'bot', text, ts });
        } else if (msg.user) {
          // Agente humano
          hasHumanAgent = true;
          if (!firstHumanTs) firstHumanTs = ts;
          lines.push({ role: 'agent', text, ts });
        }
      }

      if (lines.length < 2) continue;

      // Calcular métricas de tiempo
      const firstResponseMs = firstBotTs ? (firstBotTs - threadStartTs) * 1000 : null;
      const humanResponseMs = firstHumanTs ? (firstHumanTs - threadStartTs) * 1000 : null;
      const totalDurationMs = lines.length > 0 ? (lines[lines.length - 1].ts - threadStartTs) * 1000 : null;

      conversations.push({
        threadTs: t.ts,
        date: new Date(threadStartTs * 1000).toISOString().slice(0, 10),
        hasHumanAgent,
        firstResponseMs,
        humanResponseMs,
        totalDurationMs,
        replyCount: t.reply_count,
        dialogue: lines.map(l => (l.role === 'bot' ? 'Bot' : 'Agente') + ': ' + l.text).join('\n'),
        rawLines: lines
      });
    }

    if (!r.data.has_more || !r.data.response_metadata?.next_cursor) break;
    cursor = r.data.response_metadata.next_cursor;
    await sleep(800);
  }

  return conversations;
}

// ── Análisis principal ────────────────────────────────────────────────────────

async function analyzeConversations(conversations, tenantName) {
  if (!conversations.length) return null;

  const BATCH = 30;
  const results = [];

  for (let i = 0; i < conversations.length; i += BATCH) {
    const batch = conversations.slice(i, i + BATCH);
    const text = batch.map((c, idx) => {
      const label = c.hasHumanAgent ? '[CON AGENTE HUMANO]' : '[SOLO BOT]';
      return `Conv ${i + idx + 1} ${label} (${c.date}):\n${c.dialogue}`;
    }).join('\n\n---\n\n');

    try {
      const r = await callAI([
        {
          role: 'system',
          content: 'Eres un experto en análisis de atención al cliente. Analiza conversaciones de Yeppo (tienda cosméticos coreanos, Santiago, Chile) y extrae insights accionables. Responde SOLO en JSON válido.'
        },
        {
          role: 'user',
          content: `Analiza estas ${batch.length} conversaciones del canal de atención al cliente de Yeppo.

CONVERSACIONES:
${text}

Extrae en JSON:
{
  "knowledge_gaps": [
    {
      "pregunta_cliente": "...",
      "respuesta_bot": "...(o null si no respondió)",
      "respuesta_agente": "...(si hubo agente)",
      "update_sugerido": "texto para agregar al knowledge doc (GENERICO, no específico de productos concretos)",
      "tipo": "nueva_faq|politica|tono|escalacion",
      "frecuencia_estimada": 1
    }
  ],
  "feature_requests": [
    {
      "accion_manual": "descripción de lo que hizo el agente manualmente",
      "automatizable": true/false,
      "api_disponible": "Shopify|YeppoCL|Manual",
      "frecuencia": 1,
      "impacto": "alto|medio|bajo"
    }
  ],
  "malas_escalaciones": [
    {
      "descripcion": "qué pasó",
      "debio_escalar": true/false,
      "razon": "por qué debió/no debió ir a humano",
      "nuevo_criterio": "regla a agregar"
    }
  ],
  "casos_ignorados": [
    {
      "descripcion": "conversación que quedó sin respuesta humana",
      "tiempo_sin_respuesta_min": 0
    }
  ]
}

REGLA CRITICA: En knowledge_gaps NO incluir recomendaciones de productos específicos para tipos de piel. Solo patrones genéricos de atención, políticas, procesos.`
        }
      ], 4000);

      const jsonMatch = r.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        results.push(JSON.parse(jsonMatch[0]));
      }
    } catch (e) {
      console.error('[amac] Error batch ' + Math.floor(i/BATCH + 1) + ':', e.message);
    }

    await sleep(1500);
  }

  // Consolidar resultados
  const consolidated = {
    knowledge_gaps:    [],
    feature_requests:  [],
    malas_escalaciones:[],
    casos_ignorados:   []
  };

  for (const r of results) {
    if (r.knowledge_gaps)     consolidated.knowledge_gaps.push(...r.knowledge_gaps);
    if (r.feature_requests)   consolidated.feature_requests.push(...r.feature_requests);
    if (r.malas_escalaciones) consolidated.malas_escalaciones.push(...r.malas_escalaciones);
    if (r.casos_ignorados)    consolidated.casos_ignorados.push(...r.casos_ignorados);
  }

  // Agrupar feature requests por tipo de acción
  const frMap = {};
  for (const fr of consolidated.feature_requests) {
    const key = fr.accion_manual.toLowerCase().slice(0, 40);
    if (!frMap[key]) {
      frMap[key] = { ...fr };
    } else {
      frMap[key].frecuencia += fr.frecuencia || 1;
    }
  }
  consolidated.feature_requests = Object.values(frMap)
    .filter(fr => fr.automatizable)
    .sort((a, b) => b.frecuencia - a.frecuencia);

  // Deduplicar knowledge_gaps
  const kgSeen = new Set();
  consolidated.knowledge_gaps = consolidated.knowledge_gaps.filter(kg => {
    const key = kg.pregunta_cliente.toLowerCase().slice(0, 50);
    if (kgSeen.has(key)) return false;
    kgSeen.add(key);
    return true;
  });

  return consolidated;
}

// ── KPIs de agentes ───────────────────────────────────────────────────────────

function computeAgentKPIs(conversations) {
  const withHuman = conversations.filter(c => c.hasHumanAgent);
  const withoutResponse = conversations.filter(c =>
    !c.hasHumanAgent && c.replyCount <= 1 && c.totalDurationMs < 5 * 60 * 1000
  );

  // Tiempo promedio de primera respuesta humana (min)
  const humanTimes = withHuman
    .filter(c => c.humanResponseMs)
    .map(c => c.humanResponseMs / 60000);

  const avgHumanResponseMin = humanTimes.length
    ? Math.round(humanTimes.reduce((a, b) => a + b, 0) / humanTimes.length)
    : null;

  // Conversaciones potencialmente ignoradas: >2h sin respuesta humana
  const ignored = conversations.filter(c => {
    if (c.hasHumanAgent) return false;
    if (!c.humanResponseMs && c.totalDurationMs && c.totalDurationMs > 2 * 3600 * 1000) return true;
    return false;
  });

  return {
    total:              conversations.length,
    withHumanAgent:     withHuman.length,
    botOnly:            conversations.length - withHuman.length,
    botResolutionRate:  Math.round(((conversations.length - withHuman.length) / conversations.length) * 100),
    avgHumanResponseMin,
    potentiallyIgnored: ignored.length,
    ignoredSamples:     ignored.slice(0, 3).map(c => ({ date: c.date, threadTs: c.threadTs }))
  };
}

// ── Exportar ──────────────────────────────────────────────────────────────────

module.exports = {
  analyzeConversations,
  fetchSlackConversations,
  computeAgentKPIs
};
