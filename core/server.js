/**
 * core/server.js — Webhook Express genérico
 *
 * Recibe mensajes de Meta Cloud API y los enruta al tenant correspondiente.
 * No contiene lógica de negocio: todo lo específico viene de tenantBusiness.
 */

const express    = require('express');
const bodyParser = require('body-parser');
const memory     = require('./memory');
const slack      = require('./slack');
const ai         = require('./ai');
const meta       = require('./meta');
const logger     = require('./logger');
const shopify    = require('./shopify');
const audio      = require('./audio');
const upsell     = require('./upsell');

function start(config, business) {
  const app  = express();
  const PORT = process.env.PORT || config.port || 3000;

  app.use(bodyParser.json());

  // ── GET /webhook — verificación Meta ─────────────────────────────────────
  app.get('/webhook', (req, res) => {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    if (mode === 'subscribe' && token === config.verifyToken) {
      logger.log('✅ Webhook verificado por Meta');
      return res.status(200).send(challenge);
    }
    logger.log(`❌ Verificación fallida (token: ${token})`);
    res.sendStatus(403);
  });

  // ── POST /webhook — mensajes entrantes ───────────────────────────────────
  app.post('/webhook', async (req, res) => {
    try {
      res.sendStatus(200); // Responder rápido a Meta

      const value = req.body?.entry?.[0]?.changes?.[0]?.value;
      if (!value) return;

      // Status updates (sent / delivered / read)
      if (value.statuses?.length) {
        for (const s of value.statuses) await handleStatus(s, config);
        return;
      }

      // Mensajes entrantes
      if (value.messages?.length) {
        for (const msg of value.messages) await handleMessage(msg, value, config, business);
      }
    } catch (err) {
      logger.log(`❌ Error en webhook: ${err.message}`);
    }
  });

  // ── GET /status — health check ───────────────────────────────────────────
  app.get('/status', (req, res) => {
    res.json({
      ok: true,
      tenant: process.env.TENANT,
      phone: config.businessPhone,
      uptime: process.uptime()
    });
  });

  // ── POST /shopify/order — webhook Shopify order_paid ────────────────────────
  app.post('/shopify/order', async (req, res) => {
    res.sendStatus(200); // Responder rápido a Shopify
    try {
      const order = req.body;
      if (!order?.id) return;
      logger.log(`[shopify] Nuevo pedido: #${order.name} — ${order.financial_status}`);
      if (order.financial_status === 'paid') {
        await upsell.handleNewOrder(order, config);
      }
    } catch (err) {
      logger.log(`[shopify] Error webhook: ${err.message}`);
    }
  });

  // ── POST /admin/debug-context — ver contexto Redis de un número ──────────
  app.post('/admin/debug-context', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone requerido' });
    const ctx  = await memory.getContext(phone);
    const hist = await memory.getHistory(phone, 5);
    res.json({ context: ctx, recentHistory: hist });
  });

  // ── POST /admin/reset-context — limpiar contexto de un número (solo pruebas) ──
  app.post('/admin/reset-context', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone requerido' });
    await memory.updateContext(phone, {
      shopifyChecked: false, shopifyContext: null, shopifySlackInfo: null, customerName: null,
      upsellPendiente: false, upsellOrderId: null, upsellOrderName: null, upsellMatch: null
    });
    logger.log(`[admin] Contexto reseteado para ${phone}`);
    res.json({ ok: true, phone });
  });

  // ── POST /admin/campaign-context — registrar contexto de campaña en Redis ──
  app.post('/admin/campaign-context', async (req, res) => {
    const { phone, campaign } = req.body;
    if (!phone || !campaign) return res.status(400).json({ error: 'phone y campaign requeridos' });
    await memory.setCampaignContext(phone, campaign);
    logger.log(`[campaign] Contexto guardado: ${phone} → "${campaign.name}"`);
    res.json({ ok: true, phone });
  });

  // ── POST /admin/seed-thread — inyectar thread→phone en Redis (one-time migration) ──
  app.post('/admin/seed-thread', async (req, res) => {
    const { phone, thread_ts, channel } = req.body;
    if (!phone || !thread_ts) return res.status(400).json({ error: 'phone y thread_ts requeridos' });
    const data = { thread_ts, channel: channel || 'C05FES87S9J', timestamp: Date.now() };
    slack.phoneToThread.set(phone, data);
    await slack.saveThreadExternal(phone, data);
    logger.log(`[seed] thread mapeado: ${phone} → ${thread_ts}`);
    res.json({ ok: true, phone, thread_ts });
  });

  // ── POST /slack/events — recibir mensajes y comandos desde Slack ─────────
  app.post('/slack/events', async (req, res) => {
    const body = req.body;

    // Verificación de URL (Slack envía challenge al configurar)
    if (body.type === 'url_verification') {
      return res.json({ challenge: body.challenge });
    }

    res.sendStatus(200); // Responder rápido a Slack

    const event = body.event;
    if (!event) return;

    // Debug: loguear todos los eventos Slack entrantes
    logger.log(`[slack-event] type=${event.type} subtype=${event.subtype || '-'} bot_id=${event.bot_id || '-'} thread=${event.thread_ts || '-'} text="${(event.text || '').slice(0, 50)}"`);

    // Solo procesar mensajes de texto en canales (no del propio bot)
    if (event.type !== 'message' || event.bot_id || event.subtype) return;

    const text       = (event.text || '').trim().toLowerCase();
    const thread_ts  = event.thread_ts;
    const channel    = event.channel;

    if (!thread_ts) {
      logger.log(`[slack-event] ignorado - sin thread_ts`);
      return;
    }

    const userId = event.user; // ID del operador que escribe

    // ── Comando: tomar ────────────────────────────────────────────────────
    if (text === 'tomar') {
      const phone = slack.handleSlackCommand('tomar', thread_ts);
      if (phone) {
        const operatorName = await slack.sendOperatorReply(phone, null, userId, config);
        logger.log(`👤 ${operatorName} tomó control de ${phone}`);
        // Actualizar header del thread
        const threadData = slack.phoneToThread.get(phone);
        if (threadData?.headerTs) {
          await slack.updateThreadHeader(phone, 'human', channel, threadData.headerTs, operatorName);
        }
        await postSlackMessage(channel, thread_ts, `👤 *${operatorName}* tomó el control. Bot pausado. Escribe \`soltar\` cuando termines.`);
      }
      return;
    }

    // ── Comando: soltar ───────────────────────────────────────────────────
    if (text === 'soltar') {
      const phone = slack.handleSlackCommand('soltar', thread_ts);
      if (phone) {
        const operatorName = await slack.sendOperatorReply(phone, null, userId, config);
        const threadData   = slack.phoneToThread.get(phone);
        if (threadData?.headerTs) {
          await slack.updateThreadHeader(phone, 'resolved_human', channel, threadData.headerTs, operatorName);
        }
        logger.log(`✅ ${operatorName} soltó ${phone} — marcado como resuelto`);
        await postSlackMessage(channel, thread_ts, `✅ Resuelto por *${operatorName}*. Bot reactivado.`);
      }
      return;
    }

    // ── Comando: urgente ──────────────────────────────────────────────────
    if (text === 'urgente' || text === '!') {
      for (const [phone, info] of slack.phoneToThread) {
        if (info.thread_ts === thread_ts) {
          await postSlackMessage(channel, thread_ts, `🚨 <!channel> se requiere atención urgente en esta conversación (+${phone})`);
          if (info.headerTs) {
            await slack.updateThreadHeader(phone, 'attention', channel, info.headerTs);
          }
          break;
        }
      }
      return;
    }

    // ── Respuesta humana en thread → enviar al cliente con firma ──────────
    for (const [phone, info] of slack.phoneToThread) {
      if (info.thread_ts === thread_ts) {
        const activeThread = slack.getActiveConversation(phone);
        const recentTake   = slack.getRecentTake(phone);

        if (activeThread || recentTake) {
          // Obtener nombre del operador y firmar el mensaje
          const operatorName = await slack.sendOperatorReply(phone, event.text, userId, config);
          const msgToClient  = `${event.text}\n\n— ${operatorName}`;
          await meta.sendMessage(phone, msgToClient, config);
          logger.log(`📤 ${operatorName} respondió a ${phone}: ${event.text}`);
        }
        break;
      }
    }
  });

  app.listen(PORT, '0.0.0.0', () => {
    logger.log(`✅ Servidor escuchando en 0.0.0.0:${PORT}`);
  });
}

