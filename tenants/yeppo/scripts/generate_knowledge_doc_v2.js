/**
 * generate_knowledge_doc_v2.js
 * Regenera knowledge_doc.md usando las 583 conversaciones completas.
 * Procesa en 6 batches temáticos → síntesis final.
 */

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

const KEY_PATH       = path.join(__dirname, '../../../../../.secrets/claude_yeppo_key.txt');
const CLAUDE_API_KEY = fs.readFileSync(KEY_PATH, 'utf8').trim();
const CLAUDE_MODEL   = 'claude-sonnet-4-6';
const OUT_DIR        = path.join(__dirname, '..', 'knowledge');
const KB_PATH        = path.join(OUT_DIR, 'knowledge_base.json');

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

console.log(`Después de filtrar cortas: ${cleaned.length}`);

// Agrupar por canal
const byChannel = {};
for (const c of cleaned) {
  const ch = c.channel.replace('urn:crisp.im:', '').replace(':0', '');
  if (!byChannel[ch]) byChannel[ch] = [];
  byChannel[ch].push(c.dialogue);
}

console.log('Distribución:');
for (const [ch, convs] of Object.entries(byChannel)) {
  console.log(`  ${ch}: ${convs.length}`);
}

async function callClaude(userPrompt, systemPrompt, maxTokens = 4096) {
  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    },
    {
      headers: {
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      timeout: 180000
    }
  );
  return res.data.content[0].text;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Dividir array en chunks de N
function chunks(arr, n) {
  const result = [];
  for (let i = 0; i < arr.length; i += n) result.push(arr.slice(i, i + n));
  return result;
}

const SYSTEM = `Eres un experto en atención al cliente. Tu tarea es analizar conversaciones reales entre el equipo de Yeppo y sus clientes.

Yeppo es una tienda de cosméticos coreanos con tienda física en el barrio Patronato (Santiago) y tienda online yeppo.cl. También tiene sucursales en Coyancura, Recoleta y Alcántara.

Extrae SOLO información concreta y útil para entrenar un agente de IA que atienda a clientes de Yeppo.`;

const EXTRACT_PROMPT = (canal, convs) => `Analiza estas ${convs.length} conversaciones del canal ${canal} de Yeppo.

Extrae en formato estructurado:
1. **FAQs detectadas** — pregunta frecuente + cómo respondía el equipo (tono exacto, con ejemplos de frases reales)
2. **Políticas y procesos** — devoluciones, despacho, cambios, mayoristas, asesoría de piel, puntos, etc.
3. **Productos/marcas** más consultados
4. **Situaciones especiales** — reclamos, pedidos perdidos, problemas de cuenta, etc.
5. **Tono y expresiones** características del equipo en este canal

CONVERSACIONES:
${convs.join('\n\n---\n\n')}`;

