/**
 * generate_knowledge_v4.js
 * Combina conversaciones históricas de Crisp (583) + bot actual WhatsApp (71)
 * y genera un knowledge_doc.md actualizado con Claude.
 * 
 * Uso: node generate_knowledge_v4.js
 */

const fs   = require('fs');
const path = require('path');
const axios = require('axios');

const DEEPSEEK_KEY_PATH = path.join(__dirname, '../../../../../.secrets/deepseek_key.txt');
const DEEPSEEK_API_KEY  = fs.readFileSync(DEEPSEEK_KEY_PATH, 'utf8').trim();
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';

const OUT_DIR      = path.join(__dirname, '..', 'knowledge');
const KB_PATH      = path.join(OUT_DIR, 'knowledge_base.json');
const BOT_EXPORT   = path.join(__dirname, '../../../../../out/yeppo_conversations_export.json');

// ─── Cargar fuentes ────────────────────────────────────────────────────────
const crisp = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));
const botExport = JSON.parse(fs.readFileSync(BOT_EXPORT, 'utf8'));

// Convertir convs del bot a mismo formato que Crisp
const botConvs = botExport.conversations
  .filter(c => c.turns >= 2)
  .map(c => {
    const lines = c.history.map(h => {
      const role = h.role === 'user' ? 'Cliente' : 'Agente';
      return role + ': ' + h.text;
    }).join('\n');
    return {
      channel: 'urn:crisp.im:whatsapp:0',
      date: new Date(c.history[0]?.ts || Date.now()).toISOString().slice(0, 10),
      dialogue: lines,
      source: 'bot_actual'
    };
  });

console.log('Fuentes:');
console.log('  Crisp historico:', crisp.length, 'convs');
console.log('  Bot actual WhatsApp:', botConvs.length, 'convs');
console.log('  TOTAL:', crisp.length + botConvs.length, 'convs\n');

// ─── Limpiar texto ─────────────────────────────────────────────────────────
function clean(text) {
  return text
    .replace(/_\$\{color\}\[.*?\]\(.*?\)_/g, '')
    .replace(/---\s*\n/g, '')
    .replace(/\[link\]/g, '[enlace]')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\*\*/g, '')
    .trim();
}

const allConvs = [...crisp, ...botConvs]
  .map(c => ({ ...c, dialogue: clean(c.dialogue) }))
  .filter(c => c.dialogue.length > 80);

