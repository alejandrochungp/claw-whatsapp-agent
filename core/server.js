/**
 * core/server.js â€" Webhook Express genÃ©rico
 *
 * Recibe mensajes de Meta Cloud API y los enruta al tenant correspondiente.
 * No contiene lÃ³gica de negocio: todo lo especÃ­fico viene de tenantBusiness.
 */

const express    = require('express');
const bodyParser = require('body-parser');
const axios      = require('axios');
const memory     = require('./memory');
const slack      = require('./slack');
const ai         = require('./ai');
const meta       = require('./meta');
const logger     = require('./logger');
const shopify    = require('./shopify');
const audio      = require('./audio');
const upsell     = require('./upsell');
const learning   = require('./learning');
const klaviyo    = require('./klaviyo');

// Catálogo Shopify en memoria del módulo — se precalienta al arrancar y
// se actualiza vía /admin/refresh-catalog. Se comparte en todas las llamadas.
let catalog = [];

function start(config, business) {
  const app  = express();
  const PORT = process.env.PORT || config.port || 3000;

  app.use(bodyParser.json({ type: 'application/json' }));
  app.use((req, res, next) => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); next(); });

  // â"€â"€ GET /webhook â€" verificaciÃ³n Meta â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  app.get('/webhook', (req, res) => {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    if (mode === 'subscribe' && token === config.verifyToken) {
      logger.log('âœ… Webhook verificado por Meta');
      return res.status(200).send(challenge);
    }
    logger.log(`âŒ VerificaciÃ³n fallida (token: ${token})`);
    res.sendStatus(403);
  });

  // â"€â"€ POST /webhook â€" mensajes entrantes â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

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

  // â"€â"€ GET /status â€" health check â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  app.get('/status', (req, res) => {
    res.json({
      ok: true,
      tenant: process.env.TENANT,
      phone: config.businessPhone,
      uptime: process.uptime()
    });
  });

  // â"€â"€ POST /shopify/order â€" webhook Shopify order_paid â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  app.post('/shopify/order', async (req, res) => {
    res.sendStatus(200); // Responder rÃ¡pido a Shopify
    try {
      const order = req.body;
      if (!order?.id) return;
      logger.log(`[shopify] Nuevo pedido: #${order.name} â€" ${order.financial_status}`);
      if (order.financial_status === 'paid') {
        await upsell.handleNewOrder(order, config);
      }
    } catch (err) {
      logger.log(`[shopify] Error webhook: ${err.message}`);
    }
  });

  // â"€â"€ GET /admin/prompt â€" ver prompt activo en memoria â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  app.get('/admin/prompt', async (req, res) => {
    const samplePrompt = await business.buildSystemPrompt({});
    res.json({ ok: true, length: samplePrompt.length, preview: samplePrompt.slice(0, 500) });
  });

  // â"€â"€ POST /admin/debug-context â€" ver contexto Redis de un nÃºmero â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  app.post('/admin/debug-context', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone requerido' });
    const ctx      = await memory.getContext(phone);
    const hist     = await memory.getHistory(phone, 5);
    const campaign = await memory.getCampaignContext(phone);
    res.json({ context: ctx, recentHistory: hist, campaignContext: campaign });
  });

  // â"€â"€ GET /admin/wa-template â€" ver estructura de un template WA â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
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

  // â"€â"€ GET /admin/logs â€" Ãºltimos logs del servidor â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  app.get('/admin/logs', (req, res) => {
    const n = parseInt(req.query.n) || 50;
    res.json({ logs: logger.getRecentLogs(n) });
  });

  // â"€â"€ POST /admin/reset-thread â€" forzar recreaciÃ³n de thread Slack â"€â"€â"€â"€â"€â"€â"€â"€
  app.post('/admin/reset-thread', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone requerido' });
    slack.phoneToThread.delete(phone);
    await slack.deleteThreadFromRedis(phone);
    logger.log(`[admin] Thread Slack reseteado para ${phone}`);
    res.json({ ok: true, phone });

  // (refresh-catalog duplicado removido — ver abajo)
  });

  // ── POST /admin/upsell/test-reminder ─────────────────────────────────────────
  app.post('/admin/upsell/test-reminder', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone requerido' });
    const upsellMod = require('./upsell');
    const mockOrder = { name: '#TEST-001', id: '0', customer: {} };
    const mockMatch = { par: { complemento: 'Advanced Repair Ampoule Conditioner', variantId: '0' } };
    await upsellMod.sendUpsellReminder(phone, mockOrder, mockMatch, config);
    res.json({ ok: true, phone });
  });

  // ── GET /admin/upsell/stats ───────────────────────────────────────────────────
  app.get('/admin/upsell/stats', async (req, res) => {
    const upsellStats = require('./upsell-stats');
    const days = parseInt(req.query.days) || 7;
    const events = await upsellStats.getEvents(days);
    const sent     = events.filter(e => e.type === 'sent').length;
    const accepted = events.filter(e => e.type === 'accepted').length;
    const paid     = events.filter(e => e.type === 'paid').length;
    const rejected = events.filter(e => e.type === 'rejected').length;
    const reverted = events.filter(e => e.type === 'reverted').length;
    const totalRevenue = events.filter(e => e.type === 'paid').reduce((s, e) => s + (e.data?.precio || 0), 0);
    res.json({ ok: true, days, sent, accepted, paid, rejected, reverted, totalRevenue,
      acceptRate: sent ? ((accepted/sent)*100).toFixed(1) : '0',
      payRate: accepted ? ((paid/accepted)*100).toFixed(1) : '0' });
  });

  // ── POST /admin/upsell/post-dashboard ────────────────────────────────────────
  app.post('/admin/upsell/post-dashboard', async (req, res) => {
    const upsellStats = require('./upsell-stats');
    const days = parseInt(req.body?.days) || 7;
    await upsellStats.postDashboard(days);
    res.json({ ok: true });
  });

  // ── POST /admin/reset-context â€" limpiar contexto de un nÃºmero (solo pruebas) â"€â"€
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

  // POST /admin/refresh-catalog - forzar recarga del catalogo Shopify (actualiza var del módulo)
  app.post('/admin/refresh-catalog', async (req, res) => {
    try {
      await shopify.invalidateCatalog();
      catalog = await shopify.getProductCatalog();
      logger.log('[admin] Catalogo recargado: ' + catalog.length + ' productos');
      res.json({ ok: true, products: catalog.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // â"€â"€ POST /admin/campaign-context â€" registrar contexto de campaÃ±a en Redis â"€â"€
  app.post('/admin/campaign-context', async (req, res) => {
    const { phone, campaign } = req.body;
    if (!phone || !campaign) return res.status(400).json({ error: 'phone y campaign requeridos' });
    await memory.setCampaignContext(phone, campaign);
    logger.log(`[campaign] Contexto guardado: ${phone} â†' "${campaign.name}"`);
    res.json({ ok: true, phone });
  });

  // â"€â"€ POST /admin/seed-thread â€" inyectar threadâ†'phone en Redis (one-time migration) â"€â"€
  app.post('/admin/seed-thread', async (req, res) => {
    const { phone, thread_ts, channel } = req.body;
    if (!phone || !thread_ts) return res.status(400).json({ error: 'phone y thread_ts requeridos' });
    const data = { thread_ts, channel: channel || config?.slackChannel || process.env.SLACK_CHANNEL_ID || 'C05FES87S9J', timestamp: Date.now() };
    slack.phoneToThread.set(phone, data);
    await slack.saveThreadExternal(phone, data);
    logger.log(`[seed] thread mapeado: ${phone} â†' ${thread_ts}`);
    res.json({ ok: true, phone, thread_ts });
  });

  // â"€â"€ POST /slack/events â€" recibir mensajes y comandos desde Slack â"€â"€â"€â"€â"€â"€â"€â"€â"€
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

    // â"€â"€ ReacciÃ³n en canal de learning â†' aplicar aprendizaje â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    if (event.type === 'reaction_added' && event.item?.channel === (process.env.SLACK_LEARNING_CHANNEL || 'C0APVLMV98Q')) {
      const reaction = event.reaction; // 'white_check_mark' o 'x'
      if (reaction === 'white_check_mark' || reaction === 'heavy_check_mark') {
        logger.log(`[learning] âœ… ReacciÃ³n aprobaciÃ³n en mensaje ${event.item.ts} â€" aplicando...`);
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

    // â"€â"€ Comando: tomar â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    if (text === 'tomar') {
      let phone = slack.handleSlackCommand('tomar', thread_ts);

      // Fallback: si el thread no está en RAM (ej: restart), leer el primer
      // mensaje del thread (el header) usando conversations.replies
      if (!phone) {
        try {
          const repliesRes = await axios.get(
            `https://slack.com/api/conversations.replies?channel=${channel}&ts=${thread_ts}&limit=1`,
            { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } }
          );
          // El primer mensaje de replies ES el padre (el header con el teléfono)
          const parentMsg = repliesRes.data?.messages?.[0];
          logger.log(`[tomar] Mensaje padre: ${parentMsg?.text?.substring(0, 100)}`);
          const match = parentMsg?.text?.match(/\+?(569\d{8})/);
          if (match) {
            phone = match[1];
            // Reconstruir entrada en phoneToThread para que el resto del sistema funcione
            const threadData = { thread_ts, headerTs: thread_ts, headerBase: `📱 *+${phone}*`, channel, timestamp: Date.now() };
            slack.phoneToThread.set(phone, threadData);
            // Registrar el handoff
            const handoffData = { thread_ts, takenAt: Date.now() };
            slack.activeConversations.set(phone, handoffData);
            logger.log(`[tomar] Thread reconstruido desde Slack para ${phone}`);
          } else {
            logger.log(`[tomar] No se encontró teléfono en el header del thread`);
          }
        } catch (e) {
          logger.log(`[tomar] Error recuperando thread padre: ${e.message}`);
        }
      }

      if (phone) {
        const operatorName = await slack.sendOperatorReply(phone, null, userId, config);
        logger.log(`👤 ${operatorName} tomó control de ${phone}`);
        // Actualizar header del thread
        const threadData = slack.phoneToThread.get(phone);
        if (threadData?.headerTs) {
          await slack.updateThreadHeader(phone, 'human', channel, threadData.headerTs, operatorName);
        }
        await postSlackMessage(channel, thread_ts, `👤 *${operatorName}* tomó el control. Bot pausado. Escribe \`soltar\` cuando termines.`);

        // ── Verificar ventana de 24h Meta ───────────────────────────────────
        // Si el último mensaje del cliente fue hace >23h, Meta no permite texto libre
        // → enviar template de reactivación automáticamente
        try {
          const history = await memory.getHistory(phone, 20);
          const lastClientMsg = history ? [...history].reverse().find(m => m.role === 'user' || m.role === 'client') : null;
          const horasSinActividad = lastClientMsg?.ts
            ? (Date.now() - lastClientMsg.ts) / (1000 * 60 * 60)
            : 999;

          if (horasSinActividad > 23) {
            logger.log(`[tomar] Ventana 24h expirada para ${phone} (${Math.round(horasSinActividad)}h) → enviando template reactivación`);
            // Obtener nombre del cliente desde contexto o Shopify
            const ctx = await memory.getContext(phone);
            const nombre = ctx?.name || ctx?.firstName || 'ahí';
            // Enviar template de reactivación
            const templateResult = await meta.sendTemplate(phone, 'atencion_cliente_yeppo', 'es', [
              { type: 'body', parameters: [{ type: 'text', text: nombre }] }
            ]);
            if (templateResult) {
              await memory.addMessage(phone, `[template enviado] Hola ${nombre}, el equipo de Yeppo está aquí para atenderte.`, 'bot');
              await postSlackMessage(channel, thread_ts, `📨 Ventana de 24h expirada (${Math.round(horasSinActividad)}h sin actividad) — se envió template de reactivación al cliente. Ya puedes continuar la conversación.`);
            } else {
              await postSlackMessage(channel, thread_ts, `⚠️ Ventana de 24h expirada (${Math.round(horasSinActividad)}h). El template de reactivación no se pudo enviar — puede que aún esté pendiente de aprobación por Meta.`);
            }
          }
        } catch (e) {
          logger.log(`[tomar] Error verificando ventana 24h: ${e.message}`);
        }
        // ───────────────────────────────────────────────────────────────────

      } else {
        await postSlackMessage(channel, thread_ts, `⚠️ No se pudo identificar la conversación. Asegúrate de escribir \`tomar\` en el thread del cliente.`);
      }
      return;
    }

    // â"€â"€ Comando: soltar â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    if (text === 'soltar') {
      let phone = slack.handleSlackCommand('soltar', thread_ts);

      // Fallback: reconstruir desde Slack si no está en RAM
      if (!phone) {
        try {
          const repliesRes = await axios.get(
            `https://slack.com/api/conversations.replies?channel=${channel}&ts=${thread_ts}&limit=1`,
            { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } }
          );
          const parentMsg = repliesRes.data?.messages?.[0];
          const match = parentMsg?.text?.match(/\+?(569\d{8})/);
          if (match) {
            phone = match[1];
            slack.activeConversations.delete(phone);
            logger.log(`[soltar] Handoff liberado desde fallback para ${phone}`);
          }
        } catch (e) {
          logger.log(`[soltar] Error recuperando thread padre: ${e.message}`);
        }
      }

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

    // â"€â"€ Comando: urgente â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
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

    // â"€â"€ Respuesta humana en thread â†' enviar al cliente con firma â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    for (const [phone, info] of slack.phoneToThread) {
      if (info.thread_ts === thread_ts) {
        const activeThread = slack.getActiveConversation(phone);
        const recentTake   = slack.getRecentTake(phone);

        if (activeThread || recentTake) {
          // Verificar ventana de 24h antes de enviar
          const history = await memory.getHistory(phone, 20);
          const lastClientMsg = history ? [...history].reverse().find(m => m.role === 'user' || m.role === 'client') : null;
          const horasSinRespuesta = lastClientMsg?.ts
            ? (Date.now() - lastClientMsg.ts) / (1000 * 60 * 60)
            : 999;

          if (horasSinRespuesta > 23) {
            // Ventana cerrada — no intentar enviar, avisar al operador
            await postSlackMessage(channel, thread_ts,
              `⏳ *Ventana de 24h cerrada* — la clienta aún no ha respondido al template de reactivación. En cuanto responda, podrás escribirle normalmente.`
            );
            logger.log(`[operador] Mensaje bloqueado para ${phone} — ventana 24h cerrada (${Math.round(horasSinRespuesta)}h)`);
          } else {
            // Ventana abierta — enviar normalmente
            const operatorName = await slack.sendOperatorReply(phone, event.text, userId, config);
            const msgToClient  = `${event.text}\n\n— ${operatorName}`;
            await meta.sendMessage(phone, msgToClient, config);
            logger.log(`📤 ${operatorName} respondió a ${phone}: ${event.text}`);
          }
        }
        break;
      }
    }
  });

  // â"€â"€ POST /slack/actions â€" botones interactivos (aprendizaje) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
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

  // â"€â"€ POST /admin/learning/inject â€" inyectar conversaciones de Slack â"€â"€â"€â"€â"€â"€â"€
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

  // â"€â"€ POST /admin/learning/run â€" forzar anÃ¡lisis manual â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  app.post('/admin/learning/run', async (req, res) => {
    const { date } = req.body;
    try {
      const result = await learning.runNow(date);
      res.json({ ok: true, suggestions: result?.suggestions?.length || 0 });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // â"€â"€ GET /admin/learning/kpis â€" mÃ©tricas de operadores â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  app.get('/admin/learning/kpis', async (req, res) => {
    const metrics = await learning.getAllOperatorMetrics();
    res.json({ ok: true, operators: metrics });
  });

  // â"€â"€ GET /admin/learning/faqs â€" ver FAQs aprendidas â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  app.get('/admin/learning/faqs', (req, res) => {
    res.json({ ok: true, faqs: learning.loadLearnedFaqs() });
  });

  // ── GET /admin/export-conversations ─────────────────────────────────
  // Exporta todas las conversaciones del tenant desde Redis.
  // GET /admin/export-conversations
  // GET /admin/export-conversations?min_turns=3
  app.get('/admin/export-conversations', async (req, res) => {
    const rc = memory.redis;
    if (!rc) return res.status(503).json({ error: 'Redis no disponible' });
    try {
      const prefix = (process.env.TENANT || '') + ':conv:';
      let cursor = 0;
      const keys = [];
      do {
        const result = await rc.scan(cursor, { MATCH: prefix + '*', COUNT: 100 });
        cursor = result.cursor;
        keys.push(...result.keys);
      } while (cursor !== 0);
      const minTurns = parseInt(req.query.min_turns || '0', 10);
      const conversations = [];
      for (const k of keys) {
        const raw = await rc.get(k);
        if (!raw) continue;
        const data = JSON.parse(raw);
        const history = data.history || [];
        if (history.length < minTurns) continue;
        conversations.push({ phone: k.replace(prefix, ''), turns: history.length, context: data.context || {}, history });
      }
      conversations.sort((a, b) => b.turns - a.turns);
      logger.log('[export-conversations] ' + conversations.length + ' convs exportadas');
      res.json({ total: conversations.length, exportedAt: new Date().toISOString(), conversations });
    } catch (e) {
      logger.log('[export-conversations] Error: ' + e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.listen(PORT, '0.0.0.0', () => {
    logger.log(`âœ… Servidor escuchando en 0.0.0.0:${PORT}`);
    // Pre-calentar catÃ¡logo en background al arrancar y guardar en módulo
    shopify.getProductCatalog().then(c => {
      catalog = c || [];
      logger.log(`[catalog] Precalentado: ${catalog.length} productos`);
    }).catch(e => logger.log(`[catalog] Error precalentando: ${e.message}`));
    // Iniciar cron de aprendizaje diario (20:00 Santiago) — solo para Yeppo
    if (process.env.TENANT === 'yeppo') {
      learning.startDailyCron();
      // Iniciar AMAC — Agente de Mejora Continua (viernes 18:00 Santiago)
      try {
        const amacRunner = require('./amac-runner');
        const amacConfig = require('../tenants/yeppo/amac.config');
        amacRunner.startCron(amacConfig, 'yeppo');
        logger.log('[amac] Cron semanal programado: viernes 18:00 Santiago');
      } catch (e) {
        logger.log('[amac] Error iniciando cron: ' + e.message);
      }
    }
    // Recuperar análisis de caca pendientes tras deploy (cola Redis)
    setTimeout(() => {
      recoverPendingPoopDeliveries()
        .then(() => logger.log('[poop] Recovery check completado'))
        .catch(e => logger.log(`[poop] Recovery error: ${e.message}`));
    }, 5000); // 5s para que Redis conecte primero
    // Cron diario de estadísticas upsell (09:00 Lun-Vie Santiago)
    try {
      const { CronJob } = require('cron');
      new CronJob('0 9 * * 1-5', async () => {
        const upsellStats = require('./upsell-stats');
        await upsellStats.postDashboard(1);
      }, null, true, 'America/Santiago');
      logger.log('[upsell-stats] Cron diario configurado (09:00 Lun-Vie)');
    } catch(e) { logger.log('[upsell-stats] Cron no disponible: ' + e.message); }
  });
}

// â"€â"€ Subir media de WhatsApp a Slack (nueva API v2) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
async function uploadMediaToSlack(phone, type, typeEmoji, caption, mediaUrl, mimeType, config) {
  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken) { logger.log('[media] Sin SLACK_BOT_TOKEN'); return; }

  // Resolver channel y thread_ts (mismo fallback que config.js)
  const threadData = slack.phoneToThread.get(phone);
  const channel    = threadData?.channel
                  || config?.slackChannel
                  || process.env.SLACK_CHANNEL_ID
                  || process.env.SLACK_CHANNEL_WHATSAPP;

  logger.log(`[media] upload â†' channel: ${channel}, thread: ${threadData?.thread_ts || 'nuevo'}`);

  try {
    // 1. Descargar imagen de Meta
    const buf64 = await meta.downloadMedia(mediaUrl);
    if (!buf64) { logger.log(`[media] No se pudo descargar ${type} de ${phone}`); return; }

    const binBuf  = Buffer.from(buf64, 'base64');
    const ext     = mimeType.split('/')[1]?.split(';')[0]?.split('+')[0] || type;
    const fname   = `media_${Date.now()}.${ext}`;
    const label   = `${typeEmoji} +${phone} enviÃ³ ${type}${caption ? ': "' + caption + '"' : ''}`;
    const axiosI  = require('axios');

    // 2. Solicitar URL de upload (nueva API Slack â€" params como query string, no JSON)
    const uploadParams = new URLSearchParams({ filename: fname, length: binBuf.length });
    const urlResp = await axiosI.post(
      `https://slack.com/api/files.getUploadURLExternal?${uploadParams}`,
      '',
      { headers: { Authorization: `Bearer ${slackToken}` }, timeout: 15000 }
    );

    if (!urlResp.data?.ok) {
      logger.log(`[media] getUploadURL error: ${urlResp.data?.error} â€" intentando anÃ¡lisis con Claude Vision`);

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
            if (description) slackText = `${label}\n> ðŸ" _DescripciÃ³n: ${description}_`;
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

// â"€â"€ Status updates â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
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

// â"€â"€ DeduplicaciÃ³n de mensajes â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
const processedMessages = new Map(); // messageId â†' timestamp
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



// â"€â"€ Mensaje entrante â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
async function handleMessage(message, value, config, business) {
  const from = message.from;
  const type = message.type;

  // Deduplicar â€" Meta puede reenviar el mismo webhook varias veces
  if (message.id && isDuplicate(message.id)) {
    logger.log(`âš ï¸ Mensaje duplicado ignorado: ${message.id}`);
    return;
  }

  // 🐾 POOP CTA — solo para tenant tupibox (texto)
  if (type === 'text' && process.env.TENANT === 'tupibox') {
    try {
      const poop = require('../tenants/tupibox/poop');
      const accessToken = config.accessToken || process.env.WHATSAPP_ACCESS_TOKEN;
      const poopResult = await poop.handleMessage(from, message, accessToken);
      if (poopResult && poopResult.handled) {
        logger.log(`🐾 Poop CTA detectado para ${from}`);
        await humanDelay(poopResult.reply.length);
        await meta.sendMessage(from, poopResult.reply, config);
        await memory.addMessage(from, message.text?.body || '', 'user');
        await memory.addMessage(from, poopResult.reply, 'bot');
        return;
      }
    } catch (e) {
      logger.log(`[poop] Error CTA: ${e.message}`);
    }
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
      logger.log(`ðŸŽ¤ Audio recibido de [${from}] â€" transcribiendo...`);
      const transcription = await audio.transcribeWhatsAppAudio(mediaId, config);
      if (transcription) {
        userText = transcription;
        isAudio  = true;
        logger.log(`ðŸŽ¤ TranscripciÃ³n: "${transcription.slice(0, 80)}"`);
      } else {
        logger.log(`âš ï¸ No se pudo transcribir audio de ${from}`);
        return;
      }
    }
  } else if (type === 'image' || type === 'document' || type === 'video' || type === 'sticker') {
    const mediaId   = message[type]?.id;
    const caption   = message[type]?.caption || '';
    const mediaInfo = mediaId ? await meta.getMediaUrl(mediaId, config) : null;
    const mimeType  = mediaInfo?.mimeType || 'application/octet-stream';
    const mediaUrl  = mediaInfo?.url || null;
    const typeEmoji = type === 'image' ? 'ðŸ-¼ï¸' : type === 'video' ? 'ðŸŽ¥' : type === 'sticker' ? 'ðŸŽ­' : 'ðŸ""';

    logger.log(`${typeEmoji} ${type} recibido de [${from}]${caption ? ` caption: "${caption}"` : ''}`);

    const activeThread = slack.getActiveConversation(from);

    // Si hay operador activo â†' subir foto al thread y salir
    if (activeThread) {
      if (mediaUrl) {
        await uploadMediaToSlack(from, type, typeEmoji, caption, mediaUrl, mimeType, config);
      }
      return;
    }

    // 🐾 POOP ANALYSIS — solo para tenant tupibox
    if (type === 'image' && process.env.TENANT === 'tupibox') {
      try {
        const poop = require('../tenants/tupibox/poop');
        const accessToken = config.accessToken || process.env.WHATSAPP_ACCESS_TOKEN;
        const poopResult = await poop.handleMessage(from, message, accessToken);
        if (poopResult && poopResult.handled) {
          logger.log(`🐾 Poop analysis: ${poopResult.result || 'waiting_photo'}`);

          // Acuse inmediato
          await humanDelay(poopResult.reply.length);
          await meta.sendMessage(from, poopResult.reply, config);
          await memory.addMessage(from, '[imagen caca]', 'user');
          await memory.addMessage(from, poopResult.reply, 'bot');

          // Si hay análisis diferido (delayedReply): enviar con delay ~2h, solo 08:00-22:00 Chile
          if (poopResult.delayedReply) {
            const delayMs  = getPoopAnalysisDelay();
            const deliverAt = new Date(Date.now() + delayMs).toISOString();
            logger.log(`🐾 Análisis programado en ${Math.round(delayMs/60000)} min para ${from} (entrega: ${deliverAt})`);

            // Persistir en Redis para sobrevivir deploys
            schedulePendingPoopDelivery(from, poopResult.delayedReply, poopResult.followUpReply, deliverAt, config);

            setTimeout(async () => {
              try {
                await meta.sendMessage(from, poopResult.delayedReply, config);
                await memory.addMessage(from, poopResult.delayedReply, 'bot');
                if (poopResult.followUpReply) {
                  await new Promise(r => setTimeout(r, 4000));
                  await meta.sendMessage(from, poopResult.followUpReply, config);
                }
                // Limpiar de Redis al entregar
                clearPendingPoopDelivery(from);
              } catch (e) {
                logger.log(`[poop] Error enviando análisis diferido: ${e.message}`);
              }
            }, delayMs);
          } else if (poopResult.followUpReply) {
            await new Promise(resolve => setTimeout(resolve, 3000));
            await meta.sendMessage(from, poopResult.followUpReply, config);
          }
          return;
        }
      } catch (e) {
        logger.log(`[poop] Error: ${e.message}`);
      }
    }
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
    logger.log(`âš ï¸ Tipo no soportado: ${type}`);
    return;
  }

  logger.log(`ðŸ"¨ [${from}] ${isAudio ? 'ðŸŽ¤ ' : ''}${userText}`);

  // Si enviÃ³ audio, marcar en contexto para que Claude lo sepa
  if (isAudio) {
    await memory.updateContext(from, { canSendAudio: true });
  }

  // Para imÃ¡genes, el historial ya fue guardado en el bloque de imagen â€" no duplicar
  if (!userText.startsWith('[imagen]')) {
    await memory.addMessage(from, userText, 'user');
  }

  // Enriquecer con datos del tenant (primera vez o si no hay contexto guardado)
  // Hook opcional: business.enrichContext(phone, savedContext) → object con campos a guardar
  const savedContext = await memory.getContext(from);
  if (typeof business.enrichContext === 'function' && !savedContext?.tenantEnriched) {
    try {
      const enriched = await business.enrichContext(from, savedContext);
      if (enriched && Object.keys(enriched).length > 0) {
        await memory.updateContext(from, { ...enriched, tenantEnriched: true });
        logger.log(`[tenant:enrichContext] ${from} enriquecido con ${Object.keys(enriched).length} campos`);
      } else {
        await memory.updateContext(from, { tenantEnriched: true });
      }
    } catch (e) {
      logger.log(`[tenant:enrichContext] error: ${e.message}`);
    }
  }

  // Enriquecer con datos de Shopify (primera vez o si no hay contexto guardado)
  let shopifyData = null;
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

  // Enriquecer con perfil de piel desde Klaviyo (una vez por usuario)
  if (!savedContext?.klaviyoSkinChecked) {
    klaviyo.getSkinProfile(from).then(async (skinProfile) => {
      if (skinProfile) {
        await memory.updateContext(from, { klaviyoSkinChecked: true, skinProfile });
        logger.log(`[klaviyo] Perfil de piel cargado: ${JSON.stringify(skinProfile)}`);
      } else {
        await memory.updateContext(from, { klaviyoSkinChecked: true });
      }
    }).catch(() => {});
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

// â"€â"€ Generar y enviar respuesta â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
// ─── Extracción de perfil de piel desde conversación ─────────────────────────
// Detecta si el cliente mencionó su tipo de piel, edad, preocupaciones, etc.
// Si hay info nueva, la guarda en Klaviyo de forma asíncrona (no bloquea).

// ─── Vocabulario controlado para Klaviyo ──────────────────────────────────────
// Valores predefinidos — SOLO estos valores se guardan en Klaviyo.
// Modificar aquí para agregar/quitar valores de segmentación.

const SKIN_VOCAB = {
  tipoPiel:       ['Grasa', 'Seca', 'Mixta', 'Normal', 'Sensible'],
  preocupaciones: ['Poros', 'Pigmentacion', 'Rojeces', 'Granos', 'Arrugas', 'Sebo', 'Ojeras'],
};

// Prompt que le pasamos a Claude para extraer datos estructurados de la conversación.
// Retorna JSON con campos estrictamente dentro del vocabulario controlado.
function buildSkinExtractionPrompt(conversation) {
  return `Analiza esta conversación de skincare y extrae datos del cliente si están presentes.

VOCABULARIO CONTROLADO — usa SOLO estos valores exactos:
- tipoPiel: ${SKIN_VOCAB.tipoPiel.join(' | ')} (o null si no se menciona)
- preocupaciones: array con valores de [${SKIN_VOCAB.preocupaciones.join(', ')}] (solo los que se mencionan)
- birthYear: año de nacimiento como número entero (inferir desde edad si la dice, ej: "tengo 32 años" → ${new Date().getFullYear() - 32})
- alergias: texto libre corto (máx 60 chars) con ingredientes/productos que le caen mal, o null

IMPORTANTE:
- Si la conversación NO menciona datos de piel, responde: {}
- Infiere inteligentemente: "zona T grasa" → tipoPiel: "Mixta", "granitos" → preocupaciones: ["Granos"]
- Si hay duda, omite el campo (no adivines)
- Responde SOLO JSON válido, sin explicación

CONVERSACIÓN:
${conversation}

JSON:`;
}

// Llama a Claude para extraer el perfil de piel de la conversación completa.
// Se ejecuta de forma asíncrona al final de cada mensaje (no bloquea la respuesta).

async function extractAndSaveSkinProfile(phone, userText, botReply, context, config) {
  if (!userText || userText.length < 5) return;

  // Solo procesar si la conversación tiene contenido de piel relevante
  // (chequeo rápido para no gastar tokens en conversaciones de pedidos/envíos)
  const combined = `${userText} ${botReply || ''}`.toLowerCase();
  const hasSkinSignal = /piel|acn[eé]|granos|manch|hidrat|bloqueador|serum|crema|rutina|tónico|contorno|espuma|limpiador|protector|ojeras|poros|arrugas|sebo|rojez|sensible|pigment/.test(combined);
  if (!hasSkinSignal) return;

  // Obtener historial completo para análisis contextual
  const history = await memory.getHistory(phone, 20);
  if (!history.length) return;

  const conversation = history.map(m =>
    `${m.role === 'user' ? 'Cliente' : 'Bot'}: ${m.text}`
  ).join('\n');

  // Llamar a Claude para extracción inteligente
  let extracted = {};
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const claudeKey = process.env.CLAUDE_API_KEY || config?.claudeApiKey;
    if (!claudeKey) return;

    const client = new Anthropic({ apiKey: claudeKey });
    const response = await client.messages.create({
      model: 'claude-3-haiku-20240307', // modelo más barato para extracción
      max_tokens: 200,
      messages: [{ role: 'user', content: buildSkinExtractionPrompt(conversation) }]
    });

    const raw = response.content[0]?.text?.trim();
    if (!raw || raw === '{}') return;

    extracted = JSON.parse(raw);
  } catch (e) {
    logger.log(`[klaviyo] Error extracción Claude: ${e.message}`);
    return;
  }

  if (!Object.keys(extracted).length) return;

  // Validar contra vocabulario controlado — descartar valores no permitidos
  const clean = {};
  if (extracted.tipoPiel && SKIN_VOCAB.tipoPiel.includes(extracted.tipoPiel)) {
    clean.tipoPiel = extracted.tipoPiel;
  }
  if (Array.isArray(extracted.preocupaciones)) {
    const validPreoc = extracted.preocupaciones.filter(p => SKIN_VOCAB.preocupaciones.includes(p));
    if (validPreoc.length) clean.preocupaciones = validPreoc.join(', ');
  }
  if (extracted.birthYear && Number.isInteger(extracted.birthYear) &&
      extracted.birthYear >= 1940 && extracted.birthYear <= new Date().getFullYear() - 13) {
    clean.edad = String(extracted.birthYear);
  }
  if (extracted.alergias && typeof extracted.alergias === 'string') {
    clean.alergias = extracted.alergias.slice(0, 60);
  }

  if (!Object.keys(clean).length) return;

  // No sobreescribir datos ya guardados en esta sesión
  const existing = context?.skinProfile || {};
  const toUpdate = {};
  for (const [k, v] of Object.entries(clean)) {
    if (!existing[k]) toUpdate[k] = v;
  }
  if (!Object.keys(toUpdate).length) return;

  logger.log(`[klaviyo] 🧴 Perfil de piel detectado para ${phone}: ${JSON.stringify(toUpdate)}`);
  const ok = await klaviyo.updateSkinProfile(phone, toUpdate);
  if (ok) {
    logger.log(`[klaviyo] ✅ Perfil guardado en Klaviyo para ${phone}`);
    await memory.updateContext(phone, { skinProfile: { ...existing, ...toUpdate } });
  } else {
    logger.log(`[klaviyo] ⚠️ Sin perfil Klaviyo para ${phone}`);
  }

  // Actualizar contexto local para no volver a preguntar en esta sesión
  const merged = { ...existing, ...toUpdate };
  await memory.updateContext(phone, { skinProfile: merged });
}

// ─── Detección de conversación no productiva (spam/bots) ─────────────────────
// Retorna true si el texto no tiene ninguna intención de negocio reconocible.
function isNonProductiveMessage(text) {
  if (!text || text.trim().length === 0) return true;
  const t = text.toLowerCase();

  // Patrones de spam/bot/conversación sin intención
  const spamPatterns = [
    /^[\p{Emoji}\s]+$/u,                    // solo emojis
    /^(hola|hi|hello|ola|hey|buenas?)[\s!.]*$/i,  // solo saludo genérico (sin pregunta)
    /^(jaja|jajaja|haha|xd|lol|uwu|owo)+[\s!.]*$/i,
    /^(ok|oka|dale|si|sí|no|ya|claro)[\s.!]*$/i,  // monosílabos sin contexto (solo si no hay historial)
    /^[a-z]{1,3}[\s.!]*$/i,                // mensajes de 1-3 letras sueltas
    /^(te quiero|te amo|me gustas|eres lindo|eres bonito)/i,
    /^(tú|tu|yo|me gusta|mi fav|fan de)/i,
    /^\p{Emoji}+\s*(oso|bear|gato|perro|cat|dog)\s*\p{Emoji}*$/iu,
  ];

  return spamPatterns.some(p => p.test(t.trim()));
}

// Detecta si Claude está preguntando lo mismo que antes (mismo tema sin respuesta útil)
function detectsRepetitiveQuestion(botReply, history) {
  if (!history || history.length < 4) return false;
  const replyLower = botReply.toLowerCase();

  // Keywords que indican que el bot está pidiendo info que ya debería tener
  const repeatKeywords = [
    'número de pedido', 'número de tu pedido', 'tu pedido',
    'tipo de piel', 'qué tipo de piel', 'cómo es tu piel',
    'qué buscas', 'en qué te puedo ayudar', 'cuéntame qué necesitas',
    'me puedes pasar', 'me pasas'
  ];

  // Contar cuántas veces el bot ha dicho algo similar en las últimas respuestas
  const botMessages = history.filter(m => m.role === 'bot').slice(-4).map(m => m.text?.toLowerCase() || '');
  for (const kw of repeatKeywords) {
    if (!replyLower.includes(kw)) continue;
    const prevCount = botMessages.filter(m => m.includes(kw)).length;
    if (prevCount >= 2) return true; // ya lo dijo 2+ veces antes
  }
  return false;
}

async function sendReply(from, userText, config, business, pendingMedia = null) {
  const history = await memory.getHistory(from, 10); // más historial para detección
  const context = await memory.getContext(from) || {};

  let replyText = '';
  let notifySlack = false;

  // ── FIX 3: Filtro conversación no productiva ─────────────────────────────
  // Si el mensaje no tiene intención de negocio reconocible
  if (isNonProductiveMessage(userText)) {
    const npCount = await memory.incrementNonProductiveCount(from);
    logger.log(`[non-productive] ${from} mensaje #${npCount}: "${userText.slice(0, 50)}"`);

    if (npCount >= 5) {
      // 5+ mensajes sin intención → cierre elegante
      const closeMsg = 'si tienes alguna consulta sobre productos o pedidos de Yeppo, con gusto te ayudo! :blush:';
      await memory.addMessage(from, closeMsg, 'bot');
      await humanDelay(closeMsg.length);
      await meta.sendMessage(from, closeMsg, config);
      await slack.logConversation(from, userText, closeMsg, config, context.shopifySlackInfo);
      // Resetear para no bloquear si después manda algo real
      await memory.resetNonProductiveCount(from);
      logger.log(`[non-productive] ${from} — cierre elegante enviado tras ${npCount} msgs sin intención`);
      return;
    }
    // < 5: dejar que Claude responda normalmente (puede ser saludo legítimo)
  } else {
    // Mensaje productivo → resetear contador
    await memory.resetNonProductiveCount(from);
  }

  // 1. LÃ³gica de negocio del tenant (reglas rÃ¡pidas, sin LLM)
  // Pasar phone y config en contexto para upsell handler
  const contextWithMeta = { ...context, _phone: from, _config: config };
  const quickResult = await business.quickReply(userText, contextWithMeta, history);
  if (quickResult) {
    replyText    = quickResult.text;
    notifySlack  = quickResult.notifySlack || false;
    // skipReply: el handler externo (ej. upsell) ya envÃ­a el mensaje â€" no hacer nada mÃ¡s
    if (quickResult.skipReply) {
      logger.log(`[reply] skipReply activo â€" respuesta delegada a handler externo`);
      return;
    }
  }

  // 2. Si el tenant pide IA o no hay respuesta rÃ¡pida â†' Claude
  if (!replyText || quickResult?.useAI) {
    let systemPrompt = await business.buildSystemPrompt(context);
    // Inyectar contexto Shopify al system prompt si existe
    if (context?.shopifyContext) {
      systemPrompt = `${systemPrompt}\n\n---\n${context.shopifyContext}`;
    }

    // Inyectar contexto de upsell pendiente para que Claude maneje respuestas ambiguas
    const upsellCtx = await memory.getUpsellPending(from);
    if (upsellCtx) {
      const upPrecio = upsellCtx.match && upsellCtx.match.precio
        ? ('$' + Math.round(upsellCtx.match.precio).toLocaleString('es-CL'))
        : 'ver en tienda';
      const upProducto = (upsellCtx.match && upsellCtx.match.producto) || 'producto';
      const upComplemento = (upsellCtx.match && upsellCtx.match.complemento) || 'complemento';
      systemPrompt += `\n\n---\n## Oferta pendiente de complemento\nEste cliente acaba de comprar "${upProducto}" y le ofreciste agregar "${upComplemento}" por ${upPrecio}.\nSu respuesta no fue un si/no claro - puede estar preguntando el precio, condiciones u otra duda.\nResponde esa duda con informacion real del catalogo si la tienes, y al final preguntale si desea agregarlo.\nCuando confirme explicitamente, el sistema lo procesa de forma automatica.`;
      logger.log('[upsell] Contexto inyectado en Claude para respuesta ambigua');
    }
    // Inyectar catÃ¡logo relevante si el cliente pregunta por productos/stock/precios
    // Buscar siempre en catálogo - Claude decide si usar la info o no
    {
    try {
        // Buscar por texto del cliente; si no hay match, usar historial reciente o top 5
        let matches = shopify.searchCatalog(catalog, userText);
        if (!matches.length) {
          const recentHist = await memory.getHistory(from, 3);
          const recentText = recentHist.map(m => m.content || '').join(' ');
          if (recentText) matches = shopify.searchCatalog(catalog, recentText, 3);
        }
        // (sin fallback - solo inyectar si hay match relevante)
        if (matches.length) {
          const catalogText = shopify.formatCatalogForPrompt(matches);
          systemPrompt += `\n\n---\n## Productos relevantes (datos en tiempo real de Shopify)\n${catalogText}\n\nUsa estos datos para responder sobre disponibilidad y precios. Si el producto que busca no aparece aquÃ­, di que no lo tienes disponible actualmente.`;
          logger.log(`[catalog] ${matches.length} productos inyectados para: "${userText.slice(0, 50)}"`);
        }
      } catch (e) {
        logger.log(`[catalog] Error: ${e.message}`);
      }
    }

    // Inyectar perfil de piel de Klaviyo si está disponible
    const skinCtx = context?.skinProfile;
    if (skinCtx && Object.keys(skinCtx).length) {
      let skinText = '\n\n---\n## Perfil de piel de esta clienta (guardado de conversaciones anteriores)\n';
      if (skinCtx.tipoPiel)          skinText += `- Tipo de piel: ${skinCtx.tipoPiel}\n`;
      if (skinCtx.preocupaciones)    skinText += `- Preocupaciones: ${skinCtx.preocupaciones}\n`;
      if (skinCtx.edad)              skinText += `- Edad aprox: ${skinCtx.edad}\n`;
      if (skinCtx.productosActuales) skinText += `- Productos que ya usa: ${skinCtx.productosActuales}\n`;
      if (skinCtx.alergias)          skinText += `- Alergias/sensibilidades: ${skinCtx.alergias}\n`;
      if (skinCtx.rutina)            skinText += `- Rutina actual: ${skinCtx.rutina}\n`;
      skinText += '\nUSA esta información para NO volver a preguntar lo que ya sabes de ella. Personaliza tu recomendación.';
      systemPrompt += skinText;
      logger.log(`[klaviyo] Perfil de piel inyectado en prompt (${Object.keys(skinCtx).length} campos)`);
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
      logger.log(`ðŸ¤- Claude respondiÃ³ (costo: $${aiResult.cost?.toFixed(4) || '?'})`);
    } else {
      replyText = aiResult.fallback || config.fallbackMessage;
    }
  }

  // 3. Guardar en memoria
  await memory.addMessage(from, replyText, 'bot');

  // 3b. Extraer perfil de piel via Claude (vocabulario controlado) — async, no bloquea
  extractAndSaveSkinProfile(from, userText, replyText, context, config).catch(() => {});

  // 3c. Hook post-respuesta del tenant (opcional — solo si está definido)
  if (typeof business.afterReply === 'function') {
    const freshHistory = await memory.getHistory(from, 6);
    business.afterReply(from, userText, replyText, freshHistory, context)
      .catch(e => logger.log(`[tenant:afterReply] ${e.message}`));
  }

  // 4. Delay humano
  await humanDelay(replyText.length);

  // 5. Enviar WhatsApp
  await meta.sendMessage(from, replyText, config);

  // 6. Log en Slack (supervisiÃ³n) â€" incluir info Shopify en primer mensaje
  const shopifySlackInfo = context?.shopifySlackInfo || null;

  // Detectar token [HANDOFF] - Claude lo emite cuando decide derivar al equipo
  if (!notifySlack && replyText && replyText.includes('[HANDOFF]')) {
    notifySlack = true;
    replyText = replyText.replace('[HANDOFF]', '').trim();
    await memory.resetRepeatCount(from);
    logger.log('[handoff] Claude derivo a operador via token [HANDOFF]');
  }

  // ── FIX 1: Auto-handoff por preguntas repetitivas ────────────────────────
  // Si el bot está pidiendo lo mismo 3+ veces sin avance → escalar al equipo
  if (!notifySlack && replyText) {
    const isRepeat = detectsRepetitiveQuestion(replyText, history);
    if (isRepeat) {
      const repeatCount = await memory.incrementRepeatCount(from);
      logger.log(`[repeat-detect] ${from} pregunta repetitiva #${repeatCount}: "${replyText.slice(0, 60)}"`);

      if (repeatCount >= 3) {
        // Escalar — agregar aviso al cliente y notificar Slack
        notifySlack = true;
        replyText += ' [HANDOFF]';
        replyText = replyText.replace('[HANDOFF]', '').trim();
        await memory.resetRepeatCount(from);
        logger.log(`[repeat-detect] ${from} — auto-handoff activado tras ${repeatCount} repeticiones`);
      }
    } else {
      // Respuesta avanzó el tema → resetear contador
      await memory.resetRepeatCount(from);
    }
  }

  if (notifySlack) {
    await slack.notifyHandoff(from, userText, config);
  } else {
    // Para imÃ¡genes, mostrar "ðŸ-¼ï¸ [imagen]" como texto del cliente en Slack
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

/**
 * Calcula el delay en ms para enviar el análisis de caca de forma realista.
 * Simula que un humano lo revisó: 2-3 horas en horario hábil (Lun-Vie 9-18 Chile).
 * Si ya es tarde (>16h) o fin de semana, programa para las 10h del próximo día hábil.
 */
function getPoopAnalysisDelay() {
  // Modo debug: variable POOP_DEBUG_DELAY en ms (ej: 30000 = 30 segundos)
  if (process.env.POOP_DEBUG_DELAY) {
    return parseInt(process.env.POOP_DEBUG_DELAY, 10);
  }

  const DELIVERY_DELAY_MS = 2 * 60 * 60 * 1000; // 2 horas fijas
  const HORA_INICIO = 8;   // 08:00 Chile
  const HORA_FIN    = 22;  // 22:00 Chile (no se entrega después de esta hora)

  const now       = new Date();
  const chileNow  = new Date(now.toLocaleString('en-US', { timeZone: 'America/Santiago' }));
  const tentative = new Date(chileNow.getTime() + DELIVERY_DELAY_MS);
  const hour      = tentative.getHours();

  // Si la entrega tentativa cae dentro del horario permitido (08:00–22:00) → OK
  // Funciona cualquier día de la semana (sábado y domingo incluidos)
  if (hour >= HORA_INICIO && hour < HORA_FIN) {
    return DELIVERY_DELAY_MS;
  }

  // Fuera de horario → posponer a las 08:00 del día siguiente (cualquier día)
  const next = new Date(tentative);
  if (hour >= HORA_FIN) {
    next.setDate(next.getDate() + 1);
  }
  next.setHours(HORA_INICIO, Math.floor(Math.random() * 20), 0, 0); // 08:00–08:20 con variación natural

  return next.getTime() - chileNow.getTime();
}

// ============================================================
// COLA PERSISTENTE DE ANÁLISIS DIFERIDOS (sobrevive deploys Railway)
// Clave Redis: poop:queue:{phone}
// ============================================================
async function schedulePendingPoopDelivery(phone, analysisText, followUp, deliverAt, config) {
  const redisClient = require('./memory').getRedisClient ? require('./memory').getRedisClient() : null;
  if (!redisClient) return;
  try {
    const payload = JSON.stringify({ analysisText, followUp: followUp || null, deliverAt, config });
    await redisClient.setEx(`poop:queue:${phone}`, 86400, payload); // TTL 24h
    logger.log(`[poop] Cola Redis: análisis guardado para ${phone}`);
  } catch(e) { logger.log(`[poop] Cola Redis error: ${e.message}`); }
}

async function clearPendingPoopDelivery(phone) {
  const redisClient = require('./memory').getRedisClient ? require('./memory').getRedisClient() : null;
  if (!redisClient) return;
  try { await redisClient.del(`poop:queue:${phone}`); } catch {}
}

async function recoverPendingPoopDeliveries() {
  const redisClient = require('./memory').getRedisClient ? require('./memory').getRedisClient() : null;
  if (!redisClient) return;
  try {
    const keys = await redisClient.keys('poop:queue:*');
    if (!keys.length) return;
    logger.log(`[poop] Recovery: ${keys.length} análisis pendientes encontrados`);
    for (const key of keys) {
      const phone = key.replace('poop:queue:', '');
      const val = await redisClient.get(key);
      if (!val) continue;
      const item = JSON.parse(val);
      const deliverAt = new Date(item.deliverAt);
      const now = new Date();
      let delayMs = deliverAt.getTime() - now.getTime();

      // Si ya pasó → recalcular respetando horario
      if (delayMs <= 0) delayMs = getPoopAnalysisDelay();

      // Si la nueva hora cae fuera del horario → ajustar
      const chileDeliverAt = new Date(now.getTime() + delayMs);
      const h = parseInt(chileDeliverAt.toLocaleString('en-US', { timeZone: 'America/Santiago', hour: 'numeric', hour12: false }));
      if (h >= 22 || h < 8) delayMs = getPoopAnalysisDelay();

      logger.log(`[poop] Recovery: ${phone} → entrega en ${Math.round(delayMs/60000)} min`);
      setTimeout(async () => {
        try {
          await meta.sendMessage(phone, item.analysisText, item.config);
          if (item.followUp) {
            await new Promise(r => setTimeout(r, 4000));
            await meta.sendMessage(phone, item.followUp, item.config);
          }
          await redisClient.del(key);
          logger.log(`✅ [poop] Recovery entregado a ${phone}`);
        } catch(e) { logger.log(`❌ [poop] Recovery error ${phone}: ${e.message}`); }
      }, delayMs);
    }
  } catch(e) { logger.log(`[poop] recoverPending error: ${e.message}`); }
}

async function postSlackMessage(channel, thread_ts, text) {
  const axios = require('axios');
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return;
  await axios.post('https://slack.com/api/chat.postMessage',
    { channel, thread_ts, text },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  ).catch(e => logger.log(`âš ï¸ Slack post error: ${e.message}`));
}

module.exports = { start };
