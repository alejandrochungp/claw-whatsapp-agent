/**
 * core/slack.js — Bridge Slack ↔ WhatsApp (supervisión + handoff humano)
 *
 * Estados visuales de cada conversación:
 *   🟡 En curso (bot respondiendo)
 *   🔴 Requiere atención humana → menciona el canal
 *   🟢 Resuelto por bot
 *   ✅ Resuelto por operador humano
 *
 * Comandos en thread:
 *   tomar   → humano toma control, thread pasa a 🔴
 *   soltar  → humano devuelve al bot, thread pasa a ✅
 *   listo   → bot marcó como resuelto, thread pasa a 🟢
 *   urgente → menciona @canal para llamar atención
 */

const axios = require('axios');

// Importación diferida para evitar dependencia circular
let _learning = null;
function getLearning() {
  if (!_learning) _learning = require('./learning');
  return _learning;
}

const SLACK_TOKEN        = process.env.SLACK_BOT_TOKEN;
const HANDOFF_TIMEOUT_MS = 30 * 60 * 1000; // 30 min sin actividad → bot retoma

// phone → { thread_ts, channel, timestamp, headerTs }
const phoneToThread       = new Map();
// phone → { thread_ts, takenAt }
const activeConversations = new Map();

// ── Persistir handoff en Redis para sobrevivir reinicios ──────────────────────
let _redis = null;
async function getRedis() {
  if (_redis) return _redis;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    const { createClient } = require('redis');
    _redis = createClient({ url });
    _redis.on('error', () => {});
    await _redis.connect();
    return _redis;
  } catch { return null; }
}

async function deleteThreadFromRedis(phone) {
  const r = await getRedis();
  if (!r) return;
  try { await r.del(`slack:thread:${phone}`); } catch {}
}

async function persistHandoff(phone, data) {
  const r = await getRedis();
  if (!r) return;
  try {
    if (data) {
      await r.setEx(`handoff:${phone}`, 4 * 3600, JSON.stringify(data)); // TTL 4h
    } else {
      await r.del(`handoff:${phone}`);
    }
  } catch {}
}

async function loadHandoffsFromRedis() {
  const r = await getRedis();
  if (!r) return;
  try {
    const keys = await r.keys('handoff:*');
    for (const k of keys) {
      const raw = await r.get(k);
      if (!raw) continue;
      const phone = k.replace('handoff:', '');
      const data  = JSON.parse(raw);
      activeConversations.set(phone, data);
      console.log(`[slack] Handoff restaurado desde Redis: ${phone}`);
    }
  } catch (e) {
    console.error('[slack] Error cargando handoffs:', e.message);
  }
}

// Cargar handoffs al arrancar (después de que Redis esté listo)
setTimeout(() => loadHandoffsFromRedis().catch(() => {}), 5000);
// phone → timestamp del último "tomar" (para manejar race conditions)
const recentTakes         = new Map();
// userId → displayName (cache)
const userNameCache       = new Map();
// phone → [ { role, text, ts, operatorId? } ] — log temporal para learning
const conversationLog     = new Map();

// ── Sweeper: cierra automáticamente conversaciones inactivas ──────────────────
// Corre cada 15 min.
// - Si el operador tomó control hace >30 min → guarda conv como human_resolved
// - Si el bot resolvió y no hay actividad hace >60 min → guarda como bot_resolved
const BOT_CONV_TIMEOUT_MS = 60 * 60 * 1000; // 60 min sin actividad = conv terminada

setInterval(() => {
  const now = Date.now();

  // Timeout handoffs activos (operador no soltó)
  for (const [phone, info] of activeConversations) {
    if (now - info.takenAt > HANDOFF_TIMEOUT_MS) {
      activeConversations.delete(phone);
      persistHandoff(phone, null);
      console.log(`[sweeper] Timeout handoff: ${phone}`);
      const messages = conversationLog.get(phone) || [];
      if (messages.length > 0) {
        const operatorId = messages.find(m => m.operatorId)?.operatorId || null;
        getLearning().saveConversationForReview(phone, messages, 'human_resolved', operatorId).catch(() => {});
        conversationLog.delete(phone);
      }
    }
  }

  // Timeout conversaciones del bot (sin operador activo, inactivas)
  for (const [phone, messages] of conversationLog) {
    if (activeConversations.has(phone)) continue; // operador activo, no tocar
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && (now - lastMsg.ts) > BOT_CONV_TIMEOUT_MS) {
      console.log(`[sweeper] Guardando conv bot terminada: ${phone} (${messages.length} msgs)`);
      getLearning().saveConversationForReview(phone, messages, 'bot_resolved', null).catch(() => {});
      conversationLog.delete(phone);
    }
  }
}, 15 * 60 * 1000);