// ── Status updates ──────────────────────────────────────────────────────────
const messageTracker = new Map();

async function handleStatus(status, config) {
  const { id: msgId, status: type, errors } = status;

  // Loguear errores de entrega
  if (type === 'failed') {
    logger.log(`❌ Mensaje fallido [${msgId}]: ${JSON.stringify(errors)}`);
    return;
  }

  if (type !== 'read') return;

  const info = messageTracker.get(msgId);
  if (!info) return;

  const { channel, ts } = info;
  const token = process.env.SLACK_BOT_TOKEN;
  const axios = require('axios');

  // Quitar ⬜ y poner ✅
  await axios.post('https://slack.com/api/reactions.remove',
    { channel, timestamp: ts, name: 'white_check_mark' },
    { headers: { Authorization: `Bearer ${token}` } }
  ).catch(() => {});

  await axios.post('https://slack.com/api/reactions.add',
    { channel, timestamp: ts, name: 'heavy_check_mark' },
    { headers: { Authorization: `Bearer ${token}` } }
  ).catch(() => {});

  messageTracker.delete(msgId);
}

// ── Deduplicación de mensajes ────────────────────────────────────────────────
const processedMessages = new Map(); // messageId → timestamp
const DEDUP_TTL = 60 * 1000; // 60 segundos

