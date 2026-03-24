/**
 * extract_crisp.js — Extrae conversaciones de Crisp y genera knowledge base
 *
 * Uso: node extract_crisp.js
 */

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const WEBSITE_ID = process.env.CRISP_WEBSITE_ID || '0aaff274-e16d-4985-8d59-76e715e12e72';
const IDENTIFIER = process.env.CRISP_IDENTIFIER || 'b37a978c-dc73-47f7-8be7-6dda4dd8f2bd';
const API_KEY    = process.env.CRISP_API_KEY    || '388f2e24cd2ab3d399339850759c40c3245c85017367807dbd3b05de8fab7cc8';

const AUTH = Buffer.from(`${IDENTIFIER}:${API_KEY}`).toString('base64');

const client = axios.create({
  baseURL: 'https://api.crisp.chat/v1',
  headers: { Authorization: `Basic ${AUTH}`, 'X-Crisp-Tier': 'plugin' },
  timeout: 15000
});

const OUT_DIR = path.join(__dirname, '..', 'knowledge');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const DELAY_MS = 250;
const MAX_PAGES = 30;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function cleanText(text) {
  if (!text || typeof text !== 'string') return '';
  return text.replace(/https?:\/\/\S+/g, '[link]').replace(/\n{3,}/g, '\n\n').trim();
}

async function run() {
  console.log('📥 Descargando conversaciones...');

  // 1. Listar todas las conversaciones
  const allConvs = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    try {
      const res = await client.get(`/website/${WEBSITE_ID}/conversations/${page}`);
      const data = res.data.data;
      if (!data || data.length === 0) break;
      allConvs.push(...data);
      console.log(`  Página ${page}: ${data.length} (total: ${allConvs.length})`);
      if (data.length < 20) break;
      await sleep(DELAY_MS);
    } catch (e) {
      console.error(`  Error página ${page}:`, e.message);
      break;
    }
  }
  console.log(`✅ ${allConvs.length} conversaciones encontradas\n`);

  // 2. Descargar mensajes de cada una
  console.log('📨 Descargando mensajes...');
  const knowledge = [];
  let skipped = 0;

  for (let i = 0; i < allConvs.length; i++) {
    const conv = allConvs[i];
    const sid  = conv.session_id;

    if (i % 50 === 0) console.log(`  [${i}/${allConvs.length}] procesadas...`);

    try {
      const res  = await client.get(`/website/${WEBSITE_ID}/conversation/${sid}/messages`);
      const msgs = res.data.data || [];

      // Solo mensajes de texto con contenido
      const textMsgs = msgs.filter(m =>
        m.type === 'text' &&
        m.content &&
        typeof m.content === 'string' &&
        m.content.trim().length > 2 &&
        m.content.trim().length < 1500
      );

      // Requiere al menos 1 mensaje del operador
      if (!textMsgs.some(m => m.from === 'operator')) {
        skipped++;
        await sleep(DELAY_MS);
        continue;
      }

      const dialogue = textMsgs
        .map(m => `${m.from === 'operator' ? 'Agente' : 'Cliente'}: ${cleanText(m.content)}`)
        .join('\n');

      knowledge.push({
        channel:    conv.meta && conv.meta.origin ? conv.meta.origin : 'unknown',
        date:       new Date(conv.created_at).toISOString().split('T')[0],
        dialogue
      });

    } catch (e) {
      skipped++;
    }

    await sleep(DELAY_MS);
  }

  console.log(`\n✅ Con respuesta del equipo: ${knowledge.length}`);
  console.log(`⏭️  Sin respuesta (omitidas): ${skipped}`);

  // 3. Guardar
  const kbPath = path.join(OUT_DIR, 'knowledge_base.json');
  fs.writeFileSync(kbPath, JSON.stringify(knowledge, null, 2), 'utf8');
  console.log(`\n💾 Guardado: ${kbPath}`);

  // 4. Stats por canal
  const channels = {};
  knowledge.forEach(c => { channels[c.channel] = (channels[c.channel] || 0) + 1; });
  console.log('\n📊 Por canal:');
  Object.entries(channels).sort((a, b) => b[1] - a[1]).forEach(([ch, n]) => {
    console.log(`   ${ch}: ${n}`);
  });

  console.log('\n🎉 Listo!');
}

run().catch(e => {
  console.error('❌ Error fatal:', e.message);
  process.exit(1);
});