// ── Redis ────────────────────────────────────────────────────────────────────
let redisClient = null;

async function initRedis() {
  const url = process.env.REDIS_URL;
  if (!url) return;
  try {
    const { createClient } = require('redis');
    redisClient = createClient({ url });
    redisClient.on('error', () => {});
    await redisClient.connect();

    const keys = await redisClient.keys('slack:thread:*');
    for (const key of keys) {
      const raw = await redisClient.get(key);
      if (raw) {
        const phone = key.replace('slack:thread:', '');
        phoneToThread.set(phone, JSON.parse(raw));
      }
    }
    console.log(`[slack] Redis conectado ✅ — ${phoneToThread.size} threads restaurados`);
  } catch (err) {
    console.error('[slack] Redis error:', err.message);
    redisClient = null;
  }
}

async function saveThread(phone, data) {
  if (!redisClient) return;
  try {
    await redisClient.setEx(`slack:thread:${phone}`, 86400, JSON.stringify(data));
  } catch {}
}

initRedis().catch(() => {});

// ── Helpers ──────────────────────────────────────────────────────────────────

function slackPost(payload) {
  if (!SLACK_TOKEN) return Promise.resolve(null);
  const body0 = Buffer.from(JSON.stringify(payload), 'utf8');
  return axios.post('https://slack.com/api/chat.postMessage', body0, {
    headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' }
  }).then(r => r.data).catch(err => {
    console.error('❌ Slack error:', err.message);
    return null;
  });
}

function slackUpdate(payload) {
  if (!SLACK_TOKEN) return Promise.resolve(null);
  const body1 = Buffer.from(JSON.stringify(payload), 'utf8');
  return axios.post('https://slack.com/api/chat.update', body1, {
    headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' }
  }).then(r => r.data).catch(() => null);
}

function resolveChannel(config) {
  return process.env.SLACK_CHANNEL_ID || config.slackChannel;
}

// Obtener nombre del operador desde su user_id de Slack
async function getUserName(userId) {
  if (!userId) return 'Operador';
  if (userNameCache.has(userId)) return userNameCache.get(userId);
  try {
    const r = await axios.get(`https://slack.com/api/users.info?user=${userId}`, {
      headers: { Authorization: `Bearer ${SLACK_TOKEN}` }
    });
    const name = r.data?.user?.profile?.display_name
              || r.data?.user?.profile?.real_name
              || r.data?.user?.name
              || 'Operador';
    const firstName = name.split(' ')[0];
    userNameCache.set(userId, firstName);
    return firstName;
  } catch (e) {
    console.error('[slack] getUserName error:', e.message);
    return 'Operador';
  }
}

// Actualizar el header del thread con el estado actual
async function updateThreadHeader(phone, status, channel, headerTs, extra = '') {
  if (!headerTs) return;
  const threadData = phoneToThread.get(phone);
  const baseText   = threadData?.headerBase || `📱 *+${phone}*`;

  let statusEmoji, statusText;
  switch (status) {
    case 'bot':      statusEmoji = '🟡'; statusText = 'En curso — bot respondiendo'; break;
    case 'human':    statusEmoji = '🔴'; statusText = `Tomado por operador${extra ? ` (${extra})` : ''}`; break;
    case 'resolved_human': statusEmoji = '✅'; statusText = `Resuelto por ${extra || 'operador'}`; break;
    case 'resolved_bot':   statusEmoji = '🟢'; statusText = 'Resuelto por bot'; break;
    case 'attention': statusEmoji = '🚨'; statusText = 'Requiere atención humana'; break;
    default:         statusEmoji = '🟡'; statusText = status;
  }

  const newText = `${statusEmoji} ${baseText}\n*Estado:* ${statusText}\n\nComandos: \`tomar\` · \`soltar\` · \`urgente\``;
  await slackUpdate({ channel, ts: headerTs, text: newText });
}

// ── Log conversación normal (bot ↔ cliente) ──────────────────────────────────