console.log('Despues de limpiar:', allConvs.length, 'convs utiles\n');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function callAI(userPrompt, systemPrompt, isFinal) {
  // Usar deepseek-v4-pro para todo (batches + sintesis final)
  const model = 'deepseek-v4-pro';
  const maxTokens = isFinal ? 8192 : 2048;
  const res = await axios.post(
    DEEPSEEK_BASE_URL + '/chat/completions',
    {
      model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    },
    {
      headers: {
        'Authorization': 'Bearer ' + DEEPSEEK_API_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 180000
    }
  );
  return res.data.choices[0].message.content;
}

const SYSTEM_BATCH = 'Eres un analista de atencion al cliente. Analiza estas conversaciones reales de Yeppo (tienda de cosmeticos coreanos en Patronato, Santiago) y extrae informacion util de forma concisa.';

async function processBatches(conversations, batchSize) {
  const results = [];
  const total = conversations.length;
  const size = batchSize || 40;

  for (let i = 0; i < total; i += size) {
    const batch = conversations.slice(i, i + size);
    const batchNum = Math.floor(i / size) + 1;
    const totalBatches = Math.ceil(total / size);
    process.stdout.write('  Batch ' + batchNum + '/' + totalBatches + ' (' + batch.length + ' convs)... ');

    const text = batch.map((c, idx) => '[' + (i + idx + 1) + '] ' + c.dialogue).join('\n\n---\n\n');

    try {
      const result = await callAI(
        'Analiza estas ' + batch.length + ' conversaciones y extrae de forma concisa:\n\n' +
        '1. PREGUNTAS FRECUENTES: pregunta exacta + respuesta tipica del equipo (con tono real)\n' +
        '2. POLITICAS mencionadas (despacho, devoluciones, horarios, mayoristas, etc.)\n' +
        '3. FRASES Y TONO: expresiones caracteristicas del equipo\n' +
        '4. SITUACIONES ESPECIALES: reclamos, problemas, como se resolvieron\n' +
        '5. PRODUCTOS mas consultados y como se explicaron\n\n' +
        'Solo extrae lo que REALMENTE aparece en estas conversaciones. Se especifico.\n\n' +
        'CONVERSACIONES:\n' + text,
        SYSTEM_BATCH,
        false
      );
      results.push(result);
      console.log('OK');
    } catch (e) {
      console.log('FAIL ' + e.message);
      results.push('');
    }

    if (i + size < total) await sleep(1500);
  }
  return results;
}

async function main() {
  // Separar por canal
  const byChannel = { chat: [], whatsapp: [], instagram: [], other: [] };
  for (const c of allConvs) {
    const ch = c.channel.replace('urn:crisp.im:', '').replace(':0', '');
    if (ch === 'chat') byChannel.chat.push(c);
    else if (ch === 'whatsapp') byChannel.whatsapp.push(c);
    else if (ch === 'instagram') byChannel.instagram.push(c);
    else byChannel.other.push(c);
  }

  console.log('Por canal:');
  console.log('  Chat:', byChannel.chat.length);
  console.log('  WhatsApp:', byChannel.whatsapp.length, '(incluye', botConvs.length, 'del bot actual)');
  console.log('  Instagram:', byChannel.instagram.length);
  console.log('  Otros:', byChannel.other.length);
  console.log();

  const allBatchResults = [];

  console.log('Procesando Chat web...');
  allBatchResults.push(...await processBatches(byChannel.chat));

  console.log('\nProcesando WhatsApp (historico + bot actual)...');
  allBatchResults.push(...await processBatches(byChannel.whatsapp));

  console.log('\nProcesando Instagram...');
  allBatchResults.push(...await processBatches(byChannel.instagram));

  if (byChannel.other.length > 0) {
    console.log('\nProcesando otros...');
    allBatchResults.push(...await processBatches(byChannel.other));
  }

  const combinedAnalysis = allBatchResults.filter(Boolean).join('\n\n===\n\n');

  // Guardar analisis intermedio por si la sintesis falla
  const intermedioPath = path.join(OUT_DIR, 'knowledge_batch_analysis.txt');
  fs.writeFileSync(intermedioPath, combinedAnalysis, 'utf8');
  console.log('Analisis intermedio guardado: ' + intermedioPath + ' (' + combinedAnalysis.length + ' chars)');

  console.log('\nGenerando documento final con DeepSeek...');

  const finalDoc = await callAI(
    'Tienes el analisis de ' + allConvs.length + ' conversaciones reales de atencion al cliente de Yeppo (cosmeticos coreanos, Patronato, Santiago). Estas incluyen conversaciones historicas de Crisp y conversaciones recientes del bot de WhatsApp.\n\n' +
    'ANALISIS DE TODOS LOS BATCHES:\n' + combinedAnalysis + '\n\n' +
    'Genera el DOCUMENTO FINAL DE CONOCIMIENTO para un agente de IA de WhatsApp.\n\n' +
    'REGLAS CRITICAS para el documento:\n' +
    '- Escribir TODO en texto plano, sin markdown (sin **, sin ##, sin bullets con -)\n' +
    '- Usar SOLO letras mayusculas para los titulos de seccion\n' +
    '- Las respuestas de ejemplo deben estar en el tono real del equipo (informal, sin formalidades, sin !)\n' +
    '- Incluir frases reales cuando las tengas\n\n' +
    'ESTRUCTURA OBLIGATORIA:\n\n' +
    'QUIENES SOMOS\n' +
    'PRODUCTOS Y SERVICIOS MAS CONSULTADOS\n' +
    'PREGUNTAS FRECUENTES Y COMO RESPONDERLAS (minimo 25 preguntas con respuesta en tono del equipo)\n' +
    'POLITICAS OPERATIVAS\n' +
    'TONO Y ESTILO DEL EQUIPO\n' +
    'MANEJO DE RECLAMOS\n' +
    'CUANDO DERIVAR A HUMANO\n\n' +
    'Al final agrega esta seccion EXACTAMENTE como esta escrita:\n\n' +
    'SORTEO BTS ARIRANG MAYO 2026\n\n' +
    'Durante mayo 2026, todos los clientes que compren $20.000 CLP o mas en cosmeticos (online o en tienda) participan automaticamente en el sorteo de entradas al concierto BTS World Tour ARIRANG.\n\n' +
    'Premio: Entrada Cancha Andes al concierto BTS World Tour ARIRANG (17 octubre 2026, Estadio Nacional) + Set Jumiso completo (Niacinamide 20 Serum + Blackhead Set + Cream).\n\n' +
    'Mecanica: Monto minimo $20.000 CLP en una o varias compras durante mayo. Sorteo el 29 de mayo 2026. Inscripcion en https://docs.google.com/forms/d/e/1FAIpQLSfXxYN6PY9Z2iaEua46BImqAzuVrmoJSjkhxM_yZh5WfeDd8A/viewform\n\n' +
    'Si el cliente pregunta por BTS, el sorteo o la promocion de mayo, explicar y entregar el link de inscripcion. Si el cliente acaba de comprar mas de $20.000, mencionarlo proactivamente.',
    'Eres un experto en atencion al cliente de Yeppo, tienda de cosmeticos coreanos en Santiago de Chile. Generas documentos de conocimiento para agentes de IA. El documento debe ser en texto plano sin markdown.',
    true
  );

  // Guardar
  const docPath = path.join(OUT_DIR, 'knowledge_doc.md');
  fs.writeFileSync(docPath, finalDoc, 'utf8');

  const stats = {
    generatedAt: new Date().toISOString(),
    conversationsProcessed: allConvs.length,
    crispConversations: crisp.length,
    botConversations: botConvs.length,
    batchesProcessed: allBatchResults.filter(Boolean).length,
    docLength: finalDoc.length
  };

  fs.writeFileSync(path.join(OUT_DIR, 'knowledge_stats.json'), JSON.stringify(stats, null, 2), 'utf8');

  console.log('\nDocumento guardado: ' + docPath);
  console.log('Tamano: ' + finalDoc.length + ' chars');
  console.log('Conversaciones procesadas: ' + allConvs.length + ' (Crisp: ' + crisp.length + ' + Bot: ' + botConvs.length + ')');
}

main().catch(e => {
  console.error('ERROR:', e.response?.data || e.message);
  process.exit(1);
});
