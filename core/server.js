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
const learning   = require('./learning');

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

  // ── GET /admin/prompt — ver prompt activo en memoria ─────────────────────
  app.get('/admin/prompt', (req, res) => {
    const samplePrompt = business.buildSystemPrompt({});
    res.json({ ok: true, length: samplePrompt.length, preview: samplePrompt.slice(0, 500) });
  });

  // ── POST /admin/debug-context — ver contexto Redis de un número ──────────
  app.post('/admin/debug-context', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone requerido' });
    const ctx      = await memory.getContext(phone);
    const hist     = await memory.getHistory(phone, 5);
    const campaign = await memory.getCampaignContext(phone);
    res.json({ context: ctx, recentHistory: hist, campaignContext: campaign });
  });

  // ── POST /admin/reset-thread — forzar recreación de thread Slack ────────
  app.post('/admin/reset-thread', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone requerido' });
    slack.phoneToThread.delete(phone);
    await slack.deleteThreadFromRedis(phone);
    logger.log(`[admin] Thread Slack reseteado para ${phone}`);
    res.json({ ok: true, phone });
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

  // ── POST /slack/actions — botones interactivos (aprendizaje) ─────────────
  app.post('/slack/actions', express.urlencoded({ extended: true }), async (req, res) => {
    res.sendStatus(200); // Responder rápido a Slack
    try {
      const payload = JSON.parse(req.body.payload);

      // Botones de aprendizaje (Aprobar/Editar/Rechazar)
      if (payload.type === 'block_actions') {
        for (const action of payload.actions || []) {
          if (action.action_id?.startsWith('learning_')) {
            action.trigger_id = payload.trigger_id;
            action.user       = payload.user;
            await learning.handleSlackAction(
              action,
              payload.container?.channel_id || payload.channel?.id,
              payload.container?.message_ts || payload.message?.ts
            );
          }
        }
      }

      // Modal de edición enviado
      if (payload.type === 'view_submission' && payload.view?.callback_id === 'learning_edit_submit') {
        await learning.handleEditSubmit(payload);
      }
    } catch (e) {
      logger.log(`[slack/actions] Error: ${e.message}`);
    }
  });

  // ── POST /admin/learning/inject — inyectar conversaciones de Slack ───────
  app.post('/admin/learning/inject', async (req, res) => {
    const { date, conversations } = req.body;
    if (!date || !conversations?.length) {
      return res.status(400).json({ error: 'date y conversations requeridos' });
    }
    try {
      let count = 0;
      for (const conv of conversations) {
        const lines    = (conv.dialogue || '').split('\n').filter(l => l.trim());
        const messages = lines.map(line => {
          const isBot   = line.startsWith('bot:');
          const isHuman = line.startsWith('human_operator:');
          const text    = line.replace(/^(bot|human_operator|system):\s*/, '').trim();
          return { role: isBot ? 'bot' : isHuman ? 'human' : 'system', text, ts: Date.now(),
                   operatorId: isHuman ? 'slack_operator' : undefined };
        }).filter(m => m.text && m.role !== 'system');

        await learning.saveConversationForReview(conv.ts || String(count), messages, 'human_resolved', 'slack_operator');
        count++;
      }
      logger.log(`[learning/inject] ${count} conversaciones inyectadas para ${date}`);
      res.json({ ok: true, injected: count, date });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /admin/learning/run — forzar análisis manual ────────────────────
  app.post('/admin/learning/run', async (req, res) => {
    const { date } = req.body;
    try {
      const result = await learning.runNow(date);
      res.json({ ok: true, suggestions: result?.suggestions?.length || 0 });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /admin/learning/kpis — métricas de operadores ────────────────────
  app.get('/admin/learning/kpis', async (req, res) => {
    const metrics = await learning.getAllOperatorMetrics();
    res.json({ ok: true, operators: metrics });
  });

  // ── GET /admin/learning/faqs — ver FAQs aprendidas ───────────────────────
  app.get('/admin/learning/faqs', (req, res) => {
    res.json({ ok: true, faqs: learning.loadLearnedFaqs() });
  });

  app.listen(PORT, '0.0.0.0', () => {
    logger.log(`✅ Servidor escuchando en 0.0.0.0:${PORT}`);
    // Pre-calentar catálogo en background al arrancar
    shopify.getProductCatalog().catch(() => {});
    // Iniciar cron de aprendizaje diario (20:00 Santiago)
    learning.startDailyCron();
  });
}

// ── Subir media de WhatsApp a Slack (nueva API v2) ──────────────────────────
async function uploadMediaToSlack(phone, type, typeEmoji, caption, mediaUrl, mimeType, config) {
  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken) { logger.log('[media] Sin SLACK_BOT_TOKEN'); return; }

  // Resolver channel y thread_ts (mismo fallback que config.js)
  const threadData = slack.phoneToThread.get(phone);
  const channel    = threadData?.channel
                  || process.env.SLACK_CHANNEL_ID
                  || process.env.SLACK_CHANNEL_WHATSAPP
                  || config?.slackChannel
                  || 'C05FES87S9J';  // fallback hardcoded igual que en config.js

  logger.log(`[media] upload → channel: ${channel}, thread: ${threadData?.thread_ts || 'nuevo'}`);

  try {
    // 1. Descargar imagen de Meta
    const buf64 = await meta.downloadMedia(mediaUrl);
    if (!buf64) { logger.log(`[media] No se pudo descargar ${type} de ${phone}`); return; }

    const binBuf  = Buffer.from(buf64, 'base64');
    const ext     = mimeType.split('/')[1]?.split(';')[0]?.split('+')[0] || type;
    const fname   = `media_${Date.now()}.${ext}`;
    const label   = `${typeEmoji} +${phone} envió ${type}${caption ? ': "' + caption + '"' : ''}`;
    const axiosI  = require('axios');

    // 2. Solicitar URL de upload (nueva API Slack — params como query string, no JSON)
    const uploadParams = new URLSearchParams({ filename: fname, length: binBuf.length });
    const urlResp = await axiosI.post(
      `https://slack.com/api/files.getUploadURLExternal?${uploadParams}`,
      '',
      { headers: { Authorization: `Bearer ${slackToken}` }, timeout: 15000 }
    );

    if (!urlResp.data?.ok) {
      logger.log(`[media] getUploadURL error: ${urlResp.data?.error} — intentando análisis con Claude Vision`);

      // Fallback: analizar imagen con Claude y postear descripción en Slack
      let slackText = label;
      if (type === 'image') {
        try {
          const buf64 = await meta.downloadMedia(mediaUrl);
          if (buf64) {
            const claudeKey = process.env.CLAUDE_API_KEY;
            const desc = await axiosI.post('https://api.anthropic.com/v1/messages', {
              model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
              max_tokens: 200,
              messages: [{ role: 'user', content: [
                { type: 'image', source: { type: 'base64', media_type: mimeType, data: buf64 } },
                { type: 'text', text: 'Describe brevemente esta imagen en 1-2 oraciones para un operador de atención al cliente.' }
              ]}]
            }, { headers: { 'x-api-key': claudeKey, 'anthropic-version': '2023-06-01' }, timeout: 20000 });
            const description = desc.data?.content?.[0]?.text || '';
            if (description) slackText = `${label}\n> 🔍 _Descripción: ${description}_`;
          }
        } catch (e) {
          logger.log(`[media] Claude Vision fallback error: ${e.message}`);
        }
      }

      // Postear en el thread (o crear thread si no existe)
      const postTarget = threadData?.thread_ts
        ? { channel, thread_ts: threadData.thread_ts, text: slackText }
        : { channel, text: slackText };
      await axiosI.post('https://slack.com/api/chat.postMessage', postTarget,
        { headers: { Authorization: `Bearer ${slackToken}`, 'Content-Type': 'application/json' } }
      ).catch(e => logger.log(`[media] Slack post error: ${e.message}`));
      return;
    }

    const { upload_url, file_id } = urlResp.data;

    // 3. Subir el archivo binario
    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', binBuf, { filename: fname, contentType: mimeType });
    await axiosI.post(upload_url, form, {
      headers: { ...form.getHeaders() },
      timeout: 30000,
      maxContentLength: 20 * 1024 * 1024
    });

    // 4. Completar upload y asociar al canal/thread
    const completeBody = {
      files:    [{ id: file_id, title: fname }],
      channel_id: channel,
      initial_comment: label
    };
    if (threadData?.thread_ts) completeBody.thread_ts = threadData.thread_ts;

    const completeResp = await axiosI.post('https://slack.com/api/files.completeUploadExternal',
      completeBody,
      { headers: { Authorization: `Bearer ${slackToken}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );

    if (completeResp.data?.ok) {
      logger.log(`[media] ${type} subido a Slack ✅ (canal: ${channel})`);
    } else {
      logger.log(`[media] completeUpload error: ${completeResp.data?.error}`);
    }
  } catch (e) {
    logger.log(`[media] uploadMediaToSlack error: ${e.response?.data?.error || e.message}`);
  }
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
  } else if (type === 'image' || type === 'document' || type === 'video' || type === 'sticker') {
    const mediaId   = message[type]?.id;
    const caption   = message[type]?.caption || '';
    const mediaInfo = mediaId ? await meta.getMediaUrl(mediaId, config) : null;
    const mimeType  = mediaInfo?.mimeType || 'application/octet-stream';
    const mediaUrl  = mediaInfo?.url || null;
    const typeEmoji = type === 'image' ? '🖼️' : type === 'video' ? '🎥' : type === 'sticker' ? '🎭' : '📄';

    logger.log(`${typeEmoji} ${type} recibido de [${from}]${caption ? ` caption: "${caption}"` : ''}`);

    const activeThread = slack.getActiveConversation(from);

    // Subir a Slack (siempre, en paralelo sin bloquear)
    if (mediaUrl) {
      uploadMediaToSlack(from, type, typeEmoji, caption, mediaUrl, mimeType, config)
        .catch(e => logger.log(`[media] uploadMediaToSlack error: ${e.message}`));
    }

    // Si hay operador activo → salir (ya se subió a Slack arriba)
    if (activeThread) return;

    // Construir userText para pasar por el flujo normal de sendReply
    if (type === 'image' && mediaUrl) {
      // Pre-analizar con Claude Vision y guardarlo como contexto
      try {
        const buf64     = await meta.downloadMedia(mediaUrl);
        const imgCtx    = await memory.getContext(from) || {};
        const sysPrompt = business.buildSystemPrompt(imgCtx);
        const aiDesc    = buf64 ? await ai.analyzeImage(buf64, mimeType, sysPrompt) : null;
        if (aiDesc) {
          // Pasar la descripción como userText → sendReply lo envía + loguea en Slack
          userText = `[imagen] ${aiDesc}`;
          // Guardar en historial como si el cliente hubiera descrito la imagen
          await memory.addMessage(from, caption || '[imagen enviada]', 'user');
        } else {
          userText = caption || '[imagen]';
        }
      } catch (e) {
        logger.log(`[media] analyzeImage error: ${e.message}`);
        userText = caption || '[imagen]';
      }
    } else if (caption) {
      userText = caption;
    } else {
      // Video/doc/sticker sin caption — acuse simple y loguear en Slack
      const tipoLabel = type === 'document' ? 'documento' : type === 'video' ? 'video' : 'archivo';
      userText = `[${tipoLabel} recibido]`;
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

  // Para imágenes, el historial ya fue guardado en el bloque de imagen — no duplicar
  if (!userText.startsWith('[imagen]')) {
    await memory.addMessage(from, userText, 'user');
  }

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
    // Inyectar catálogo relevante si el cliente pregunta por productos/stock/precios
    if (shopify.isProductQuery(userText)) {
      try {
        const catalog  = await shopify.getProductCatalog();
        const matches  = shopify.searchCatalog(catalog, userText);
        if (matches.length) {
          const catalogText = shopify.formatCatalogForPrompt(matches);
          systemPrompt += `\n\n---\n## Productos relevantes (datos en tiempo real de Shopify)\n${catalogText}\n\nUsa estos datos para responder sobre disponibilidad y precios. Si el producto que busca no aparece aquí, di que no lo tienes disponible actualmente.`;
          logger.log(`[catalog] ${matches.length} productos inyectados para: "${userText.slice(0, 50)}"`);
        }
      } catch (e) {
        logger.log(`[catalog] Error: ${e.message}`);
      }
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
