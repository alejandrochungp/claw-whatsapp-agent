/**
 * core/learning.js — Sistema de aprendizaje del bot
 *
 * Flujo:
 *   1. Al cerrar una conversación (soltar / timeout), se guarda en Redis como "para revisar"
 *   2. Cron diario (20:00 Santiago) analiza las conversaciones del día con Claude
 *   3. Propone FAQs aprendidas al canal #agente-aprendizaje en Slack
 *   4. Operadores aprueban/rechazan con botones interactivos
 *   5. Las aprobadas se guardan en learned_faqs.json
 *   6. learned_faqs.json se inyecta en el system prompt de Claude
 *
 * Métricas por operador (KPIs):
 *   - total_takeovers: veces que tomó control
 *   - approved_teachings: respuestas aprobadas que enseñó al bot
 *   - quality_score: approved / total (%)
 */

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

// ── Config ────────────────────────────────────────────────────────────────────
const LEARNING_CHANNEL = process.env.SLACK_LEARNING_CHANNEL || process.env.SLACK_CHANNEL_ID;
const SLACK_TOKEN      = process.env.SLACK_BOT_TOKEN;
const CLAUDE_KEY       = process.env.CLAUDE_API_KEY;
const CLAUDE_MODEL     = 'claude-sonnet-4-6';

// Ruta al archivo de FAQs aprendidas (se actualiza en caliente)
const FAQS_PATH = path.join(__dirname, '..', 'tenants', process.env.TENANT || 'yeppo', 'knowledge', 'learned_faqs.json');

// ── Redis ─────────────────────────────────────────────────────────────────────
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

// ── Guardar conversación para análisis ───────────────────────────────────────

/**
 * Registra una conversación terminada para análisis posterior.
 * Llamar desde slack.js al ejecutar "soltar" o al timeout de handoff.
 *
 * @param {string} phone
 * @param {Array}  messages   — array de { role: 'bot'|'human'|'client', text, ts, operatorId? }
 * @param {string} outcome    — 'bot_resolved' | 'human_resolved' | 'timeout'
 * @param {string} operatorId — Slack user_id del operador (si aplica)
 */
async function saveConversationForReview(phone, messages, outcome, operatorId = null) {
  const redis = await getRedis();
  if (!redis) return;

  const record = {
    phone,
    messages,
    outcome,
    operatorId,
    date: new Date().toISOString().split('T')[0], // YYYY-MM-DD
    ts: Date.now()
  };

  try {
    // Lista diaria: learning:convs:YYYY-MM-DD
    const today = record.date;
    await redis.rPush(`learning:convs:${today}`, JSON.stringify(record));
    await redis.expire(`learning:convs:${today}`, 30 * 24 * 3600); // 30 días
  } catch (e) {
    console.error('[learning] Error guardando conversación:', e.message);
  }
}

// ── Métricas por operador ─────────────────────────────────────────────────────

async function incrementOperatorMetric(operatorId, metric) {
  const redis = await getRedis();
  if (!redis || !operatorId) return;
  try {
    await redis.hIncrBy(`learning:operator:${operatorId}`, metric, 1);
    await redis.expire(`learning:operator:${operatorId}`, 365 * 24 * 3600); // 1 año
  } catch {}
}

async function getOperatorMetrics(operatorId) {
  const redis = await getRedis();
  if (!redis) return null;
  try {
    const data = await redis.hGetAll(`learning:operator:${operatorId}`);
    if (!data || !Object.keys(data).length) return null;
    const takeovers = parseInt(data.total_takeovers || 0);
    const approved  = parseInt(data.approved_teachings || 0);
    return {
      operatorId,
      total_takeovers:     takeovers,
      approved_teachings:  approved,
      rejected_teachings:  parseInt(data.rejected_teachings || 0),
      quality_score:       takeovers > 0 ? Math.round((approved / takeovers) * 100) : 0
    };
  } catch { return null; }
}

async function getAllOperatorMetrics() {
  const redis = await getRedis();
  if (!redis) return [];
  try {
    const keys = await redis.keys('learning:operator:*');
    const all  = [];
    for (const k of keys) {
      const id = k.replace('learning:operator:', '');
      const m  = await getOperatorMetrics(id);
      if (m) all.push(m);
    }
    return all.sort((a, b) => b.approved_teachings - a.approved_teachings);
  } catch { return []; }
}

// ── Cargar / guardar FAQs aprendidas (Redis-first, filesystem fallback) ──────

const REDIS_FAQS_KEY = 'learned_faqs';

