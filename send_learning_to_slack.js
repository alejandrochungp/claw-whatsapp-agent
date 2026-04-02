/**
 * send_learning_to_slack.js
 * Corre el análisis de learning localmente y envía sugerencias al canal Slack
 */
const fs     = require('fs');
const path   = require('path');
const axios  = require('axios');

const SLACK_TOKEN    = fs.readFileSync(path.join(__dirname, '../../.secrets/slack_yeppo_token.txt'), 'utf8').trim();
const LEARNING_CHANNEL = 'C0APVLMV98Q';
const CLAUDE_API_KEY = fs.readFileSync(path.join(__dirname, '../../.secrets/claude_yeppo_key.txt'), 'utf8').trim();
const CLAUDE_MODEL   = 'claude-sonnet-4-6';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function callClaude(prompt) {
  const res = await axios.post('https://api.anthropic.com/v1/messages', {
    model: CLAUDE_MODEL,
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }]
  }, {
    headers: { 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
    timeout: 60000
  });
  return res.data.content[0].text;
}

async function slackPost(channel, text, thread_ts = null) {
  const body = { channel, text };
  if (thread_ts) body.thread_ts = thread_ts;
  const r = await axios.post('https://slack.com/api/chat.postMessage', body, {
    headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' }
  });
  return r.data;
}

// Limpiar formato Slack de los mensajes
function cleanSlack(text) {
  return (text || '')
    .replace(/:[\w_]+:/g, '')           // emojis :emoji:
    .replace(/\*([^*]+)\*/g, '$1')      // *negrita*
    .replace(/<@[A-Z0-9]+>/g, '')       // menciones
    .replace(/`[^`]+`/g, '')            // código inline
    .replace(/^\s*[-•]\s*/gm, '')       // bullets
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function main() {
  // Cargar conversaciones guardadas
  const convsRaw = fs.readFileSync(path.join(__dirname, '../../slack_conversations_ayer.json'), 'utf8');
  const convs = JSON.parse(convsRaw);
  console.log(`Conversaciones cargadas: ${convs.length}`);

  // Construir texto limpio de cada conversación
  const convsText = convs.map((conv, i) => {
    // Formato: { dialogue: "bot: ...\nclient: ...\noperator: ..." }
    const dialogue = cleanSlack(conv.dialogue || conv.text || '');
    // Simplificar etiquetas
    const cleaned = dialogue
      .replace(/^bot:\s*/gim, 'BOT: ')
      .replace(/^client:\s*/gim, 'CLIENTE: ')
      .replace(/^human_operator:\s*/gim, 'OPERADOR: ')
      .replace(/^\s*\n/gm, '');
    return `=== Conversación ${i + 1} ===\n${cleaned.substring(0, 2000)}`;
  }).join('\n\n');

  console.log('Analizando con Claude...');

  const prompt = `Analiza estas conversaciones reales de atención al cliente de Yeppo (cosméticos coreanos, Santiago).

Identifica casos donde un OPERADOR HUMANO tomó el control y dio una respuesta de alta calidad que el bot debería aprender.

FORMATO DE RESPUESTA — MUY IMPORTANTE:
Devuelve EXACTAMENTE este formato JSON y nada más. Sin texto antes ni después:

[
  {
    "situacion": "descripción breve de qué preguntó el cliente",
    "fallo_bot": "por qué el bot falló o no estaba",
    "respuesta_sugerida": "respuesta completa que debería dar el bot, en tono del equipo (informal, sin ¡, con emojis naturales, como habla el equipo real)",
    "categoria": "productos|despacho|reclamos|horarios|otros"
  }
]

Máximo 6 sugerencias. Solo los casos donde hay respuesta humana real de calidad.

CONVERSACIONES:
${convsText}`;

  const analysis = await callClaude(prompt);
  console.log(`Análisis generado: ${analysis.length} chars`);

  // Enviar header al canal de learning
  const header = await slackPost(
    LEARNING_CHANNEL,
    `🧠 *Análisis de aprendizaje — conversaciones del 25/03/2026*\n\n${convs.length} conversaciones analizadas. Revisa cada sugerencia y reacciona con ✅ para aprobar o ❌ para rechazar.\n\n_Las respuestas aprobadas se agregarán al prompt del bot automáticamente._`
  );

  if (!header.ok) {
    console.error('Error enviando header:', header.error);
    return;
  }

  const thread_ts = header.ts;
  console.log(`Thread creado: ${thread_ts}`);

  // Parsear JSON y enviar cada sugerencia como mensaje separado
  let suggestions = [];
  try {
    const jsonMatch = analysis.match(/\[[\s\S]*\]/);
    if (jsonMatch) suggestions = JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.log('JSON parse error, intentando split manual...');
    // Fallback: enviar todo junto
    suggestions = [{ situacion: 'Ver análisis completo', fallo_bot: '', respuesta_sugerida: analysis, categoria: 'otros' }];
  }

  console.log(`Enviando ${suggestions.length} sugerencias al thread...`);

  const EMOJIS = { productos: '💄', despacho: '📦', reclamos: '⚠️', horarios: '🕐', otros: '💬' };

  for (let i = 0; i < suggestions.length; i++) {
    const s = suggestions[i];
    const emoji = EMOJIS[s.categoria] || '💬';
    const text = `${emoji} *Sugerencia ${i + 1}/${suggestions.length}* — ${s.categoria.toUpperCase()}

*Situación:* ${s.situacion}

*Por qué falló el bot:* ${s.fallo_bot || 'No estaba activo'}

*Respuesta sugerida para el bot:*
_${s.respuesta_sugerida}_

Reacciona ✅ para aprobar o ❌ para rechazar`;

    await slackPost(LEARNING_CHANNEL, text, thread_ts);
    console.log(`  Sugerencia ${i + 1}/${suggestions.length} ✅`);
    await sleep(800);
  }

  // Footer
  await slackPost(
    LEARNING_CHANNEL,
    `_Fin del análisis. ${suggestions.length} sugerencias para revisar._\nReacciona a cada mensaje individual con ✅ o ❌`,
    thread_ts
  );

  console.log(`\n✅ ${suggestions.length} sugerencias enviadas al canal de learning`);
}

main().catch(e => console.error('Error:', e.response?.data || e.message));