async function logConversation(phone, userText, botText, config, shopifyInfo = null) {
  if (!SLACK_TOKEN) return;

  const channel  = resolveChannel(config);
  const existing = phoneToThread.get(phone);

  // Thread expirado (>24h): eliminar
  if (existing && Date.now() - existing.timestamp > 24 * 60 * 60 * 1000) {
    phoneToThread.delete(phone);
  }

  const formatted = `👤 *Cliente:* ${userText}\n🤖 *Bot:* ${botText}`;

  // Registrar en log temporal para sistema de aprendizaje
  if (!conversationLog.has(phone)) conversationLog.set(phone, []);
  conversationLog.get(phone).push({ role: 'client', text: userText, ts: Date.now() });
  conversationLog.get(phone).push({ role: 'bot', text: botText, ts: Date.now() });

  if (phoneToThread.has(phone)) {
    const r = await slackPost({
      channel,
      thread_ts: phoneToThread.get(phone).thread_ts,
      text: formatted
    });
    // Si el thread fue eliminado en Slack, recrearlo
    if (r && !r.ok && (r.error === 'thread_not_found' || r.error === 'channel_not_found' || r.error === 'message_not_found')) {
      console.log(`[slack] Thread eliminado para ${phone} (${r.error}), recreando...`);
      phoneToThread.delete(phone);
      await deleteThreadFromRedis(phone);
      await logConversation(phone, userText, botText, config, shopifyInfo); // recursivo, ahora sin thread
    }
  } else {
    // Nuevo thread
    const phoneLabel = `+${phone}`;
    let shopifyLine  = shopifyInfo ? shopifyInfo : '';
    const headerBase = `📱 *${phoneLabel}*${shopifyLine}`;
    const headerText = `🟡 ${headerBase}\n*Estado:* En curso — bot respondiendo\n\nComandos: \`tomar\` · \`soltar\` · \`urgente\``;

    const result = await slackPost({
      channel,
      text: headerText,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: headerText } }]
    });

    if (result?.ts) {
      const threadData = {
        thread_ts: result.ts,
        headerTs: result.ts,
        headerBase,
        channel,
        timestamp: Date.now()
      };
      phoneToThread.set(phone, threadData);
      await saveThread(phone, threadData);

      await slackPost({ channel, thread_ts: result.ts, text: formatted });
    }
  }
}

// ── Notificar handoff (cliente pide humano) ───────────────────────────────────

async function notifyHandoff(phone, userText, config) {
  if (!SLACK_TOKEN) return;

  const channel    = resolveChannel(config);
  const phoneLabel = `+${phone}`;
  const existing   = phoneToThread.get(phone);

  const alertText = `🚨 *${phoneLabel} pide hablar con una persona*\n\n"${userText}"\n\n<!channel> alguien puede tomar esto? escribe \`tomar\` en este thread.`;

  if (existing) {
    await slackPost({ channel, thread_ts: existing.thread_ts, text: alertText });
    await updateThreadHeader(phone, 'attention', channel, existing.headerTs);
  } else {
    const headerBase = `📱 *${phoneLabel}*`;
    const headerText = `🚨 ${headerBase}\n*Estado:* Requiere atención humana\n\nComandos: \`tomar\` · \`soltar\` · \`urgente\``;
    const result = await slackPost({
      channel,
      text: `<!channel> ${alertText}`,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: headerText } }]
    });
    if (result?.ts) {
      const threadData = { thread_ts: result.ts, headerTs: result.ts, headerBase, channel, timestamp: Date.now() };
      phoneToThread.set(phone, threadData);
      await saveThread(phone, threadData);
      await slackPost({ channel, thread_ts: result.ts, text: alertText });
    }
  }
}

// ── Marcar conversación como resuelta por bot ────────────────────────────────

async function markResolvedByBot(phone, config) {
  if (!SLACK_TOKEN) return;
  const channel  = resolveChannel(config);
  const existing = phoneToThread.get(phone);
  if (!existing) return;
  await updateThreadHeader(phone, 'resolved_bot', channel, existing.headerTs);
  await slackPost({
    channel,
    thread_ts: existing.thread_ts,
    text: '🟢 Conversación resuelta por el bot.'
  });

  // Guardar también conversaciones exitosas del bot para aprendizaje
  const messages = conversationLog.get(phone) || [];
  if (messages.length > 0) {
    getLearning().saveConversationForReview(phone, messages, 'bot_resolved', null)
      .catch(() => {});
    conversationLog.delete(phone);
  }
}

// ── Reenviar mensaje al thread cuando humano tiene control ───────────────────

async function forwardToThread(phone, userText, thread_ts, config) {
  const channel = resolveChannel(config);
  await slackPost({ channel, thread_ts, text: `💬 *Cliente:* ${userText}` });

  activeConversations.set(phone, {
    thread_ts,
    takenAt: activeConversations.get(phone)?.takenAt || Date.now()
  });

  // Registrar mensaje del cliente en log de aprendizaje
  if (!conversationLog.has(phone)) conversationLog.set(phone, []);
  conversationLog.get(phone).push({ role: 'client', text: userText, ts: Date.now() });
}