async function loadLearnedFaqs() {
  try {
    // Intentar desde Redis primero (persiste entre deploys)
    const redisVal = await memory.redis?.get(REDIS_FAQS_KEY);
    if (redisVal) return JSON.parse(redisVal);
    // Fallback: leer desde archivo
    if (fs.existsSync(FAQS_PATH)) {
      const faqs = JSON.parse(fs.readFileSync(FAQS_PATH, 'utf8'));
      // Migrar a Redis si hay datos en archivo
      if (faqs.length > 0 && memory.redis) {
        await memory.redis.set(REDIS_FAQS_KEY, JSON.stringify(faqs));
      }
      return faqs;
    }
  } catch {}
  return [];
}

async function saveLearnedFaq(faq) {
  const faqs = await loadLearnedFaqs();
  // Evitar duplicados por pregunta similar
  const exists = faqs.some(f => f.question.toLowerCase() === faq.question.toLowerCase());
  if (!exists) {
    faqs.push({ ...faq, addedAt: new Date().toISOString() });
    // Guardar en Redis (persistente entre deploys)
    if (memory.redis) {
      await memory.redis.set(REDIS_FAQS_KEY, JSON.stringify(faqs));
    }
    // Guardar en archivo como backup
    try { fs.writeFileSync(FAQS_PATH, JSON.stringify(faqs, null, 2), 'utf8'); } catch {}
    console.log(`[learning] ✅ FAQ aprendida y guardada en Redis: "${faq.question.substring(0, 60)}"`);
  } else {
    console.log(`[learning] FAQ ya existía, ignorando duplicado`);
  }
  return faqs;
}

/**
 * Genera string con FAQs aprendidas para inyectar en el system prompt.
 */
async function getLearnedFaqsPrompt() {
  const faqs = await loadLearnedFaqs();
  if (!faqs.length) return '';
  const lines = faqs.map(f => `P: ${f.question}\nR: ${f.answer}`).join('\n\n');
  return `\n\nRESPUESTAS APRENDIDAS DEL EQUIPO\n\n${lines}`;
}

// ── Análisis diario con Claude ────────────────────────────────────────────────

