/**
 * generate_knowledge_doc.js
 * Lee knowledge_base.json y genera documento de conocimiento con Claude
 */

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

const KEY_PATH = path.join(__dirname, '../../../../../.secrets/claude_yeppo_key.txt');
const CLAUDE_API_KEY = fs.readFileSync(KEY_PATH, 'utf8').trim();
const CLAUDE_MODEL   = 'claude-sonnet-4-6';

const OUT_DIR = path.join(__dirname, '..', 'knowledge');
const KB_PATH = path.join(OUT_DIR, 'knowledge_base.json');

const kb = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));
console.log(`Cargadas ${kb.length} conversaciones`);

// Limpiar artefactos
function clean(text) {
  return text
    .replace(/_\$\{color\}\[.*?\]\(.*?\)_/g, '')
    .replace(/---\s*\n/g, '')
    .replace(/\[link\]/g, '[enlace]')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const cleaned = kb
  .map(c => ({ ...c, dialogue: clean(c.dialogue) }))
  .filter(c => c.dialogue.length > 80);

console.log(`Después de filtrar: ${cleaned.length}`);

// Agrupar por canal
const byChannel = {};
for (const c of cleaned) {
  const ch = c.channel.replace('urn:crisp.im:', '').replace(':0', '');
  if (!byChannel[ch]) byChannel[ch] = [];
  byChannel[ch].push(c.dialogue);
}

async function callClaude(userPrompt, systemPrompt) {
  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: CLAUDE_MODEL,
      max_tokens: 4096,
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

const SYSTEM = `Eres un experto en atención al cliente. Analiza conversaciones reales entre el equipo de Yeppo y sus clientes, y extrae conocimiento estructurado para entrenar a un agente de IA.

Yeppo es una tienda de cosméticos coreanos ubicada en Patronato, Santiago de Chile. Tiene tienda física y tienda online (yeppo.cl).`;

async function main() {
  // Batch 1: Chat web (tomar muestra de 35 conversaciones)
  console.log('\nBatch 1: Chat web...');
  const chatSample = (byChannel['chat'] || []).slice(0, 35).join('\n\n---\n\n');
  const r1 = await callClaude(
    `Analiza estas conversaciones del chat web de Yeppo y extrae:
1. Preguntas frecuentes y cómo las respondía el equipo (con tono exacto)
2. Políticas y procesos mencionados (devoluciones, despachos, mayoristas, asesorías, etc.)
3. Productos y servicios más consultados
4. Frases características del equipo
5. Casos especiales

CONVERSACIONES:
${chatSample}

Sé específico y usa ejemplos reales del texto.`,
    SYSTEM
  );
  console.log('  OK');

  await new Promise(r => setTimeout(r, 2000));

  // Batch 2: WhatsApp
  console.log('Batch 2: WhatsApp...');
  const waSample = (byChannel['whatsapp'] || []).slice(0, 35).join('\n\n---\n\n');
  const r2 = await callClaude(
    `Analiza estas conversaciones de WhatsApp de Yeppo. Enfócate en:
- Consultas de horarios y ubicación
- Despacho/delivery
- Reclamos y cómo se resolvieron
- Mayoristas por WhatsApp
- Diferencias de tono vs chat web

CONVERSACIONES:
${waSample}

Extrae solo información NUEVA o complementaria.`,
    SYSTEM
  );
  console.log('  OK');

  await new Promise(r => setTimeout(r, 2000));

  // Batch 3: Instagram + síntesis final
  console.log('Batch 3: Instagram + síntesis final...');
  const igSample = (byChannel['instagram'] || []).slice(0, 15).join('\n\n---\n\n');

  const finalPrompt = `Con base en estos análisis de conversaciones reales de Yeppo, genera el DOCUMENTO FINAL DE CONOCIMIENTO para el agente de IA.

ANÁLISIS CHAT WEB:
${r1}

ANÁLISIS WHATSAPP:
${r2}

CONVERSACIONES INSTAGRAM ADICIONALES:
${igSample}

Genera el documento con esta estructura exacta:

# BASE DE CONOCIMIENTO — YEPPO

## 1. Quiénes somos
## 2. Productos y servicios
## 3. Preguntas frecuentes y cómo responderlas
(Con las respuestas exactas usando el tono del equipo)
## 4. Políticas operativas
(Devoluciones, despachos, mayoristas, horarios, asesorías)
## 5. Tono y estilo
(Cómo habla el equipo — frases, emojis, nivel de formalidad)
## 6. Manejo de reclamos y situaciones difíciles
## 7. Límites del agente — cuándo derivar a humano

Usa tono y vocabulario real del equipo. Sé específico con ejemplos cuando ayude.`;

  const finalDoc = await callClaude(finalPrompt, SYSTEM);
  console.log('  OK');

  // Guardar
  const docPath = path.join(OUT_DIR, 'knowledge_doc.md');
  fs.writeFileSync(docPath, finalDoc, 'utf8');
  console.log(`\nDocumento guardado: ${docPath}`);
  console.log(`Tamaño: ${finalDoc.length} chars`);
}

main().catch(e => {
  console.error('ERROR:', e.response?.data || e.message);
  process.exit(1);
});
