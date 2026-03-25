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

    // ── Comando: tomar ───────────────────────────────────────────────────
    if (text === 'tomar') {
      const phone = slack.handleSlackCommand('tomar', thread_ts);
      if (phone) {
        logger.log(`👤 Humano tomó control de ${phone}`);
        await postSlackMessage(channel, thread_ts, '👤 Control tomado. El bot está pausado. Escribe `soltar` para devolver al bot.');
      }
      return;
    }

    // ── Comando: soltar ──────────────────────────────────────────────────
    if (text === 'soltar') {
      const phone = slack.handleSlackCommand('soltar', thread_ts);
      if (phone) {
        logger.log(`🤖 Bot retoma control de ${phone}`);
        await postSlackMessage(channel, thread_ts, '🤖 Bot reactivado. Volviendo a respuesta automática.');
      }
      return;
    }

    // ── Respuesta humana en thread → enviar al cliente ───────────────────
    // Buscar el phone asociado a este thread
    for (const [phone, info] of slack.phoneToThread) {
      if (info.thread_ts === thread_ts) {
        // Verificar si hay control humano activo
        const activeThread = slack.getActiveConversation(phone);
        if (activeThread) {
          await meta.sendMessage(phone, event.text, config);
          logger.log(`📤 Humano respondió a ${phone}: ${event.text}`);
        } else {
          // Thread existe pero humano aún no tomó control (race condition)
          // Verificar si "tomar" fue escrito recientemente (últimos 5s)
          const recentTake = slack.getRecentTake(phone);
          if (recentTake) {
            await meta.sendMessage(phone, event.text, config);
            logger.log(`📤 Humano respondió a ${phone} (race condition handled): ${event.text}`);
          }
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

  // Generar respuesta
  await sendReply(from, userText, config, business);
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

function humanDelay(len) {
  const ms = Math.min(len * 40, 2500) + Math.random() * 400;
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