async function analyzeConversations(dateStr) {
  const redis = await getRedis();
  if (!redis) return [];

  // Leer conversaciones del día
  const rawList = await redis.lRange(`learning:convs:${dateStr}`, 0, -1).catch(() => []);
  if (!rawList.length) {
    console.log(`[learning] No hay conversaciones para analizar el ${dateStr}`);
    return [];
  }

  const convs = rawList.map(r => JSON.parse(r));
  console.log(`[learning] Analizando ${convs.length} conversaciones del ${dateStr}...`);

  // Filtrar: solo las que tuvieron intervención humana
  const withHuman = convs.filter(c =>
    c.outcome === 'human_resolved' ||
    c.messages?.some(m => m.role === 'human')
  );

  if (!withHuman.length) {
    console.log('[learning] No hubo intervenciones humanas hoy.');
    return [];
  }

  // Limpiar texto de formato Slack antes de pasar a Claude
  function cleanText(text) {
    if (!text) return '';
    return text
      .replace(/:[\w_]+:/g, '')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/`[^`]+`/g, '')
      .replace(/Comandos.*$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // Preparar texto para Claude
  const convsText = withHuman.map((c, i) => {
    const msgs = (c.messages || []).map(m => {
      const who = m.role === 'client' ? 'Cliente'
                : m.role === 'bot'    ? 'Bot'
                :                      'Operador';
      return `${who}: ${cleanText(m.text)}`;
    }).filter(line => line.split(': ')[1]?.length > 3).join('\n');
    return `--- Conversación ${i+1} ---\n${msgs}`;
  }).join('\n\n');

  const prompt = `Analiza estas ${withHuman.length} conversaciones donde un operador humano tuvo que intervenir para atender a clientes de Yeppo (tienda de cosméticos coreanos).

Para cada caso donde el operador dio una BUENA respuesta que el bot no supo dar, extrae:
1. La pregunta o situación del cliente
2. La respuesta ideal del operador
3. Una versión resumida lista para que el bot la aprenda

CONVERSACIONES:
${convsText}

Responde en JSON con este formato exacto:
{
  "suggestions": [
    {
      "question": "pregunta tipo del cliente",
      "bot_failed": "qué dijo el bot (o vacío si no respondió)",
      "human_answer": "respuesta exacta del operador",
      "suggested_answer": "respuesta sugerida para el bot (concisa, tono Yeppo)",
      "category": "horarios|productos|despacho|devoluciones|reclamos|otro",
      "confidence": "alta|media|baja"
    }
  ],
  "summary": "resumen en 2 líneas de lo que pasó hoy"
}

Solo incluir casos con confidence alta o media. Máximo 5 sugerencias.`;

  try {
    const res = await axios.post('https://api.anthropic.com/v1/messages', {
      model: CLAUDE_MODEL,
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    }, {
      headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
      timeout: 60000
    });

    const text = res.data.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('[learning] Error Claude:', e.message);
    return [];
  }
}

// ── Enviar sugerencias a Slack ────────────────────────────────────────────────

async function postLearningReport(analysis, dateStr) {
  if (!SLACK_TOKEN || !LEARNING_CHANNEL) return;
  if (!analysis?.suggestions?.length) {
    // Igual postear resumen aunque no haya sugerencias
    await postToSlack({
      channel: LEARNING_CHANNEL,
      text: `📊 *Reporte de aprendizaje — ${dateStr}*\n\n✅ El bot resolvió todo sin intervención humana hoy. Nada nuevo que enseñar.`
    });
    return;
  }

  // Header del reporte
  await postToSlack({
    channel: LEARNING_CHANNEL,
    text: `📊 *Reporte de aprendizaje — ${dateStr}*\n\n${analysis.summary || ''}\n\n*${analysis.suggestions.length} nueva(s) respuesta(s) para revisar:*`
  });

  // Una tarjeta por sugerencia con botones Aprobar/Editar/Rechazar
  for (let i = 0; i < analysis.suggestions.length; i++) {
    const s = analysis.suggestions[i];
    const emoji = s.confidence === 'alta' ? '🟢' : '🟡';
    const payload = Buffer.from(JSON.stringify({
      question: s.question,
      answer: s.suggested_answer,
      category: s.category,
      date: dateStr
    })).toString('base64');

    await postToSlack({
      channel: LEARNING_CHANNEL,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${emoji} *Sugerencia ${i+1}* — _${s.category}_\n\n*Cliente preguntó:* ${s.question}\n\n*Bot respondió:* ${s.bot_failed || '_No respondió_'}\n\n*Operador respondió:* ${s.human_answer}\n\n*✨ Respuesta sugerida para el bot:*\n>${s.suggested_answer}`
          }
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: '✅ Aprobar' },
              style: 'primary',
              value: payload,
              action_id: `learning_approve_${i}`
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: '✏️ Editar' },
              value: payload,
              action_id: `learning_edit_${i}`
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: '❌ Rechazar' },
              style: 'danger',
              value: payload,
              action_id: `learning_reject_${i}`
            }
          ]
        },
        { type: 'divider' }
      ]
    });

    await new Promise(r => setTimeout(r, 500));
  }
}

function postToSlack(payload) {
  return axios.post('https://slack.com/api/chat.postMessage', payload, {
    headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' }
  }).catch(e => console.error('[learning] Slack error:', e.message));
}

// ── Manejar acción de botón desde Slack ──────────────────────────────────────

/**
 * Llamar desde server.js cuando llega una acción de botón de Slack.
 * @param {object} action  — { action_id, value, user }
 * @param {string} channel
 * @param {string} message_ts
 */
