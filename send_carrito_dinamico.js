/**
 * send_carrito_dinamico.js
 * Envía template carrito_abandonado_recuperar a carritos abandonados
 * con URL personalizada de recuperación por cliente.
 * 
 * Uso: node send_carrito_dinamico.js [--dry-run]
 */

// process.env.SHOPIFY_TOKEN = set via environment variable
process.env.SHOPIFY_STORE = '59c6fd-2.myshopify.com';

const https   = require('https');
const WA_TOKEN  = process.env.WA_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_ID  = '217563878110256';
const DRY_RUN   = process.argv.includes('--dry-run');
const DELAY_MS  = 1200;

// Teléfonos que ya recibieron campañas hoy (grupos A y B)
const yaEnviados = new Set([
  '56997154123','56956598245','56973128401','56934157872','56966545018','56920105843',
  '56973949623','56933029866','56982758080','56982588734','56964334460','56974999273',
  '56944485772','56932126233','56977193656','56985103287','56923703946','56967569006',
  '56971078061','56957225516','56933452476','56979788299','56942796320','56942872392',
  '56933922222','56994480746','56934061047','56933614201','56934035121','56932597790',
  '56985774364','56997013176','56930688896','56978085722','56988279596','56921931566',
  '56957139428','56944964359','56977465838','56936100665','56966828802','56950851237',
  '56956279492','56953500258','56968478368','56957547067','56962425439','56963911542',
  '56974306480','56937012196','56990834247','56972664857','56949481934',
  '56979669945','56982413080','56999671910','56995920471','56998962930','56945689810',
  '56993796479','56993725354','56965559745','56952155548','56975948466','56944705766',
  '56966115323','56967392644','56936640500','56972661523','56940003581','56922461443',
  '56934810136','56935012118','56968489630','56981381582','56965041434','56950890872',
  '56979789884','56978331133','56990034689','56986587998','56930329327','56993307295',
  '56930803873','56950997161','56975276635','56937471460','56957495941','56976224197',
  '56963753027','56982181556','56989539648','56949841729','56953990896','56930040469',
  '56972188461','56962019365','56992824425','56993428809','56952978814','56999674115',
  '56962394898','56966283036','56985447038','56934079949','56931162201'
]);

function shopifyRequest(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: process.env.SHOPIFY_STORE,
      path: '/admin/api/2024-01' + path,
      method: 'GET',
      headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_TOKEN }
    };
    const req = https.request(options, res => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
    });
    req.on('error', reject); req.end();
  });
}

function normalizePhone(raw) {
  if (!raw) return null;
  let p = raw.replace(/[^0-9]/g, '');
  if (p.startsWith('56') && p.length === 11) return p;
  if (p.startsWith('9') && p.length === 9) return '56' + p;
  if (p.length === 8) return '569' + p;
  return null;
}

function sendTemplate(phone, nombre, checkoutUrl) {
  // Extraer el path relativo y agregar UTM
  const urlPath = checkoutUrl.replace('https://yeppo.cl/', '') +
    '&utm_source=whatsapp&utm_medium=carrito_abandonado&utm_campaign=black_mar26';

  const body = JSON.stringify({
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: 'carrito_abandonado_recuperar',
      language: { code: 'es_CL' },
      components: [
        {
          type: 'body',
          parameters: [{ type: 'text', text: nombre }]
        },
        {
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [{ type: 'text', text: urlPath }]
        }
      ]
    }
  });

  return new Promise((resolve) => {
    const options = {
      hostname: 'graph.facebook.com',
      path: `/v18.0/${PHONE_ID}/messages`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WA_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, res => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
    });
    req.on('error', e => resolve({ error: e.message }));
    req.write(body); req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const ahora = Date.now();
  const medianoche = new Date(); medianoche.setHours(23, 59, 0, 0);
  const minutosRestantes = (medianoche - ahora) / 60000;

  if (minutosRestantes < 10) {
    console.log('⛔ Menos de 10 minutos para medianoche — abortando.');
    return;
  }

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const r = await shopifyRequest(`/checkouts.json?status=open&updated_at_min=${since}&limit=250`);
  const checkouts = r?.checkouts || [];

  // Deduplicar por teléfono (quedarse con el carrito de mayor valor si hay varios)
  const porTelefono = new Map();
  for (const c of checkouts) {
    if (c.email === 'marketing@yeppo.cl') continue;
    const phones = [c.phone, c.billing_address?.phone, c.shipping_address?.phone]
      .map(normalizePhone).filter(Boolean);
    const phone = phones.find(p => !yaEnviados.has(p));
    if (!phone) continue;
    const minutosDesde = (ahora - new Date(c.updated_at).getTime()) / 60000;
    if (minutosDesde < 40) continue; // muy reciente
    const total = parseFloat(c.total_price || 0);
    const existing = porTelefono.get(phone);
    if (!existing || total > existing.total) {
      const nombre = c.billing_address?.first_name || c.shipping_address?.first_name || 'ahí';
      porTelefono.set(phone, { phone, nombre, total, checkoutUrl: c.abandoned_checkout_url });
    }
  }

  const candidatos = [...porTelefono.values()];
  console.log(`📋 Candidatos: ${candidatos.length} | Tiempo restante: ${Math.round(minutosRestantes)} min`);
  if (DRY_RUN) console.log('🔍 DRY RUN — no se enviarán mensajes\n');

  let ok = 0, fail = 0;
  for (const { phone, nombre, total, checkoutUrl } of candidatos) {
    if (DRY_RUN) {
      console.log(`[DRY] ${phone} (${nombre}) | $${total}`);
      console.log(`      URL: ${checkoutUrl}`);
      continue;
    }
    const result = await sendTemplate(phone, nombre, checkoutUrl);
    if (result?.messages?.[0]?.id) {
      console.log(`✅ ${phone} (${nombre}) | $${total}`);
      ok++;
    } else {
      const err = result?.error?.message || JSON.stringify(result);
      console.log(`❌ ${phone} (${nombre}) — ${err}`);
      fail++;
    }
    await sleep(DELAY_MS);
  }

  if (!DRY_RUN) console.log(`\n📊 ${ok} enviados, ${fail} fallidos de ${candidatos.length} total`);
}

main().catch(e => console.error('Error:', e.message));
