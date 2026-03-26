/**
 * generate_knowledge_doc_v3.js
 * Procesa las 583 conversaciones completas en batches de 40
 * y genera un knowledge_doc.md rico y representativo.
 */

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

const KEY_PATH       = path.join(__dirname, '../../../../../.secrets/claude_yeppo_key.txt');
const CLAUDE_API_KEY = fs.readFileSync(KEY_PATH, 'utf8').trim();
const CLAUDE_MODEL   = 'claude-haiku-4-5'; // Haiku para los batches (más barato), Sonnet para síntesis final

const OUT_DIR = path.join(__dirname, '..', 'knowledge');
const KB_PATH = path.join(OUT_DIR, 'knowledge_base.json');

const kb = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));
console.log(`Total conversaciones: ${kb.length}`);

// Limpiar texto
function clean(text) {
  return text
    .replace(/_\$\{color\}\[.*?\]\(.*?\)_/g, '')
    .replace(/---\s*\n/g, '')
    .replace(/\[link\]/g, '[enlace]')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\*\*/g, '')
    .trim();
}

const cleaned = kb
  .map(c => ({ ...c, dialogue: clean(c.dialogue) }))
  .filter(c => c.dialogue.length > 100);

console.log(`Después de filtrar: ${cleaned.length} conversaciones útiles\n`);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function callClaude(userPrompt, systemPrompt, model = CLAUDE_MODEL) {
  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    },
    {
      headers: {
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      timeout: 120000
    }
  );
  return res.data.content[0].text;
}

const SYSTEM_BATCH = `Eres un analista de atención al cliente. Analiza estas conversaciones reales de Yeppo (tienda de cosméticos coreanos en Patronato, Santiago) y extrae información útil de forma concisa.`;

// Procesar en batches de 40 conversaciones
async function processBatches(conversations, batchSize = 40) {
  const results = [];
  const total = conversations.length;

  for (let i = 0; i < total; i += batchSize) {
    const batch = conversations.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(total / batchSize);

    process.stdout.write(`  Batch ${batchNum}/${totalBatches} (${batch.length} convs)... `);

    const text = batch.map((c, idx) => `[${i + idx + 1}] ${c.dialogue}`).join('\n\n---\n\n');

    try {
      const result = await callClaude(
        `Analiza estas ${batch.length} conversaciones y extrae de forma concisa:

1. PREGUNTAS FRECUENTES: pregunta exacta + respuesta típica del equipo (con tono real)
2. POLÍTICAS mencionadas (despacho, devoluciones, horarios, mayoristas, etc.)
3. FRASES Y TONO: expresiones características del equipo
4. SITUACIONES ESPECIALES: reclamos, problemas, cómo se resolvieron
5. PRODUCTOS más consultados y cómo se explicaron

Solo extrae lo que REALMENTE aparece en estas conversaciones. Sé específico.

CONVERSACIONES:
${text}`,
        SYSTEM_BATCH,
        'claude-haiku-4-5'
      );

      results.push(result);
      console.log('✅');
    } catch (e) {
      console.log(`❌ ${e.message}`);
      results.push(''); // continuar aunque falle un batch
    }

    // Rate limiting
    if (i + batchSize < total) await sleep(1500);
  }

  return results;
}

async function main() {
  // Separar por canal para análisis más rico
  const byChannel = { chat: [], whatsapp: [], instagram: [], other: [] };
  for (const c of cleaned) {
    const ch = c.channel.replace('urn:crisp.im:', '').replace(':0', '');
    if (ch === 'chat') byChannel.chat.push(c);
    else if (ch === 'whatsapp') byChannel.whatsapp.push(c);
    else if (ch === 'instagram') byChannel.instagram.push(c);
    else byChannel.other.push(c);
  }

  console.log(`Chat: ${byChannel.chat.length} | WhatsApp: ${byChannel.whatsapp.length} | Instagram: ${byChannel.instagram.length} | Otros: ${byChannel.other.length}\n`);

  // Procesar cada canal
  const allBatchResults = [];

  console.log('Procesando Chat web...');
  const chatResults = await processBatches(byChannel.chat);
  allBatchResults.push(...chatResults);

  console.log('\nProcesando WhatsApp...');
  const waResults = await processBatches(byChannel.whatsapp);
  allBatchResults.push(...waResults);

  console.log('\nProcesando Instagram...');
  const igResults = await processBatches(byChannel.instagram);
  allBatchResults.push(...igResults);

  if (byChannel.other.length > 0) {
    console.log('\nProcesando otros...');
    const otherResults = await processBatches(byChannel.other);
    allBatchResults.push(...otherResults);
  }

  const combinedAnalysis = allBatchResults.filter(Boolean).join('\n\n===\n\n');

  console.log(`\nGenerando documento final con Claude Sonnet...`);

  const finalDoc = await callClaude(
    `Tienes el análisis de ${cleaned.length} conversaciones reales de atención al cliente de Yeppo (cosméticos coreanos, Patronato, Santiago).

ANÁLISIS DE TODOS LOS BATCHES:
${combinedAnalysis}

Genera el DOCUMENTO FINAL DE CONOCIMIENTO para un agente de IA de WhatsApp. 

REGLAS CRÍTICAS para el documento:
- Escribir TODO en texto plano, sin markdown (sin **, sin ##, sin bullets con -)
- Usar SOLO letras mayúsculas para los títulos de sección
- Las respuestas de ejemplo deben estar en el tono real del equipo (informal, sin formalidades, sin ¡)
- Incluir frases reales cuando las tengas

ESTRUCTURA:

QUIÉNES SOMOS
[descripción de Yeppo, tiendas, qué vende]

PRODUCTOS Y SERVICIOS MÁS CONSULTADOS
[los más frecuentes con descripción de cómo explicarlos]

PREGUNTAS FRECUENTES Y CÓMO RESPONDERLAS
[al menos 20 preguntas con respuesta en tono del equipo]

POLÍTICAS OPERATIVAS
[despacho, devoluciones, cambios, mayoristas, horarios, asesorías]

TONO Y ESTILO DEL EQUIPO
[cómo habla el equipo, qué decir y qué NO decir]

MANEJO DE RECLAMOS
[situaciones difíciles y cómo resolverlas]

CUÁNDO DERIVAR A HUMANO
[límites claros del agente]`,
    `Eres un experto en atención al cliente de Yeppo, tienda de cosméticos coreanos en Santiago de Chile. Generas documentos de conocimiento para agentes de IA. El documento debe ser en texto plano sin markdown.`,
    'claude-sonnet-4-6'
  );

  // Guardar
  const docPath = path.join(OUT_DIR, 'knowledge_doc.md');
  fs.writeFileSync(docPath, finalDoc, 'utf8');

  const stats = {
    generatedAt: new Date().toISOString(),
    conversationsProcessed: cleaned.length,
    batchesProcessed: allBatchResults.length,
    docLength: finalDoc.length
  };

  console.log(`\n✅ Documento guardado: ${docPath}`);
  console.log(`   Tamaño: ${finalDoc.length} chars`);
  console.log(`   Conversaciones procesadas: ${cleaned.length}`);
  console.log(`   Batches: ${allBatchResults.filter(Boolean).length}/${allBatchResults.length}`);

  // Guardar stats
  fs.writeFileSync(path.join(OUT_DIR, 'knowledge_stats.json'), JSON.stringify(stats, null, 2), 'utf8');
}

main().catch(e => {
  console.error('ERROR:', e.response?.data || e.message);
  process.exit(1);
});
