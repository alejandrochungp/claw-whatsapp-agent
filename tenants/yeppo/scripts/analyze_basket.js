/**
 * analyze_basket.js — Market basket analysis de pedidos Shopify
 * 
 * Encuentra qué productos se compran juntos con más frecuencia.
 * Usa SKU como identificador (más estable que el nombre).
 * 
 * Uso: node analyze_basket.js [--orders 500] [--min-freq 3] [--output]
 * 
 * --orders N   : cuántos pedidos analizar (default: 1000)
 * --min-freq N : frecuencia mínima para mostrar un par (default: 3)
 * --output     : guardar resultado en basket_results.json
 */

const https   = require('https');
const fs      = require('fs');
const path    = require('path');

// ── Config ───────────────────────────────────────────────────────────────────
const cfg       = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../../../.secrets/yeppo_shopify.json'), 'utf8'));
const TOKEN     = cfg.shopify_token;
const STORE     = '59c6fd-2.myshopify.com';
const MAX_ORDERS = parseInt(process.argv.find(a => a.startsWith('--orders='))?.split('=')[1]) || 1000;
const MIN_FREQ   = parseInt(process.argv.find(a => a.startsWith('--min-freq='))?.split('=')[1]) || 3;
const SAVE_OUTPUT = process.argv.includes('--output');

// ── Shopify helper ───────────────────────────────────────────────────────────
function shopifyGet(path, params = {}) {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams({ limit: 250, ...params }).toString();
    const options = {
      hostname: STORE,
      path: `/admin/api/2024-01${path}?${query}`,
      method: 'GET',
      headers: { 'X-Shopify-Access-Token': TOKEN }
    };
    https.get(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ data: JSON.parse(data), headers: res.headers }); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ── Descargar pedidos paginados ──────────────────────────────────────────────
async function fetchOrders(maxOrders) {
  const orders = [];
  let pageInfo = null;
  let page = 1;

  console.log(`Descargando hasta ${maxOrders} pedidos pagados...`);

  while (orders.length < maxOrders) {
    const params = {
      status: 'any',
      financial_status: 'paid',
      limit: 250,
      fields: 'id,name,line_items,created_at'
    };
    // page_info no se combina con otros filtros en Shopify
    if (pageInfo) {
      Object.keys(params).forEach(k => { if (k !== 'limit') delete params[k]; });
      params.page_info = pageInfo;
    }

    const res = await shopifyGet('/orders.json', params);
    const batch = res.data.orders || [];
    if (batch.length === 0) break;

    orders.push(...batch);
    process.stdout.write(`\r  Descargados: ${orders.length} pedidos (página ${page})...`);

    // Paginación via Link header
    const linkHeader = res.headers.link || '';
    const nextMatch  = linkHeader.match(/<[^>]*page_info=([^&>]+)[^>]*>;\s*rel="next"/);
    if (!nextMatch) break;
    pageInfo = nextMatch[1];
    page++;

    // Rate limit: 2 calls/sec
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n  Total descargados: ${orders.length} pedidos\n`);
  return orders.slice(0, maxOrders);
}

// ── Normalizar SKU ───────────────────────────────────────────────────────────
function normalizeSku(sku) {
  return (sku || '').trim().toUpperCase();
}

// ── Market basket analysis ───────────────────────────────────────────────────
function analyzeBasket(orders) {
  const pairCount  = new Map(); // "SKU_A|SKU_B" -> count
  const skuNames   = new Map(); // SKU -> nombre del producto
  const skuVariantIds = new Map(); // SKU -> variantId (último visto)
  let ordersWithMultiple = 0;
  let totalItems = 0;

  for (const order of orders) {
    const items = order.line_items || [];
    totalItems += items.length;

    // Registrar nombres y variantIds por SKU
    for (const item of items) {
      const sku = normalizeSku(item.sku);
      if (!sku) continue;
      if (!skuNames.has(sku)) skuNames.set(sku, item.title || item.name || sku);
      if (item.variant_id) skuVariantIds.set(sku, item.variant_id);
    }

    // Solo pedidos con 2+ productos distintos
    const skus = [...new Set(items.map(i => normalizeSku(i.sku)).filter(Boolean))];
    if (skus.length < 2) continue;
    ordersWithMultiple++;

    // Contar todos los pares
    for (let i = 0; i < skus.length; i++) {
      for (let j = i + 1; j < skus.length; j++) {
        // Ordenar para clave canónica
        const [a, b] = [skus[i], skus[j]].sort();
        const key    = `${a}|${b}`;
        pairCount.set(key, (pairCount.get(key) || 0) + 1);
      }
    }
  }

  // Convertir a array y ordenar por frecuencia
  const pairs = [];
  for (const [key, count] of pairCount.entries()) {
    if (count < MIN_FREQ) continue;
    const [skuA, skuB] = key.split('|');
    pairs.push({
      skuA,
      skuB,
      nombreA:    skuNames.get(skuA) || skuA,
      nombreB:    skuNames.get(skuB) || skuB,
      variantIdA: skuVariantIds.get(skuA) || null,
      variantIdB: skuVariantIds.get(skuB) || null,
      frecuencia: count
    });
  }

  pairs.sort((a, b) => b.frecuencia - a.frecuencia);

  return { pairs, stats: { orders: orders.length, ordersWithMultiple, totalItems, uniqueSkus: skuNames.size } };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  try {
    const orders  = await fetchOrders(MAX_ORDERS);
    const result  = analyzeBasket(orders);
    const { pairs, stats } = result;

    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  MARKET BASKET ANALYSIS — YEPPO`);
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  Pedidos analizados  : ${stats.orders}`);
    console.log(`  Con 2+ productos    : ${stats.ordersWithMultiple}`);
    console.log(`  SKUs únicos         : ${stats.uniqueSkus}`);
    console.log(`  Pares encontrados   : ${pairs.length} (frecuencia ≥ ${MIN_FREQ})`);
    console.log('═══════════════════════════════════════════════════════════\n');

    if (pairs.length === 0) {
      console.log(`No se encontraron pares con frecuencia ≥ ${MIN_FREQ}.`);
      console.log(`Prueba con --min-freq=2 o --min-freq=1`);
      return;
    }

    console.log(`TOP ${Math.min(pairs.length, 30)} PARES MÁS FRECUENTES:\n`);
    const top = pairs.slice(0, 30);

    top.forEach((p, i) => {
      const num = String(i + 1).padStart(2, ' ');
      const freq = String(p.frecuencia).padStart(3, ' ');
      console.log(`${num}. [${freq}x] ${p.nombreA.substring(0, 45).padEnd(45)} +`);
      console.log(`        ${p.nombreB.substring(0, 45).padEnd(45)}`);
      console.log(`        SKU: ${p.skuA} | ${p.skuB}`);
      if (p.variantIdA) console.log(`        VariantId B: ${p.variantIdB || 'N/A'}`);
      console.log('');
    });

    // Guardar resultado completo
    if (SAVE_OUTPUT) {
      const outPath = path.join(__dirname, 'basket_results.json');
      fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), stats, pairs }, null, 2), 'utf8');
      console.log(`\nResultado completo guardado en: ${outPath}`);
      console.log(`Para agregar pares a complementos.json, edita ese archivo y copia los pares relevantes.`);
    }

  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
}

main();