async function handleSlackAction(action, channel, message_ts) {
  const actionType = action.action_id.startsWith('learning_approve') ? 'approve'
                   : action.action_id.startsWith('learning_edit')    ? 'edit'
                   : 'reject';

  const operatorId = action.user?.id;

  let faqData;
  try {
    faqData = JSON.parse(Buffer.from(action.value, 'base64').toString('utf8'));
  } catch {
    console.error('[learning] Error decodificando valor del botón');
    return;
  }

  if (actionType === 'approve') {
    saveLearnedFaq({ question: faqData.question, answer: faqData.answer, category: faqData.category });
    await incrementOperatorMetric(operatorId, 'approved_teachings');

    // Actualizar el mensaje en Slack
    await axios.post('https://slack.com/api/chat.update', {
      channel,
      ts: message_ts,
      text: `✅ *Aprobado* por <@${operatorId}> — el bot ya sabe responder esto.\n\n*P:* ${faqData.question}\n*R:* ${faqData.answer}`,
      blocks: []
    }, { headers: { Authorization: `Bearer ${SLACK_TOKEN}` } }).catch(() => {});

  } else if (actionType === 'reject') {
    await incrementOperatorMetric(operatorId, 'rejected_teachings');

    await axios.post('https://slack.com/api/chat.update', {
      channel,
      ts: message_ts,
      text: `❌ *Rechazado* por <@${operatorId}>`,
      blocks: []
    }, { headers: { Authorization: `Bearer ${SLACK_TOKEN}` } }).catch(() => {});

  } else if (actionType === 'edit') {
    // Abrir modal de edición (Slack modal)
    await axios.post('https://slack.com/api/views.open', {
      trigger_id: action.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'learning_edit_submit',
        private_metadata: JSON.stringify({ channel, message_ts, operatorId, faqData }),
        title: { type: 'plain_text', text: 'Editar respuesta' },
        submit: { type: 'plain_text', text: 'Guardar' },
        close:  { type: 'plain_text', text: 'Cancelar' },
        blocks: [
          {
            type: 'input',
            block_id: 'question_block',
            element: {
              type: 'plain_text_input',
              action_id: 'question_input',
              initial_value: faqData.question
            },
            label: { type: 'plain_text', text: 'Pregunta del cliente' }
          },
          {
            type: 'input',
            block_id: 'answer_block',
            element: {
              type: 'plain_text_input',
              action_id: 'answer_input',
              multiline: true,
              initial_value: faqData.answer
            },
            label: { type: 'plain_text', text: 'Respuesta del bot' }
          }
        ]
      }
    }, { headers: { Authorization: `Bearer ${SLACK_TOKEN}` } }).catch(e => {
      console.error('[learning] Error abriendo modal:', e.response?.data || e.message);
    });
  }
}

/**
 * Manejar envío del modal de edición.
 */
async function handleEditSubmit(payload) {
  const meta       = JSON.parse(payload.view.private_metadata);
  const question   = payload.view.state.values.question_block.question_input.value;
  const answer     = payload.view.state.values.answer_block.answer_input.value;
  const operatorId = meta.operatorId || payload.user?.id;

  saveLearnedFaq({ question, answer, category: meta.faqData?.category || 'otro' });
  await incrementOperatorMetric(operatorId, 'approved_teachings');

  // Actualizar el mensaje original
  await axios.post('https://slack.com/api/chat.update', {
    channel: meta.channel,
    ts: meta.message_ts,
    text: `✅ *Aprobado y editado* por <@${operatorId}>\n\n*P:* ${question}\n*R:* ${answer}`,
    blocks: []
  }, { headers: { Authorization: `Bearer ${SLACK_TOKEN}` } }).catch(() => {});
}

// ── Cron diario ───────────────────────────────────────────────────────────────

let cronRunning = false;

/**
 * Iniciar cron interno. Corre cada día a las 20:00 hora Chile.
 * No requiere dependencias externas — usa setTimeout recursivo.
 */
function startDailyCron() {
  console.log('[learning] Cron de aprendizaje iniciado');
  schedulNextRun();
}

function schedulNextRun() {
  const now      = new Date();
  // Calcular próxima ejecución a las 20:00 Santiago (UTC-3)
  const next     = new Date();
  next.setUTCHours(23, 0, 0, 0); // 20:00 Santiago = 23:00 UTC
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);

  const msUntil = next - now;
  console.log(`[learning] Próximo análisis: ${next.toISOString()} (en ${Math.round(msUntil / 60000)} min)`);

  setTimeout(async () => {
    if (cronRunning) return;
    cronRunning = true;
    try {
      const today = new Date().toISOString().split('T')[0];
      console.log(`[learning] Ejecutando análisis diario para ${today}...`);
      const analysis = await analyzeConversations(today);
      await postLearningReport(analysis, today);
      console.log('[learning] Análisis diario completado ✅');
    } catch (e) {
      console.error('[learning] Error en cron:', e.message);
    } finally {
      cronRunning = false;
      schedulNextRun(); // Reprogramar para mañana
    }
  }, msUntil);
}

/**
 * Endpoint para forzar el análisis manualmente (para testing).
 */
async function runNow(dateStr) {
  const date = dateStr || new Date().toISOString().split('T')[0];
  console.log(`[learning] Análisis manual para ${date}...`);
  const analysis = await analyzeConversations(date);
  await postLearningReport(analysis, date);
  return analysis;
}

