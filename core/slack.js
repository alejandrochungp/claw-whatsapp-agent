/**
 * core/slack.js — Bridge Slack ↔ WhatsApp (supervisión + handoff humano)
 *
 * Funcionalidades:
 * - Loguear conversaciones IA como threads en Slack
 * - Notificar cuando se requiere humano
 * - Detectar respuestas del equipo y rutearlas de vuelta al cliente
 * - Comandos: "tomar" (humano toma control) / "soltar" (devuelve al bot)
 */

const axios = require('axios');

const SLACK_TOKEN   = process.env.SLACK_BOT_TOKEN;
const HANDOFF_TIMEOUT_MS = 30 * 60 * 1000; // 30 min sin actividad → bot retoma

// phone → { thread_ts, channel, timestamp }
const phoneToThread       = new Map();
// phone → { thread_ts, takenAt }
const activeConversations = new Map();

// ── Helpers ─────────────────────────────────────────────────────────────────

function slackPost(payload) {
  if (!SLACK_TOKEN) return Promise.resolve(null);
  return axios.post('https://slack.com/api/chat.postMessage', payload, {
    headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' }
  }).then(r => r.data).catch(err => {
    console.error('❌ Slack error:', err.message);
    return null;
  });
}

function resolveChannel(config) {
  // Acepta string "#canal" o ID directo
  return process.env.SLACK_CHANNEL_ID || config.slackChannel;
}

// ── Conversación normal (IA + cliente) → log en Slack ───────────────────────

async function logConversation(phone, userText, botText, config) {
  if (!SLACK_TOKEN) return;

  const channel  = resolveChannel(config);
  const existing = phoneToThread.get(phone);

  // Thread expirado (>24h): eliminar
  if (existing && Date.now() - existing.timestamp > 24 * 60 * 60 * 1000) {
    phoneToThread.delete(phone);
  }

  const formatted = `👤 *Cliente:* ${userText}\n🤖 *Bot:* ${botText}`;

  if (phoneToThread.has(phone)) {
    // Agregar al thread existente
    await slackPost({
      channel,
      thread_ts: phoneToThread.get(phone).thread_ts,
      text: formatted
    });
  } else {
    // Crear nuevo thread
    const phoneLabel = phone.startsWith('56') ? `+${phone}` : phone;
    const result = await slackPost({
      channel,
      text: `📱 *Nueva conversación* — ${phoneLabel}`,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `📱 *Nueva conversación* — ${phoneLabel}\n\nResponde en este thread para tomar control. Escribe \`tomar\` para desactivar el bot.` }
        }
      ]
    });

    if (result?.ts) {
      phoneToThread.set(phone, { thread_ts: result.ts, channel, timestamp: Date.now() });

      await slackPost({
        channel,
        thread_ts: result.ts,
        text: formatted
      });
    }
  }
}

// ── Notificar handoff (cliente pide humano) ──────────────────────────────────

async function notifyHandoff(phone, userText, config) {
  if (!SLACK_TOKEN) return;

  const channel   = resolveChannel(config);
  const phoneLabel = phone.startsWith('56') ? `+${phone}` : phone;

  const existing = phoneToThread.get(phone);

  const alertText = `🚨 *${phoneLabel} pide hablar con una persona*\n\n"${userText}"\n\nEscribe \`tomar\` en este thread para tomar el control.`;

  if (existing) {
    await slackPost({ channel, thread_ts: existing.thread_ts, text: alertText });
  } else {
    const result = await slackPost({ channel, text: alertText });
    if (result?.ts) {
      phoneToThread.set(phone, { thread_ts: result.ts, channel, timestamp: Date.now() });
    }
  }
}

// ── Reenviar mensaje a thread existente (cuando humano tiene control) ────────

async function forwardToThread(phone, userText, thread_ts, config) {
  const channel = resolveChannel(config);
  await slackPost({ channel, thread_ts, text: `💬 *Cliente:* ${userText}` });

  // Renovar timeout
  activeConversations.set(phone, {
    thread_ts,
    takenAt: activeConversations.get(phone)?.takenAt || Date.now()
  });
}

// ── Verificar si hay humano activo para este número ──────────────────────────

function getActiveConversation(phone) {
  const info = activeConversations.get(phone);
  if (!info) return null;

  // Timeout: si pasaron 30 min sin actividad, devolver al bot
  if (Date.now() - info.takenAt > HANDOFF_TIMEOUT_MS) {
    activeConversations.delete(phone);
    console.log(`🤖 Timeout handoff ${phone} → bot retoma`);
    return null;
  }

  return info.thread_ts;
}

// ── Procesar comandos desde Slack ────────────────────────────────────────────
// Se llama desde el endpoint /slack/events del server si se configura

function handleSlackCommand(command, thread_ts) {
  if (command === 'tomar') {
    // Buscar qué phone corresponde a este thread
    for (const [phone, info] of phoneToThread) {
      if (info.thread_ts === thread_ts) {
        activeConversations.set(phone, { thread_ts, takenAt: Date.now() });
        console.log(`👤 Humano tomó control de ${phone}`);
        return phone;
      }
    }
  }

  if (command === 'soltar') {
    for (const [phone, info] of activeConversations) {
      if (info.thread_ts === thread_ts) {
        activeConversations.delete(phone);
        console.log(`🤖 Bot retoma control de ${phone}`);
        return phone;
      }
    }
  }

  return null;
}

module.exports = {
  logConversation,
  notifyHandoff,
  forwardToThread,
  getActiveConversation,
  handleSlackCommand,
  phoneToThread,
  activeConversations
};