// ── Enviar respuesta del operador al cliente con su nombre ────────────────────

async function sendOperatorReply(phone, text, userId, config) {
  const operatorName = await getUserName(userId);

  // NO hacer slackPost aquí — el mensaje del operador ya aparece en Slack
  // porque ellos lo escribieron ahí. Postear aquí crea duplicado.

  // ── FIX 2: Keepalive — extender handoff timeout cuando el operador escribe ─
  // Esto evita que el bot retome la conversación si el operador sigue activo.
  const existing = activeConversations.get(phone);
  if (existing) {
    const updated = { ...existing, takenAt: Date.now() }; // resetear timer
    activeConversations.set(phone, updated);
    await persistHandoff(phone, updated);
  }

  // Registrar en log de aprendizaje y también en memoria del bot
  // FIX MEMORIA: guardar respuestas del operador en el historial Redis
  // para que cuando el bot retome, tenga contexto de lo que dijo el humano.
  if (text) {
    if (!conversationLog.has(phone)) conversationLog.set(phone, []);
    conversationLog.get(phone).push({ role: 'human', text, ts: Date.now(), operatorId: userId });
    await getLearning().incrementOperatorMetric(userId, 'total_takeovers');

    // Guardar también en el historial principal de Redis (TTL 24h)
    // Esto permite que el bot retome con contexto completo de la conversación humana
    try {
      const memory = require('./memory');
      await memory.addMessage(phone, text, 'bot'); // rol 'bot' para que Claude lo vea como assistant
    } catch (e) {
      console.error('[slack] Error guardando respuesta operador en memoria:', e.message);
    }
  }

  // Devolver el nombre para que server.js firme el mensaje al cliente
  return operatorName;
}

// ── Verificar si hay humano activo ────────────────────────────────────────────

function getActiveConversation(phone) {
  const info = activeConversations.get(phone);
  if (!info) return null;

  // FIX 2: Usar takenAt actualizado por keepalive (sendOperatorReply lo resetea)
  // Si el operador sigue escribiendo, takenAt se actualiza → timeout no expira
  if (Date.now() - info.takenAt > HANDOFF_TIMEOUT_MS) {
    activeConversations.delete(phone);
    persistHandoff(phone, null); // borrar de Redis
    console.log(`🤖 Timeout handoff ${phone} — operador inactivo → bot retoma`);
    // Guardar conversación para aprendizaje aunque no hayan soltado
    const messages = conversationLog.get(phone) || [];
    if (messages.length > 0) {
      const operatorId = messages.find(m => m.operatorId)?.operatorId || null;
      getLearning().saveConversationForReview(phone, messages, 'human_resolved', operatorId)
        .catch(() => {});
      conversationLog.delete(phone);
    }
    return null;
  }

  return info.thread_ts;
}

// ── Comandos desde Slack ──────────────────────────────────────────────────────

function handleSlackCommand(command, thread_ts) {
  if (command === 'tomar') {
    for (const [phone, info] of phoneToThread) {
      if (info.thread_ts === thread_ts) {
        const handoffData = { thread_ts, takenAt: Date.now() };
        activeConversations.set(phone, handoffData);
        recentTakes.set(phone, Date.now());
        persistHandoff(phone, handoffData); // guardar en Redis
        return phone;
      }
    }
  }

  if (command === 'soltar') {
    for (const [phone, info] of activeConversations) {
      if (info.thread_ts === thread_ts) {
        activeConversations.delete(phone);
        persistHandoff(phone, null); // borrar de Redis
        // Guardar conversación completa para análisis de aprendizaje
        const messages = conversationLog.get(phone) || [];
        if (messages.length > 0) {
          const operatorId = messages.find(m => m.operatorId)?.operatorId || null;
          getLearning().saveConversationForReview(phone, messages, 'human_resolved', operatorId)
            .catch(e => console.error('[learning] Error guardando conv:', e.message));
          conversationLog.delete(phone); // Limpiar log temporal
        }
        return phone;
      }
    }
  }

  return null;
}

function getRecentTake(phone) {
  const ts = recentTakes.get(phone);
  if (!ts) return false;
  if (Date.now() - ts < 5000) return true;
  recentTakes.delete(phone);
  return false;
}

module.exports = {
  logConversation,
  notifyHandoff,
  forwardToThread,
  sendOperatorReply,
  markResolvedByBot,
  updateThreadHeader,
  getActiveConversation,
  getRecentTake,
  handleSlackCommand,
  saveThreadExternal: saveThread,
  deleteThreadFromRedis,
  phoneToThread,
  activeConversations
};