// ── Aplicar aprendizaje desde reacción en Slack ─────────────────────────────
// Se llama cuando alguien reacciona ✅ a un mensaje de sugerencia en el canal de learning
async function applyApprovedMessage(messageTs, channelId) {
  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken) return;

  try {
    // 1. Obtener el mensaje específico
    const r = await axios.get('https://slack.com/api/conversations.replies', {
      params: { channel: channelId, ts: messageTs, limit: 1, inclusive: true },
      headers: { Authorization: `Bearer ${slackToken}` }
    });

    if (!r.data.ok || !r.data.messages?.length) {
      console.log('[learning] No se pudo obtener el mensaje:', r.data.error);
      return;
    }

    const msg = r.data.messages[0];

    // Solo procesar si es un mensaje de sugerencia (tiene el formato esperado)
    const respuestaMatch = msg.text?.match(/\*Respuesta sugerida para el bot:\*\s*\n_(.+?)_/s);
    const situacionMatch = msg.text?.match(/\*Situación:\*\s*([^\n]+)/);
    if (!respuestaMatch) {
      console.log('[learning] Mensaje no tiene formato de sugerencia, ignorando');
      return;
    }

    const situacion = situacionMatch?.[1]?.trim() || 'Sin descripción';
    const respuesta = respuestaMatch[1].trim();

    // 2. Agregar al prompt.md
    const promptPath = path.join(__dirname, '..', 'tenants', process.env.TENANT || 'yeppo', 'prompt.md');
    let prompt = fs.readFileSync(promptPath, 'utf8');

    const LEARNING_MARKER = 'APRENDIZAJES DEL EQUIPO';
    const newEntry = `Situación: ${situacion}\nRespuesta: ${respuesta}\n\n`;

    if (prompt.includes(LEARNING_MARKER)) {
      // Insertar antes del final de la sección
      const idx = prompt.lastIndexOf(newEntry.substring(0, 20));
      if (idx !== -1) {
        console.log('[learning] Esta sugerencia ya estaba en el prompt, ignorando');
        return;
      }
      prompt = prompt.replace(
        /(APRENDIZAJES DEL EQUIPO[\s\S]*?)(\s*$)/,
        (_, section) => section + newEntry
      );
    } else {
      prompt += `\n\nAPRENDIZAJES DEL EQUIPO\n\nEstas son respuestas reales del equipo aprobadas para situaciones específicas:\n\n${newEntry}`;
    }

    fs.writeFileSync(promptPath, prompt, 'utf8');
    console.log(`[learning] ✅ Aprendizaje agregado al prompt en RAM: ${situacion.substring(0, 60)}`);

    // 3. Push a GitHub via API (no requiere git instalado en Railway)
    try {
      const githubToken = process.env.GITHUB_TOKEN;
      const tenant = process.env.TENANT || 'yeppo';
      const filePath = `tenants/${tenant}/prompt.md`;
      const repo = process.env.GITHUB_REPO || 'alejandrochungp/claw-whatsapp-agent';

      if (githubToken) {
        // Obtener SHA actual del archivo
        const fileRes = await axios.get(`https://api.github.com/repos/${repo}/contents/${filePath}`, {
          headers: { Authorization: `Bearer ${githubToken}`, 'User-Agent': 'yeppo-learning-bot' }
        });
        const sha = fileRes.data.sha;

        // Subir archivo actualizado
        const content = Buffer.from(prompt, 'utf8').toString('base64');
        await axios.put(`https://api.github.com/repos/${repo}/contents/${filePath}`, {
          message: `learning: aprendizaje aprobado via reacción Slack\n\nSituación: ${situacion.substring(0, 80)}`,
          content,
          sha
        }, {
          headers: { Authorization: `Bearer ${githubToken}`, 'User-Agent': 'yeppo-learning-bot', 'Content-Type': 'application/json' }
        });
        console.log('[learning] ✅ Pusheado a GitHub via API — Railway redesplegará automáticamente');
      } else {
        console.log('[learning] GITHUB_TOKEN no configurado — aprendizaje solo en RAM hasta próximo deploy');
      }
    } catch (e) {
      console.log('[learning] Error push GitHub:', e.response?.data?.message || e.message);
    }

    // 4. Confirmar en Slack con emoji ✍️ en el mensaje
    await axios.post('https://slack.com/api/reactions.add', {
      channel: channelId,
      timestamp: messageTs,
      name: 'pencil'
    }, { headers: { Authorization: `Bearer ${slackToken}`, 'Content-Type': 'application/json' } }).catch(() => {});

  } catch (e) {
    console.error('[learning] applyApprovedMessage error:', e.message);
  }
}

module.exports = {
  saveConversationForReview,
  getLearnedFaqsPrompt,
  loadLearnedFaqs,
  handleSlackAction,
  handleEditSubmit,
  getOperatorMetrics,
  getAllOperatorMetrics,
  incrementOperatorMetric,
  startDailyCron,
  runNow,
  applyApprovedMessage
};
