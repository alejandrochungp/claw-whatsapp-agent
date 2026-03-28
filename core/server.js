/**
 * core/server.js â€” Webhook Express genÃ©rico
 *
 * Recibe mensajes de Meta Cloud API y los enruta al tenant correspondiente.
 * No contiene lÃ³gica de negocio: todo lo especÃ­fico viene de tenantBusiness.
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

  app.use(bodyParser.json({ type: 'application/json' }));
  app.use((req, res, next) => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); next(); });

  // â”€â”€ GET /webhook â€” verificaciÃ³n Meta â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.get('/webhook', (req, res) => {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    if (mode === 'subscribe' && token === config.verifyToken) {
      logger.log('âœ… Webhook verificado por Meta');
      return res.status(200).send(challenge);
    }
    logger.log(`âŒ VerificaciÃ³n fallida (token: ${token})`);
    res.sendStatus(403);
  });

  // â”€â”€ POST /webhook â€” mensajes entrantes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  // -- Debounce por numero: agrupa mensajes rapidos del mismo cliente --------
  const messageQueues   = new Map(); // phone -> [msgs]
  const debounceTimers  = new Map(); // phone -> timer
  const DEBOUNCE_MS     = 2500;      // esperar 2.5s despues del ultimo mensaje

  async function flushQueue(phone, value) {
    const msgs = messageQueues.get(phone) || [];
    messageQueues.delete(phone);
    debounceTimers.delete(phone);
    if (!msgs.length) return;

    if (msgs.length === 1) {
      await handleMessage(msgs[0], value, config, business);
    } else {
      // Varios mensajes de texto: concatenar y procesar como uno solo
      const textMsgs = msgs.filter(m => m.type === 'text' && m.text?.body);
      const nonText  = msgs.filter(m => m.type !== 'text' || !m.text?.body);
      if (textMsgs.length > 1 && nonText.length === 0) {
        const combined = { ...msgs[msgs.length - 1] };
        combined.text = { body: textMsgs.map(m => m.text.body.trim()).join('\n') };
        logger.log('[' + phone + '] ' + msgs.length + ' mensajes agrupados: "' + combined.text.body.substring(0, 80) + '"');
        await handleMessage(combined, value, config, business);
      } else {
        // Mix de tipos: procesar por separado
        for (const msg of msgs) await handleMessage(msg, value, config, business);
      }
    }
  }
  app.post('/webhook', async (req, res) => {
    try {
      res.sendStatus(200); // Responder rÃ¡pido a Meta

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
      logger.log(`âŒ Error en webhook: ${err.message}`);
    }
  });

  // â”€â”€ GET /status â€” health check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.get('/status', (req, res) => {
    res.json({
      ok: true,
      tenant: process.env.TENANT,
      phone: config.businessPhone,
      uptime: process.uptime()
    });
  });

  // â”€â”€ POST /shopify/order â€” webhook Shopify order_paid â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.post('/shopify/order', async (req, res) => {
    res.sendStatus(200); // Responder rÃ¡pido a Shopify
    try {
      const order = req.body;
      if (!order?.id) return;
      logger.log(`[shopify] Nuevo pedido: #${order.name} â€” ${order.financial_status}`);
      if (order.financial_status === 'paid') {
        await upsell.handleNewOrder(order, config);
      }
    } catch (err) {
      logger.log(`[shopify] Error webhook: ${err.message}`);
    }
  });

  // â”€â”€ GET /admin/prompt â€” ver prompt activo en memoria â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.get('/admin/prompt', async (req, res) => {
    const samplePrompt = await business.buildSystemPrompt({});
    res.json({ ok: true, length: samplePrompt.length, preview: samplePrompt.slice(0, 500) });
  });

  // â”€â”€ POST /admin/debug-context â€” ver contexto Redis de un nÃºmero â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.post('/admin/debug-context', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone requerido' });
    const ctx      = await memory.getContext(phone);
    const hist     = await memory.getHistory(phone, 5);
    const campaign = await memory.getCampaignContext(phone);
    res.json({ context: ctx, recentHistory: hist, campaignContext: campaign });
  });

  // â”€â”€ GET /admin/wa-template â€” ver estructura de un template WA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.get('/admin/wa-template', async (req, res) => {
    const name = req.query.name || 'pago_confirmado_upsell';
    const waToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const wabaId  = process.env.WHATSAPP_WABA_ID || process.env.WABA_ID || '790101577482960';
    try {
      const axios = require('axios');
      const r = await axios.get(`https://graph.facebook.com/v19.0/${wabaId}/message_templates`, {
        params: { name, fields: 'name,status,components' },
        headers: { Authorization: `Bearer ${waToken}` }
      });
      res.json({ ok: true, template: r.data.data?.[0] || null });
    } catch (e) {
      res.json({ ok: false, error: e.response?.data || e.message });
    }
  });

  // â”€â”€ GET /admin/logs â€” Ãºltimos logs del servidor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.get('/admin/logs', (req, res) => {
    const n = parseInt(req.query.n) || 50;
    res.json({ logs: logger.getRecentLogs(n) });
  });

  // â”€â”€ POST /admin/reset-thread â€” forzar recreaciÃ³n de thread Slack â”€â”€â”€â”€â”€â”€â”€â”€
  app.post('/admin/reset-thread', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone requerido' });
    slack.phoneToThread.delete(phone);
    await slack.deleteThreadFromRedis(phone);
    logger.log(`[admin] Thread Slack reseteado para ${phone}`);
    res.json({ ok: true, phone });

  // POST /admin/refresh-catalog
  app.post('/admin/refresh-catalog', async (req, res) => {
    try {
      const { invalidateCatalog, getProductCatalog } = require('./shopify');
      await invalidateCatalog();
      const catalog = await getProductCatalog();
      logger.log('[admin] Catalogo recargado: ' + catalog.length + ' productos');
      res.json({ ok: true, products: catalog.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  });

  // â”€â”€ POST /admin/reset-context â€” limpiar contexto de un nÃºmero (solo pruebas) â”€â”€
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

  // POST /admin/refresh-catalog - forzar recarga del catalogo Shopify
  app.post('/admin/refresh-catalog', async (req, res) => {
    try {
      const { invalidateCatalog, getProductCatalog } = require('./shopify');
      await invalidateCatalog();
      const catalog = await getProductCatalog();
      logger.log('[admin] Catalogo recargado: ' + catalog.length + ' productos');
      res.json({ ok: true, products: catalog.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // â”€â”€ POST /admin/campaign-context â€” registrar contexto de campaÃ±a en Redis â”€â”€
  app.post('/admin/campaign-context', async (req, res) => {
    const { phone, campaign } = req.body;
    if (!phone || !campaign) return res.status(400).json({ error: 'phone y campaign requeridos' });
    await memory.setCampaignContext(phone, campaign);
    logger.log(`[campaign] Contexto guardado: ${phone} â†’ "${campaign.name}"`);
    res.json({ ok: true, phone });
  });

  // â”€â”€ POST /admin/seed-thread â€” inyectar threadâ†’phone en Redis (one-time migration) â”€â”€
  app.post('/admin/seed-thread', async (req, res) => {
    const { phone, thread_ts, channel } = req.body;
    if (!phone || !thread_ts) return res.status(400).json({ error: 'phone y thread_ts requeridos' });
    const data = { thread_ts, channel: channel || 'C05FES87S9J', timestamp: Date.now() };
    slack.phoneToThread.set(phone, data);
    await slack.saveThreadExternal(phone, data);
    logger.log(`[seed] thread mapeado: ${phone} â†’ ${thread_ts}`);
    res.json({ ok: true, phone, thread_ts });
  });

  // â”€â”€ POST /slack/events â€” recibir mensajes y comandos desde Slack â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.post('/slack/events', async (req, res) => {
    const body = req.body;

    // VerificaciÃ³n de URL (Slack envÃ­a challenge al configurar)
    if (body.type === 'url_verification') {
      return res.json({ challenge: body.challenge });
    }

    res.sendStatus(200); // Responder rÃ¡pido a Slack

    const event = body.event;
    if (!event) return;

    // Debug: loguear todos los eventos Slack entrantes
    logger.log(`[slack-event] type=${event.type} subtype=${event.subtype || '-'} bot_id=${event.bot_id || '-'} thread=${event.thread_ts || '-'} text="${(event.text || '').slice(0, 50)}"`);

    // â”€â”€ ReacciÃ³n en canal de learning â†’ aplicar aprendizaje â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (event.type === 'reaction_added' && event.item?.channel === (process.env.SLACK_LEARNING_CHANNEL || 'C0APVLMV98Q')) {
      const reaction = event.reaction; // 'white_check_mark' o 'x'
      if (reaction === 'white_check_mark' || reaction === 'heavy_check_mark') {
        logger.log(`[learning] âœ… ReacciÃ³n aprobaciÃ³n en mensaje ${event.item.ts} â€” aplicando...`);
        learning.applyApprovedMessage(event.item.ts, event.item.channel).catch(e =>
          logger.log(`[learning] Error aplicando: ${e.message}`)
        );
      }
      return;
    }

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

    // â”€â”€ Comando: tomar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (text === 'tomar') {
      const phone = slack.handleSlackCommand('tomar', thread_ts);
      if (phone) {
        const operatorName = await slack.sendOperatorReply(phone, null, userId, config);
        logger.log(`ðŸ‘¤ ${operatorName} tomÃ³ control de ${phone}`);
        // Actualizar header del thread
        const threadData = slack.phoneToThread.get(phone);
        if (threadData?.headerTs) {
          await slack.updateThreadHeader(phone, 'human', channel, threadData.headerTs, operatorName);
        }
        await postSlackMessage(channel, thread_ts, `ðŸ‘¤ *${operatorName}* tomÃ³ el control. Bot pausado. Escribe \`soltar\` cuando termines.`);
      }
      return;
    }

    // â”€â”€ Comando: soltar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (text === 'soltar') {
      const phone = slack.handleSlackCommand('soltar', thread_ts);
      if (phone) {
        const operatorName = await slack.sendOperatorReply(phone, null, userId, config);
        const threadData   = slack.phoneToThread.get(phone);
        if (threadData?.headerTs) {
          await slack.updateThreadHeader(phone, 'resolved_human', channel, threadData.headerTs, operatorName);
        }
        logger.log(`âœ… ${operatorName} soltÃ³ ${phone} â€” marcado como resuelto`);
        await postSlackMessage(channel, thread_ts, `âœ… Resuelto por *${operatorName}*. Bot reactivado.`);
      }
      return;
    }

    // â”€â”€ Comando: urgente â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (text === 'urgente' || text === '!') {
      for (const [phone, info] of slack.phoneToThread) {
        if (info.thread_ts === thread_ts) {
          await postSlackMessage(channel, thread_ts, `ðŸš¨ <!channel> se requiere atenciÃ³n urgente en esta conversaciÃ³n (+${phone})`);
          if (info.headerTs) {
            await slack.updateThreadHeader(phone, 'attention', channel, info.headerTs);
          }
          break;
        }
      }
      return;
    }

    // â”€â”€ Respuesta humana en thread â†’ enviar al cliente con firma â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    for (const [phone, info] of slack.phoneToThread) {
      if (info.thread_ts === thread_ts) {
        const activeThread = slack.getActiveConversation(phone);
        const recentTake   = slack.getRecentTake(phone);

        if (activeThread || recentTake) {
          // Obtener nombre del operador y firmar el mensaje
          const operatorName = await slack.sendOperatorReply(phone, event.text, userId, config);
          const msgToClient  = `${event.text}\n\nâ€” ${operatorName}`;
          await meta.sendMessage(phone, msgToClient, config);
          logger.log(`ðŸ“¤ ${operatorName} respondiÃ³ a ${phone}: ${event.text}`);
        }
        break;
      }
    }
  });

  // â”€â”€ POST /slack/actions â€” botones interactivos (aprendizaje) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.post('/slack/actions', express.urlencoded({ extended: true }), async (req, res) => {
    res.sendStatus(200); // Responder rÃ¡pido a Slack
    try {
      logger.log(`[slack/actions] body keys: ${Object.keys(req.body || {}).join(',') || 'EMPTY'} | raw: ${JSON.stringify(req.body).substring(0, 100)}`);
      const payload = JSON.parse(req.body.payload);
      logger.log(`[slack/actions] type=${payload.type} actions=${JSON.stringify((payload.actions||[]).map(a=>a.action_id))}`);

      // Botones de aprendizaje (Aprobar/Editar/Rechazar)
      if (payload.type === 'block_actions') {
        for (const action of payload.actions || []) {
          logger.log(`[slack/actions] action_id=${action.action_id}`);
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

      // Modal de ediciÃ³n enviado
      if (payload.type === 'view_submission' && payload.view?.callback_id === 'learning_edit_submit') {
        logger.log(`[slack/actions] view_submission learning_edit_submit`);
        await learning.handleEditSubmit(payload);
      }
    } catch (e) {
      logger.log(`[slack/actions] Error: ${e.message} | stack: ${e.stack?.split('\n')[1]}`);
    }
  });

  // â”€â”€ POST /admin/learning/inject â€” inyectar conversaciones de Slack â”€â”€â”€â”€â”€â”€â”€
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

  // â”€â”€ POST /admin/learning/run â€” forzar anÃ¡lisis manual â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.post('/admin/learning/run', async (req, res) => {
    const { date } = req.body;
    try {
      const result = await learning.runNow(date);
      res.json({ ok: true, suggestions: result?.suggestions?.length || 0 });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // â”€â”€ GET /admin/learning/kpis â€” mÃ©tricas de operadores â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.get('/admin/learning/kpis', async (req, res) => {
    const metrics = await learning.getAllOperatorMetrics();
    res.json({ ok: true, operators: metrics });
  });

  // â”€â”€ GET /admin/learning/faqs â€” ver FAQs aprendidas â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.get('/admin/learning/faqs', (req, res) => {
    res.json({ ok: true, faqs: learning.loadLearnedFaqs() });
  });

  app.listen(PORT, '0.0.0.0', () => {
    logger.log(`âœ… Servidor escuchando en 0.0.0.0:${PORT}`);
    // Pre-calentar catÃ¡logo en background al arrancar
    shopify.getProductCatalog().catch(() => {});
    // Iniciar cron de aprendizaje diario (20:00 Santiago)
    learning.startDailyCron();
  });
}

// â”€â”€ Subir media de WhatsApp a Slack (nueva API v2) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  logger.log(`[media] upload â†’ channel: ${channel}, thread: ${threadData?.thread_ts || 'nuevo'}`);

  try {
    // 1. Descargar imagen de Meta
    const buf64 = await meta.downloadMedia(mediaUrl);
    if (!buf64) { logger.log(`[media] No se pudo descargar ${type} de ${phone}`); return; }

    const binBuf  = Buffer.from(buf64, 'base64');
    const ext     = mimeType.split('/')[1]?.split(';')[0]?.split('+')[0] || type;
    const fname   = `media_${Date.now()}.${ext}`;
    const label   = `${typeEmoji} +${phone} enviÃ³ ${type}${caption ? ': "' + caption + '"' : ''}`;
    const axiosI  = require('axios');

    // 2. Solicitar URL de upload (nueva API Slack â€” params como query string, no JSON)
    const uploadParams = new URLSearchParams({ filename: fname, length: binBuf.length });
    const urlResp = await axiosI.post(
      `https://slack.com/api/files.getUploadURLExternal?${uploadParams}`,
      '',
      { headers: { Authorization: `Bearer ${slackToken}` }, timeout: 15000 }
    );

    if (!urlResp.data?.ok) {
      logger.log(`[media] getUploadURL error: ${urlResp.data?.error} â€” intentando anÃ¡lisis con Claude Vision`);

      // Fallback: analizar imagen con Claude y postear descripciÃ³n en Slack
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
                { type: 'text', text: 'Describe brevemente esta imagen en 1-2 oraciones para un operador de atenciÃ³n al cliente.' }
              ]}]
            }, { headers: { 'x-api-key': claudeKey, 'anthropic-version': '2023-06-01' }, timeout: 20000 });
            const description = desc.data?.content?.[0]?.text || '';
            if (description) slackText = `${label}\n> ðŸ” _DescripciÃ³n: ${description}_`;
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
      logger.log(`[media] ${type} subido a Slack âœ… (canal: ${channel})`);
    } else {
      logger.log(`[media] completeUpload error: ${completeResp.data?.error}`);
    }
  } catch (e) {
    logger.log(`[media] uploadMediaToSlack error: ${e.response?.data?.error || e.message}`);
  }
}

// â”€â”€ Status updates â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const messageTracker = new Map();

async function handleStatus(status, config) {
  const { id: msgId, status: type, errors } = status;

  // Loguear errores de entrega
  if (type === 'failed') {
    logger.log(`âŒ Mensaje fallido [${msgId}]: ${JSON.stringify(errors)}`);
    return;
  }

  if (type !== 'read') return;

  const info = messageTracker.get(msgId);
  if (!info) return;

  const { channel, ts } = info;
  const token = process.env.SLACK_BOT_TOKEN;
  const axios = require('axios');

  // Quitar â¬œ y poner âœ…
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

// â”€â”€ DeduplicaciÃ³n de mensajes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const processedMessages = new Map(); // messageId â†’ timestamp
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



// â”€â”€ Mensaje entrante â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function handleMessage(message, value, config, business) {
  const from = message.from;
  const type = message.type;

  // Deduplicar â€” Meta puede reenviar el mismo webhook varias veces
  if (message.id && isDuplicate(message.id)) {
    logger.log(`âš ï¸ Mensaje duplicado ignorado: ${message.id}`);
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
      logger.log(`ðŸŽ¤ Audio recibido de [${from}] â€” transcribiendo...`);
      const transcription = await audio.transcribeWhatsAppAudio(mediaId, config);
      if (transcription) {
        userText = transcription;
        isAudio  = true;
        logger.log(`ðŸŽ¤ TranscripciÃ³n: "${transcription.slice(0, 80)}"`);
      } else {
        logger.log(`âš ï¸ No se pudo transcribir audio de ${from}`);
        return;
      }
    }
  } else if (type === 'image' || type === 'document' || type === 'video' || type === 'sticker') {
    const mediaId   = message[type]?.id;
    const caption   = message[type]?.caption || '';
    const mediaInfo = mediaId ? await meta.getMediaUrl(mediaId, config) : null;
    const mimeType  = mediaInfo?.mimeType || 'application/octet-stream';
    const mediaUrl  = mediaInfo?.url || null;
    const typeEmoji = type === 'image' ? 'ðŸ–¼ï¸' : type === 'video' ? 'ðŸŽ¥' : type === 'sticker' ? 'ðŸŽ­' : 'ðŸ“„';

    logger.log(`${typeEmoji} ${type} recibido de [${from}]${caption ? ` caption: "${caption}"` : ''}`);

    const activeThread = slack.getActiveConversation(from);

    // Si hay operador activo â†’ subir foto al thread y salir
    if (activeThread) {
      if (mediaUrl) {
        await uploadMediaToSlack(from, type, typeEmoji, caption, mediaUrl, mimeType, config);
      }
      return;
    }

    // â”€â”€ ImÃ¡genes: analizar con Claude Vision y responder directamente â”€â”€â”€â”€
    if (type === 'image' && mediaUrl) {
      try {
        const imageBuf  = await meta.downloadMedia(mediaUrl);
        const imgCtx    = await memory.getContext(from) || {};
        const sysPrompt = await business.buildSystemPrompt(imgCtx);
        const aiReply   = imageBuf ? await ai.analyzeImage(imageBuf, mimeType, sysPrompt) : null;
        const reply     = aiReply || (caption ? null : 'recibÃ­ tu foto! en quÃ© te puedo ayudar?');

        if (reply) {
          await memory.addMessage(from, caption || '[imagen]', 'user');
          await memory.addMessage(from, reply, 'bot');
          await humanDelay(reply.length);
          await meta.sendMessage(from, reply, config);

          // Log en Slack: primero el texto, luego sube la imagen al thread creado
          const shopifySlackInfo = imgCtx?.shopifySlackInfo || null;
          const slackLabel = `${typeEmoji} [image]${caption ? ': "' + caption + '"' : ''}`;
          await slack.logConversation(from, slackLabel, reply, config, shopifySlackInfo);
          if (mediaUrl) {
            // PequeÃ±o delay para asegurar que phoneToThread tiene el thread_ts nuevo
            setTimeout(() => {
              uploadMediaToSlack(from, type, typeEmoji, caption, mediaUrl, mimeType, config)
                .catch(e => logger.log(`[media] upload error: ${e.message}`));
            }, 1500);
          }
        }
      } catch (e) {
        logger.log(`[media] imagen error: ${e.message}`);
        await meta.sendMessage(from, 'recibÃ­ tu foto! en quÃ© te puedo ayudar?', config);
      }
      return; // NO continuar al flujo de sendReply
    }

    // Otros tipos de media (video, doc, sticker): usar caption o acuse simple
    if (caption) {
      userText = caption;
    } else {
      const tipoLabel = type === 'document' ? 'documento' : type === 'video' ? 'video' : 'archivo';
      // Acuse simple + subir a Slack
      const ack = `recibÃ­ tu ${tipoLabel}! en quÃ© te puedo ayudar?`;
      await meta.sendMessage(from, ack, config);
      if (mediaUrl) {
        uploadMediaToSlack(from, type, typeEmoji, caption, mediaUrl, mimeType, config)
          .catch(e => logger.log(`[media] upload error: ${e.message}`));
      }
      return;
    }

    // Si llegÃ³ hasta acÃ¡ (caption en video/doc), seguir al flujo normal
    message._pendingMediaUpload = mediaUrl ? { mediaUrl, mimeType, typeEmoji, caption, type } : null;
  } else {
    logger.log(`âš ï¸ Tipo no soportado: ${type}`);
    return;
  }

  logger.log(`ðŸ“¨ [${from}] ${isAudio ? 'ðŸŽ¤ ' : ''}${userText}`);

  // Si enviÃ³ audio, marcar en contexto para que Claude lo sepa
  if (isAudio) {
    await memory.updateContext(from, { canSendAudio: true });
  }

  // Para imÃ¡genes, el historial ya fue guardado en el bloque de imagen â€” no duplicar
  if (!userText.startsWith('[imagen]')) {
    await memory.addMessage(from, userText, 'user');
  }

  // Enriquecer con datos de Shopify (primera vez o si no hay contexto guardado)
  let shopifyData = null;
  const savedContext = await memory.getContext(from);
  if (!savedContext?.shopifyChecked) {
    shopifyData = await shopify.enrichContact(from);
    if (shopifyData) {
      logger.log(`ðŸ›ï¸ Cliente Shopify identificado: ${shopifyData.customer.first_name} ${shopifyData.customer.last_name || ''}`);
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

  // Â¿Hay agente humano activo para este nÃºmero?
  const activeThread = slack.getActiveConversation(from);
  if (activeThread) {
    await slack.forwardToThread(from, userText, activeThread, config);
    return;
  }

  const pendingMedia = message._pendingMediaUpload || null;

  // Debounce: esperar 3s por si el cliente envÃ­a otro mensaje seguido
  // Los audios se procesan de inmediato (ya tomaron tiempo en transcribir)
  if (isAudio) {
    await sendReply(from, userText, config, business, pendingMedia);
  } else {
    await sendReply(from, userText, config, business, pendingMedia); // fix: debounceMessage era undefined
  }
}

// â”€â”€ Generar y enviar respuesta â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function sendReply(from, userText, config, business, pendingMedia = null) {
  const history = await memory.getHistory(from, 6);
  const context = await memory.getContext(from) || {};

  let replyText = '';
  let notifySlack = false;

  // 1. LÃ³gica de negocio del tenant (reglas rÃ¡pidas, sin LLM)
  // Pasar phone y config en contexto para upsell handler
  const contextWithMeta = { ...context, _phone: from, _config: config };
  const quickResult = await business.quickReply(userText, contextWithMeta, history);
  if (quickResult) {
    replyText    = quickResult.text;
    notifySlack  = quickResult.notifySlack || false;
    // skipReply: el handler externo (ej. upsell) ya envÃ­a el mensaje â€” no hacer nada mÃ¡s
    if (quickResult.skipReply) {
      logger.log(`[reply] skipReply activo â€” respuesta delegada a handler externo`);
      return;
    }
  }

  // 2. Si el tenant pide IA o no hay respuesta rÃ¡pida â†’ Claude
  if (!replyText || quickResult?.useAI) {
    let systemPrompt = await business.buildSystemPrompt(context);
    // Inyectar contexto Shopify al system prompt si existe
    if (context?.shopifyContext) {
      systemPrompt = `${systemPrompt}\n\n---\n${context.shopifyContext}`;
    }
    // Inyectar catÃ¡logo relevante si el cliente pregunta por productos/stock/precios
    // Buscar siempre en catálogo — Claude decide si usar la info o no
    {
    try {
        // Buscar por texto del cliente; si no hay match, usar historial reciente o top 5
        let matches = shopify.searchCatalog(catalog, userText);
        if (!matches.length) {
          const recentHist = await memory.getHistory(from, 3);
          const recentText = recentHist.map(m => m.content || '').join(' ');
          if (recentText) matches = shopify.searchCatalog(catalog, recentText, 3);
        }
        // (sin fallback — solo inyectar si hay match relevante)
        if (matches.length) {
          const catalogText = shopify.formatCatalogForPrompt(matches);
          systemPrompt += `\n\n---\n## Productos relevantes (datos en tiempo real de Shopify)\n${catalogText}\n\nUsa estos datos para responder sobre disponibilidad y precios. Si el producto que busca no aparece aquÃ­, di que no lo tienes disponible actualmente.`;
          logger.log(`[catalog] ${matches.length} productos inyectados para: "${userText.slice(0, 50)}"`);
        }
      } catch (e) {
        logger.log(`[catalog] Error: ${e.message}`);
      }
    }

    // Inyectar contexto de campaÃ±a si el cliente llega desde un envÃ­o masivo
    const campaignCtx = await memory.getCampaignContext(from);
    if (campaignCtx) {
      const sentDate = campaignCtx.sentAt ? new Date(campaignCtx.sentAt).toLocaleDateString('es-CL') : 'recientemente';
      systemPrompt = `${systemPrompt}\n\n---\n## Contexto de campaÃ±a\nEste cliente recibiÃ³ un mensaje de campaÃ±a el ${sentDate}.\nCampaÃ±a: "${campaignCtx.name}"\nDescripciÃ³n: ${campaignCtx.description || 'sin descripciÃ³n'}\n${campaignCtx.extra ? `Detalle extra: ${campaignCtx.extra}` : ''}\nTen esto en cuenta al responder: el cliente probablemente escribe en respuesta a esa campaÃ±a. Responde de forma coherente con la oferta o mensaje que recibiÃ³.`;
      logger.log(`ðŸŽ¯ Contexto de campaÃ±a inyectado: "${campaignCtx.name}"`);
    }
    const aiResult     = await ai.ask(userText, history, context, systemPrompt, config);

    if (aiResult.response) {
      replyText = aiResult.response;
      logger.log(`ðŸ¤– Claude respondiÃ³ (costo: $${aiResult.cost?.toFixed(4) || '?'})`);
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

  // 6. Log en Slack (supervisiÃ³n) â€” incluir info Shopify en primer mensaje
  const shopifySlackInfo = context?.shopifySlackInfo || null;

  // Detectar token [HANDOFF] — Claude lo emite cuando decide derivar al equipo
  if (!notifySlack && replyText && replyText.includes('[HANDOFF]')) {
    notifySlack = true;
    replyText = replyText.replace('[HANDOFF]', '').trim();
    logger.log('[handoff] Claude derivo a operador via token [HANDOFF]');
  }

  if (notifySlack) {
    await slack.notifyHandoff(from, userText, config);
  } else {
    // Para imÃ¡genes, mostrar "ðŸ–¼ï¸ [imagen]" como texto del cliente en Slack
    const slackUserText = pendingMedia ? `${pendingMedia.typeEmoji} [${pendingMedia.type}]${pendingMedia.caption ? ': "' + pendingMedia.caption + '"' : ''}` : userText;
    await slack.logConversation(from, slackUserText, replyText, config, shopifySlackInfo);
  }

  // 7. Subir imagen al thread DESPUÃ‰S de que logConversation lo creÃ³
  if (pendingMedia?.mediaUrl) {
    const { mediaUrl, mimeType, typeEmoji, caption, type } = pendingMedia;
    uploadMediaToSlack(from, type, typeEmoji, caption, mediaUrl, mimeType, config)
      .catch(e => logger.log(`[media] upload post-log error: ${e.message}`));
  }
}

// Delay mÃ¡s realista: ~50ms por carÃ¡cter, mÃ­nimo 1.5s, mÃ¡ximo 7s + variaciÃ³n aleatoria
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
  ).catch(e => logger.log(`âš ï¸ Slack post error: ${e.message}`));
}

module.exports = { start };