function isDuplicate(messageId) {
  if (processedMessages.has(messageId)) return true;
  processedMessages.set(messageId, Date.now());
  // Limpiar entradas viejas
  const cutoff = Date.now() - DEDUP_TTL;
  for (const [id, ts] of processedMessages) {
    if (ts < cutoff) processedMessages.delete(id);
  }
  return false;
}

// ── Debounce por usuario — espera 3s por si el cliente envía más mensajes ────
const pendingReplies = new Map(); // phone → { timer, texts[] }
const DEBOUNCE_MS = 3000;

function debounceMessage(phone, text, handler) {
  if (pendingReplies.has(phone)) {
    const pending = pendingReplies.get(phone);
    clearTimeout(pending.timer);
    pending.texts.push(text);
  } else {
    pendingReplies.set(phone, { texts: [text], timer: null });
  }
  const pending = pendingReplies.get(phone);
  pending.timer = setTimeout(async () => {
    pendingReplies.delete(phone);
    const combined = pending.texts.join(' ... ');
    await handler(combined);
  }, DEBOUNCE_MS);
}

// ── Mensaje entrante ────────────────────────────────────────────────────────
async function handleMessage(message, value, config, business) {
  const from = message.from;
  const type = message.type;

  // Deduplicar — Meta puede reenviar el mismo webhook varias veces
  if (message.id && isDuplicate(message.id)) {
    logger.log(`⚠️ Mensaje duplicado ignorado: ${message.id}`);
    return;
  }

  let userText = '';
  let isAudio  = false;

  if (type === 'text') {
    userText = message.text.body;
  } else if (type === 'interactive') {
    userText = message.interactive.button_reply?.title ||
               message.interactive.list_reply?.title  || '';
  } else if (type === 'audio') {
    const mediaId = message.audio?.id;
    if (mediaId) {
      logger.log(`🎤 Audio recibido de [${from}] — transcribiendo...`);
      const transcription = await audio.transcribeWhatsAppAudio(mediaId, config);
      if (transcription) {
        userText = transcription;
        isAudio  = true;
        logger.log(`🎤 Transcripción: "${transcription.slice(0, 80)}"`);
      } else {
        logger.log(`⚠️ No se pudo transcribir audio de ${from}`);
        return;
      }
    }
  } else {
    logger.log(`⚠️ Tipo no soportado: ${type}`);
    return;
  }

  logger.log(`📨 [${from}] ${isAudio ? '🎤 ' : ''}${userText}`);

  // Si envió audio, marcar en contexto para que Claude lo sepa
  if (isAudio) {
    await memory.updateContext(from, { canSendAudio: true });
  }

  await memory.addMessage(from, userText, 'user');

  // Enriquecer con datos de Shopify (primera vez o si no hay contexto guardado)
  let shopifyData = null;
  const savedContext = await memory.getContext(from);
  if (!savedContext?.shopifyChecked) {
    shopifyData = await shopify.enrichContact(from);
    if (shopifyData) {
      logger.log(`🛍️ Cliente Shopify identificado: ${shopifyData.customer.first_name} ${shopifyData.customer.last_name || ''}`);
      await memory.updateContext(from, {
        shopifyChecked: true,
        shopifyContext: shopifyData.claudeContext,
        shopifySlackInfo: shopifyData.slackInfo,
        customerName: [shopifyData.customer.first_name, shopifyData.customer.last_name].filter(Boolean).join(' ')
      });
    } else {
      await memory.updateContext(from, { shopifyChecked: true });
    }
  }

  // ¿Hay agente humano activo para este número?
  const activeThread = slack.getActiveConversation(from);
  if (activeThread) {
    await slack.forwardToThread(from, userText, activeThread, config);
    return;
  }

  // Debounce: esperar 3s por si el cliente envía otro mensaje seguido
  // Los audios se procesan de inmediato (ya tomaron tiempo en transcribir)
  if (isAudio) {
    await sendReply(from, userText, config, business);
  } else {
    debounceMessage(from, userText, (combinedText) => sendReply(from, combinedText, config, business));
  }
}

