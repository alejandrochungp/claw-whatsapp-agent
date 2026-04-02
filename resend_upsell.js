/**
 * resend_upsell.js — Reenviar upsell a pedidos recientes con teléfono
 * Uso: node resend_upsell.js [horas]  (default: 2)
 */
const axios = require('axios');
const fs    = require('fs');

const cfg     = JSON.parse(fs.readFileSync('../../.secrets/yeppo_shopify.json', 'utf8'));
const token   = cfg.shopify_token;
const store   = '59c6fd-2.myshopify.com';
const SERVER  = 'https://yeppo-whatsapp-webhook-production.up.railway.app';
const HOURS   = parseInt(process.argv[2]) || 2;

async function run() {
  const since = new Date(Date.now() - HOURS * 60 * 60 * 1000).toISOString();
  console.log(`Buscando pedidos pagados desde ${since} (últimas ${HOURS}h)...`);

  const r = await axios.get(`https://${store}/admin/api/2024-01/orders.json`, {
    params: { status: 'any', created_at_min: since, limit: 100,
              fields: 'id,name,created_at,phone,customer,line_items,financial_status,total_price' },
    headers: { 'X-Shopify-Access-Token': token }
  });

  const orders = r.data.orders.filter(o => o.financial_status === 'paid');
  const withPhone = orders.filter(o => o.phone || o.customer?.phone);
  const sinPhone  = orders.length - withPhone.length;

  console.log(`Total pagados: ${orders.length} | Con teléfono: ${withPhone.length} | Sin teléfono: ${sinPhone}`);
  console.log('');

  let ok = 0, err = 0;
  for (const o of withPhone) {
    const phone = o.phone || o.customer?.phone;
    const t = new Date(o.created_at).toLocaleTimeString('es-CL', { timeZone: 'America/Santiago' });
    const prod = o.line_items?.[0]?.name || '?';
    process.stdout.write(`  ${o.name} [${t}] Tel: ${phone} | ${prod.substring(0,35)}... `);

    try {
      // Simular webhook de Shopify enviando el pedido al endpoint
      const resp = await axios.post(`${SERVER}/shopify/order`, o, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000
      });
      console.log('✅');
      ok++;
    } catch (e) {
      console.log('❌ ' + (e.response?.data || e.message));
      err++;
    }

    // Delay entre envíos para no saturar
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`\nResultado: ${ok} enviados, ${err} errores`);
}

run().catch(e => console.error('Error fatal:', e.response?.data || e.message));
