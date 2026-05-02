/**
 * generate_knowledge_batches.js — FASE 1
 * Solo procesa los batches y guarda knowledge_batch_analysis.txt
 * Correr antes de generate_knowledge_final.js
 */

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

const DEEPSEEK_KEY_PATH = path.join(__dirname, '../../../../../.secrets/deepseek_key.txt');
const DEEPSEEK_API_KEY  = fs.readFileSync(DEEPSEEK_KEY_PATH, 'utf8').trim();
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';

const OUT_DIR    = path.join(__dirname, '..', 'knowledge');
const KB_PATH    = path.join(OUT_DIR, 'knowledge_base.json');
const BOT_EXPORT = path.join(__dirname, '../../../../../out/yeppo_conversations_export.json');
const SLACK_FILE = path.join(__dirname, '../../../../../out/slack_yeppo_conversations.json');
const OUT_FILE   = path.join(OUT_DIR, 'knowledge_batch_analysis.txt');

// Cargar fuentes
const crisp = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));
const botExport = JSON.parse(fs.readFileSync(BOT_EXPORT, 'utf8'));

const botConvs = botExport.conversations
  .filter(c => c.turns >= 2)
  .map(c => ({
    channel: 'urn:crisp.im:whatsapp:0',
    date: new Date(c.history[0]?.ts || Date.now()).toISOString().slice(0, 10),
    dialogue: c.history.map(h => (h.role === 'user' ? 'Cliente' : 'Agente') + ': ' + h.text).join('\n')
  }));

// Slack si existe
let slackConvs = [];
if (fs.existsSync(SLACK_FILE)) {
  const slackData = JSON.parse(fs.readFileSync(SLACK_FILE, 'utf8'));
  slackConvs = (slackData.conversations || []).map(c => ({
    channel: 'urn:crisp.im:whatsapp:0',
    date: c.date,
    dialogue: c.dialogue
  }));
  console.log('Slack conversaciones cargadas:', slackConvs.length);
}

function clean(text) {
  return text
    .replace(/_\$\{color\}\[.*?\]\(.*?\)_/g, '')
    .replace(/---\s*\n/g, '')
    .replace(/\[link\]/g, '[enlace]')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\*\*/g, '')
    .trim();
}

const allConvs = [...crisp, ...botConvs, ...slackConvs]
  .map(c => ({ ...c, dialogue: clean(c.dialogue) }))
  .filter(c => c.dialogue.length > 80);

console.log('Fuentes:');
console.log('  Crisp:', crisp.length);
console.log('  Bot WhatsApp:', botConvs.length);
console.log('  Slack:', slackConvs.length);
console.log('  TOTAL util:', allConvs.length);
console.log();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function callAI(prompt, system) {
  const res = await axios.post(
    DEEPSEEK_BASE_URL + '/chat/completions',
    {
      model: 'deepseek-v4-pro',
      max_tokens: 2048,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt }
      ]
    },
    {
      headers: { 'Authorization': 'Bearer ' + DEEPSEEK_API_KEY, 'Content-Type': 'application/json' },
      timeout: 120000
    }
  );
  return res.data.choices[0].message.content;
}

const SYSTEM = 'Eres un analista de atencion al cliente. Analiza estas conversaciones reales de Yeppo (tienda de cosmeticos coreanos en Patronato, Santiago) y extrae informacion util de forma concisa.';

async function main() {
  const results = [];
  const BATCH = 40;

  for (let i = 0; i < allConvs.length; i += BATCH) {
    const batch = allConvs.slice(i, i + BATCH);
    const num = Math.floor(i / BATCH) + 1;
    const total = Math.ceil(allConvs.length / BATCH);
    process.stdout.write('Batch ' + num + '/' + total + ' (' + batch.length + ' convs)... ');

    const text = batch.map((c, idx) => '[' + (i + idx + 1) + '] ' + c.dialogue).join('\n\n---\n\n');

    try {
      const r = await callAI(
        'Analiza estas ' + batch.length + ' conversaciones y extrae:\n' +
        '1. PREGUNTAS FRECUENTES: pregunta + respuesta tipica del equipo\n' +
        '2. POLITICAS: despacho, devoluciones, horarios, mayoristas\n' +
        '3. TONO Y FRASES: expresiones caracteristicas del equipo\n' +
        '4. SITUACIONES ESPECIALES: reclamos, problemas, resoluciones\n' +
        '5. PRODUCTOS MAS CONSULTADOS y como se explicaron\n\n' +
        'Solo lo que REALMENTE aparece. Se especifico.\n\nCONVERSACIONES:\n' + text,
        SYSTEM
      );
      results.push(r);
      console.log('OK');

      // Guardar progreso cada 5 batches
      if (num % 5 === 0) {
        fs.writeFileSync(OUT_FILE, results.join('\n\n===\n\n'), 'utf8');
        console.log('  [checkpoint guardado: ' + num + ' batches]');
      }
    } catch (e) {
      console.log('FAIL ' + e.message);
      results.push('');
    }

    if (i + BATCH < allConvs.length) await sleep(1200);
  }

  // Guardar resultado final
  const combined = results.filter(Boolean).join('\n\n===\n\n');
  fs.writeFileSync(OUT_FILE, combined, 'utf8');
  console.log('\nAnalisis guardado: ' + OUT_FILE + ' (' + combined.length + ' chars)');
  console.log('Batches OK: ' + results.filter(Boolean).length + '/' + results.length);
  console.log('\nAhora corre: node generate_knowledge_final.js');
}

main().catch(e => {
  console.error('ERROR:', e.response?.data || e.message);
  process.exit(1);
});
