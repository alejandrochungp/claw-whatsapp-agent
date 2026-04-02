/**
 * inject_via_api.js
 * Inyecta conversaciones de Slack en Railway via API HTTP.
 * Llama al endpoint /admin/learning/inject que agregaremos.
 */

const axios = require('axios');
const fs    = require('fs');

const BASE_URL = 'https://yeppo-whatsapp-webhook-production.up.railway.app';
const convs    = JSON.parse(fs.readFileSync('./slack_conversations_ayer.json', 'utf8'));

async function main() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  const dateStr = date.toISOString().split('T')[0];

  console.log(`Inyectando ${convs.length} conversaciones para ${dateStr}...`);

  const r = await axios.post(`${BASE_URL}/admin/learning/inject`, {
    date: dateStr,
    conversations: convs
  }, { timeout: 30000 });

  console.log('Respuesta:', r.data);

  // Lanzar análisis
  console.log('\nLanzando análisis con Claude...');
  const r2 = await axios.post(`${BASE_URL}/admin/learning/run`, {
    date: dateStr
  }, { timeout: 120000 });

  console.log('Análisis completado:', r2.data);
}

main().catch(e => console.error('Error:', e.response?.data || e.message));