// ── Generar y enviar respuesta ──────────────────────────────────────────────
async function sendReply(from, userText, config, business) {
  const history = await memory.getHistory(from, 6);
  const context = await memory.getContext(from) || {};

  let replyText = '';
  let notifySlack = false;

  // 1. Lógica de negocio del tenant (reglas rápidas, sin LLM)
  // Pasar phone y config en contexto para upsell handler
  const contextWithMeta = { ...context, _phone: from, _config: config };
  const quickResult = await business.quickReply(userText, contextWithMeta, history);
  if (quickResult) {
    replyText    = quickResult.text;
    notifySlack  = quickResult.notifySlack || false;
    // skipReply: el handler externo (ej. upsell) ya envía el mensaje — no hacer nada más
    if (quickResult.skipReply) {
      logger.log(`[reply] skipReply activo — respuesta delegada a handler externo`);
      return;
    }
  }

  // 2. Si el tenant pide IA o no hay respuesta rápida → Claude
  if (!replyText || quickResult?.useAI) {
    let systemPrompt = business.buildSystemPrompt(context);
    // Inyectar contexto Shopify al system prompt si existe
    if (context?.shopifyContext) {
      systemPrompt = `${systemPrompt}\n\n---\n${context.shopifyContext}`;
    }
    // Inyectar contexto de campaña si el cliente llega desde un envío masivo
    const campaignCtx = await memory.getCampaignContext(from);
    if (campaignCtx) {
      const sentDate = campaignCtx.sentAt ? new Date(campaignCtx.sentAt).toLocaleDateString('es-CL') : 'recientemente';
      systemPrompt = `${systemPrompt}\n\n---\n## Contexto de campaña\nEste cliente recibió un mensaje de campaña el ${sentDate}.\nCampaña: "${campaignCtx.name}"\nDescripción: ${campaignCtx.description || 'sin descripción'}\n${campaignCtx.extra ? `Detalle extra: ${campaignCtx.extra}` : ''}\nTen esto en cuenta al responder: el cliente probablemente escribe en respuesta a esa campaña. Responde de forma coherente con la oferta o mensaje que recibió.`;
      logger.log(`🎯 Contexto de campaña inyectado: "${campaignCtx.name}"`);
    }
    const aiResult     = await ai.ask(userText, history, context, systemPrompt, config);

    if (aiResult.response) {
      replyText = aiResult.response;
      logger.log(`🤖 Claude respondió (costo: $${aiResult.cost?.toFixed(4) || '?'})`);
    } else {
      replyText = aiResult.fallback || config.fallbackMessage;
    }
  }

  // 3. Guardar en memoria
  await memory.addMessage(from, replyText, 'bot');

  // 4. Delay humano
  await humanDelay(replyText.length);

  // 5. Enviar WhatsApp
  await meta.sendMessage(from, replyText, config);

  // 6. Log en Slack (supervisión) — incluir info Shopify en primer mensaje
  const shopifySlackInfo = context?.shopifySlackInfo || null;
  if (notifySlack) {
    await slack.notifyHandoff(from, userText, config);
  } else {
    await slack.logConversation(from, userText, replyText, config, shopifySlackInfo);
  }
}

// Delay más realista: ~50ms por carácter, mínimo 1.5s, máximo 7s + variación aleatoria
function humanDelay(len) {
  const base = Math.min(len * 50, 7000);
  const min  = 1500;
  const jitter = Math.random() * 800;
  const ms = Math.max(base, min) + jitter;
  return new Promise(r => setTimeout(r, ms));
}

async function postSlackMessage(channel, thread_ts, text) {
  const axios = require('axios');
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return;
  await axios.post('https://slack.com/api/chat.postMessage',
    { channel, thread_ts, text },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  ).catch(e => logger.log(`⚠️ Slack post error: ${e.message}`));
}

module.exports = { start };
