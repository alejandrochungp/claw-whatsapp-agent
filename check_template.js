/**
 * check_template.js — Ver estructura del template pago_confirmado_upsell
 * Corre en Railway via: POST /admin/run-script (si existe) o agrega endpoint temporal
 */
const https = require('https');

const token  = process.env.WHATSAPP_ACCESS_TOKEN;
const wabaId = '790101577482960';

function get(path) {
  return new Promise((resolve, reject) => {
    https.get({ hostname: 'graph.facebook.com', path, headers: { Authorization: `Bearer ${token}` } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

async function run() {
  const r = await get(`/v19.0/${wabaId}/message_templates?name=pago_confirmado_upsell&fields=name,status,components`);
  const t = r.data?.[0];
  if (!t) { console.log('Template no encontrado'); console.log(JSON.stringify(r)); return; }
  console.log('Template:', t.name, '| Status:', t.status);
  console.log(JSON.stringify(t.components, null, 2));
}

run().catch(console.error);