async function main() {
  const results = [];

  // ── Chat web: 291 convs → 3 batches de ~60 ──────────────────────────────
  const chatConvs = byChannel['chat'] || [];
  const chatBatches = chunks(chatConvs, 60);
  for (let i = 0; i < chatBatches.length; i++) {
    console.log(`\nChat batch ${i+1}/${chatBatches.length} (${chatBatches[i].length} convs)...`);
    const r = await callClaude(EXTRACT_PROMPT('chat web', chatBatches[i]), SYSTEM);
    results.push({ source: `chat_${i+1}`, text: r });
    console.log('  ✅');
    await sleep(3000);
  }

  // ── WhatsApp: 156 convs → 2 batches de ~60 ──────────────────────────────
  const waConvs = byChannel['whatsapp'] || [];
  const waBatches = chunks(waConvs, 60);
  for (let i = 0; i < waBatches.length; i++) {
    console.log(`\nWhatsApp batch ${i+1}/${waBatches.length} (${waBatches[i].length} convs)...`);
    const r = await callClaude(EXTRACT_PROMPT('WhatsApp', waBatches[i]), SYSTEM);
    results.push({ source: `whatsapp_${i+1}`, text: r });
    console.log('  ✅');
    await sleep(3000);
  }

  // ── Instagram: 107 convs → 2 batches de ~55 ─────────────────────────────
  const igConvs = byChannel['instagram'] || [];
  const igBatches = chunks(igConvs, 55);
  for (let i = 0; i < igBatches.length; i++) {
    console.log(`\nInstagram batch ${i+1}/${igBatches.length} (${igBatches[i].length} convs)...`);
    const r = await callClaude(EXTRACT_PROMPT('Instagram', igBatches[i]), SYSTEM);
    results.push({ source: `instagram_${i+1}`, text: r });
    console.log('  ✅');
    await sleep(3000);
  }

  // ── Unknown/otros ────────────────────────────────────────────────────────
  const otherConvs = [
    ...(byChannel['unknown'] || []),
    ...(byChannel['messenger'] || [])
  ];
  if (otherConvs.length > 0) {
    console.log(`\nOtros canales (${otherConvs.length} convs)...`);
    const r = await callClaude(EXTRACT_PROMPT('otros canales', otherConvs.slice(0, 40)), SYSTEM);
    results.push({ source: 'otros', text: r });
    console.log('  ✅');
    await sleep(3000);
  }

  // ── Síntesis final ───────────────────────────────────────────────────────
  console.log('\nGenerando síntesis final...');

  const allAnalysis = results.map(r => `### Análisis ${r.source}\n${r.text}`).join('\n\n---\n\n');

  const finalPrompt = `Tienes ${results.length} análisis de conversaciones reales de Yeppo (total: ${cleaned.length} conversaciones de chat web, WhatsApp, Instagram y otros canales).

Con esta información, genera el DOCUMENTO FINAL DE CONOCIMIENTO para el agente de IA de Yeppo. Este documento es la fuente de verdad del agente — debe ser completo, concreto y usar el tono real del equipo.

${allAnalysis}

---

Genera el documento con ESTA ESTRUCTURA EXACTA (sin omitir secciones):

# BASE DE CONOCIMIENTO — YEPPO
*Generado desde ${cleaned.length} conversaciones reales (chat web, WhatsApp, Instagram)*

## 1. Quiénes somos
(Descripción de Yeppo basada en cómo se presenta en las conversaciones reales)

## 2. Sucursales y horarios
(Toda la información de locales, horarios y cómo llegar que aparece en las conversaciones)

## 3. Productos y servicios
(Marcas, categorías, servicios especiales como asesoría de piel, etc.)

## 4. Preguntas frecuentes y cómo responderlas
(Las 20+ preguntas más comunes con la respuesta exacta usando el tono del equipo. Incluir ejemplos de frases reales cuando sea posible.)

## 5. Políticas operativas
(Devoluciones, cambios, despacho, tiempos, mayoristas, puntos de fidelidad, códigos de descuento, etc.)

## 6. Tono y estilo de comunicación
(Cómo habla el equipo: nivel de formalidad, emojis usados, frases características, diferencias entre canales)

## 7. Manejo de reclamos y situaciones difíciles
(Pedidos perdidos, productos dañados, errores en pedidos, cuentas bloqueadas, etc. — con ejemplos de cómo se resolvieron)

## 8. Cuándo derivar a humano
(Situaciones que el bot no debe resolver solo)

Sé MUY específico. Usa frases y ejemplos reales cuando los tengas. Este documento reemplaza al anterior que era incompleto.`;

  const finalDoc = await callClaude(finalPrompt, SYSTEM, 8000);
  console.log('  ✅');

  // Guardar
  const docPath = path.join(OUT_DIR, 'knowledge_doc.md');
  fs.writeFileSync(docPath, finalDoc, 'utf8');

  // Backup del anterior
  const backupPath = path.join(OUT_DIR, 'knowledge_doc_v1_backup.md');
  if (!fs.existsSync(backupPath)) {
    const old = path.join(OUT_DIR, 'knowledge_doc.md');
    // ya fue sobreescrito, pero guardamos el nuevo como referencia
  }

  console.log(`\n✅ Documento guardado: ${docPath}`);
  console.log(`📄 Tamaño: ${(finalDoc.length / 1024).toFixed(1)} KB`);
  console.log(`📊 Batches procesados: ${results.length}`);
}

main().catch(e => {
  console.error('ERROR:', e.response?.data || e.message);
  process.exit(1);
});
