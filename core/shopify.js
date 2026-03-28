/**
 * core/shopify.js — Lookup de clientes en Shopify por número de teléfono
 *
 * Busca en múltiples formatos porque los números pueden estar guardados
 * de distintas maneras en Shopify (con/sin +56, con/sin 9, etc.)
 */

const https = require('https');

const SHOP  = process.env.SHOPIFY_STORE  || '59c6fd-2.myshopify.com';
const TOKEN = process.env.SHOPIFY_TOKEN;
const API   = '2024-01';

// ── Normalizar número a múltiples formatos para búsqueda ────────────────────
function phoneVariants(phone) {
  // phone llega como "56977282566" (sin +)
  const digits = phone.replace(/\D/g, '');

  const variants = new Set();

  // Con + completo
  variants.add(`+${digits}`);
  // Sin +
  variants.add(digits);

  // Si empieza con 56 → también probar sin 56
  if (digits.startsWith('56')) {
    const local = digits.slice(2); // "977282566"
    variants.add(local);
    variants.add(`+56${local}`);
    variants.add(`56${local}`);
    // Con espacio chileno: +56 9 XXXX XXXX
    if (local.startsWith('9') && local.length === 9) {
      variants.add(`+56 ${local[0]} ${local.slice(1, 5)} ${local.slice(5)}`);
    }
  }

  return [...variants];
}

// ── Request helper ───────────────────────────────────────────────────────────
function shopifyGet(path) {
  return new Promise((resolve, reject) => {
    if (!TOKEN) return resolve(null);

    const options = {
      hostname: SHOP,
      path:     `/admin/api/${API}${path}`,
      method:   'GET',
      headers:  { 'X-Shopify-Access-Token': TOKEN }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });

    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// Versión que devuelve body + headers (para paginación con Link)
function shopifyGetWithHeaders(path) {
  return new Promise((resolve) => {
    if (!TOKEN) return resolve({ body: null, linkHeader: null });

    const req = https.request({
      hostname: SHOP,
      path:     `/admin/api/${API}${path}`,
      method:   'GET',
      headers:  { 'X-Shopify-Access-Token': TOKEN }
    }, (res) => {
      let data = '';
      const linkHeader = res.headers['link'] || null;
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ body: JSON.parse(data), linkHeader }); }
        catch { resolve({ body: null, linkHeader }); }
      });
    });

    req.on('error', () => resolve({ body: null, linkHeader: null }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ body: null, linkHeader: null }); });
    req.end();
  });
}

// ── Verificar que el teléfono del cliente realmente coincide ─────────────────
function phonesMatch(searchPhone, customerPhone) {
  if (!customerPhone) return false;
  // Normalizar ambos a solo dígitos
  const a = searchPhone.replace(/\D/g, '');
  const b = customerPhone.replace(/\D/g, '');
  // Comparar los últimos 9 dígitos (número local sin prefijo país)
  const aSuffix = a.slice(-9);
  const bSuffix = b.slice(-9);
  return aSuffix === bSuffix;
}

// ── Buscar cliente por teléfono ──────────────────────────────────────────────
async function findCustomer(phone) {
  if (!TOKEN) return null;

  const variants = phoneVariants(phone);

  for (const variant of variants) {
    const encoded = encodeURIComponent(variant);
    const result  = await shopifyGet(`/customers/search.json?query=phone:${encoded}&limit=5&fields=id,first_name,last_name,email,phone,orders_count,total_spent,tags,note`);

    if (result?.customers?.length) {
      // Verificar que el teléfono realmente coincide — Shopify hace búsqueda parcial
      const exactMatch = result.customers.find(c => phonesMatch(phone, c.phone));
      if (exactMatch) return exactMatch;
    }
  }

  return null;
}

// ── Obtener últimos pedidos del cliente ──────────────────────────────────────
async function getRecentOrders(customerId, limit = 3) {
  if (!TOKEN || !customerId) return [];

  const result = await shopifyGet(`/orders.json?customer_id=${customerId}&limit=${limit}&status=any&fields=id,name,created_at,financial_status,fulfillment_status,total_price,line_items`);

  return result?.orders || [];
}

// ── Formatear contexto para Claude ──────────────────────────────────────────
function buildCustomerContext(customer, orders) {
  if (!customer) return null;

  const name      = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || 'Cliente';
  const spent     = customer.total_spent ? `$${parseFloat(customer.total_spent).toLocaleString('es-CL')}` : 'N/A';
  const orderCount = customer.orders_count || 0;

  let ctx = `CLIENTE IDENTIFICADO EN SHOPIFY:\n`;
  ctx += `- Nombre: ${name}\n`;
  ctx += `- Email: ${customer.email || 'no registrado'}\n`;
  ctx += `- Pedidos totales: ${orderCount}\n`;
  ctx += `- Gasto total: ${spent}\n`;

  if (customer.tags) ctx += `- Tags: ${customer.tags}\n`;
  if (customer.note) ctx += `- Nota interna: ${customer.note}\n`;

  if (orders.length) {
    ctx += `\nÚLTIMOS PEDIDOS:\n`;
    for (const order of orders) {
      const date    = new Date(order.created_at).toLocaleDateString('es-CL');
      const status  = order.fulfillment_status || 'pendiente';
      const payment = order.financial_status || '?';
      const total   = `$${parseFloat(order.total_price).toLocaleString('es-CL')}`;
      const items   = order.line_items?.map(i => i.name).join(', ') || '';
      ctx += `  • ${order.name} (${date}) — ${total} — ${status} — ${payment}\n`;
      if (items) ctx += `    Productos: ${items}\n`;
    }
  } else {
    ctx += `\nSin pedidos registrados.\n`;
  }

  return ctx;
}

// ── Formatear para mensaje de Slack ─────────────────────────────────────────
function buildSlackCustomerInfo(customer, orders) {
  if (!customer) return null;

  const name  = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || 'Cliente';
  const spent = customer.total_spent ? `$${parseFloat(customer.total_spent).toLocaleString('es-CL')}` : '?';

  let info = `\n👤 *Cliente Shopify identificado:* ${name}`;
  if (customer.email) info += ` (${customer.email})`;
  info += `\n🛍️ ${customer.orders_count || 0} pedidos | Total gastado: ${spent}`;

  if (orders.length) {
    info += `\n📦 Último pedido: ${orders[0].name} — $${parseFloat(orders[0].total_price).toLocaleString('es-CL')} — ${orders[0].fulfillment_status || 'pendiente'}`;
  }

  return info;
}

// ── API principal ─────────────────────────────────────────────────────────────
async function enrichContact(phone) {
  try {
    const customer = await findCustomer(phone);
    if (!customer) return null;

    const orders = await getRecentOrders(customer.id);

    return {
      customer,
      orders,
      claudeContext:  buildCustomerContext(customer, orders),
      slackInfo:      buildSlackCustomerInfo(customer, orders)
    };
  } catch (err) {
    console.error(`[shopify] Error enrichContact ${phone}:`, err.message);
    return null;
  }
}

// ── Catálogo de productos con caché Redis ────────────────────────────────────
// Solo campos necesarios para el bot: título, precio, stock, tipo
// Se refresca cada hora — no se consulta en cada mensaje, solo cuando relevante

const CATALOG_TTL  = 60 * 60;       // 1 hora
const CATALOG_KEY  = 'catalog:yeppo';
let   catalogRam   = null;           // fallback en RAM si no hay Redis
let   catalogRamTs = 0;

let redisClient = null;

async function getRedis() {
  if (redisClient) return redisClient;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    const { createClient } = require('redis');
    redisClient = createClient({ url });
    redisClient.on('error', () => {});
    await redisClient.connect();
    return redisClient;
  } catch { return null; }
}

async function fetchCatalogFromShopify() {
  if (!TOKEN) return [];

  const products = [];
  let page = 1;
  let pageInfo = null;
  let path = '/products.json?limit=250&status=active&fields=id,title,handle,body_html,product_type,tags,variants';

  // Paginar hasta traer todos
  while (path) {
    const { body: r, linkHeader } = await shopifyGetWithHeaders(path);
    console.log('[shopify] fetch productos - count:', r?.products?.length, 'link:', linkHeader ? 'sí' : 'no');
    if (!r?.products?.length) break;

    for (const p of r.products) {
      // Para productos con múltiples variantes, tomar la de menor precio con stock
      const variants = p.variants || [];
      const activeVariants = variants.filter(v => (v.inventory_quantity || 0) > 0 || v.inventory_policy === 'continue');
      const bestVariant = activeVariants.sort((a, b) => parseFloat(a.price) - parseFloat(b.price))[0] || variants[0];

      if (!bestVariant) continue;

      // Limpiar HTML de la descripción
      const rawDesc = p.body_html || '';
      const description = rawDesc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);

      products.push({
        id:    p.id,
        title: p.title,
        handle: p.handle || '',
        description,
        type:  p.product_type || '',
        tags:  p.tags || '',
        price: parseFloat(bestVariant.price || 0),
        stock: activeVariants.length > 0,
        variantTitle: bestVariant.title !== 'Default Title' ? bestVariant.title : null
      });
    }

    // Paginación via header Link de Shopify
    path = null;
    if (linkHeader) {
      // Buscar rel="next" en el header Link
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (nextMatch) {
        // Extraer solo el path desde la URL completa
        try {
          const url = new URL(nextMatch[1]);
          path = url.pathname + url.search;
          // Quitar el prefijo /admin/api/VERSION ya que shopifyGetWithHeaders lo agrega
          path = path.replace(`/admin/api/${API}`, '');
        } catch { path = null; }
      }
    }
  }

  return products;
}

async function getProductCatalog() {
  // Intentar desde Redis
  const redis = await getRedis();
  if (redis) {
    try {
      const cached = await redis.get(CATALOG_KEY);
      if (cached) return JSON.parse(cached);
    } catch {}
  } else {
    // Fallback RAM — TTL 1 hora
    if (catalogRam && Date.now() - catalogRamTs < CATALOG_TTL * 1000) return catalogRam;
  }

  // Fetch desde Shopify
  console.log('[shopify] Refrescando catálogo de productos...');
  const products = await fetchCatalogFromShopify();

  // Guardar en caché
  if (redis) {
    try { await redis.setEx(CATALOG_KEY, CATALOG_TTL, JSON.stringify(products)); } catch {}
  } else {
    catalogRam   = products;
    catalogRamTs = Date.now();
  }

  console.log(`[shopify] Catálogo cargado: ${products.length} productos`);
  return products;
}

// ── Buscar productos relevantes por query del cliente ─────────────────────────
// Devuelve los top N productos que hacen match con el texto
function searchCatalog(catalog, query, limit = 5) {
  if (!query || !catalog?.length) return [];
  const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, '');
  const terms = norm(query).split(/\s+/).filter(t => t.length > 2);
  if (!terms.length) return [];

  const scored = catalog.map(p => {
    const haystack = norm(`${p.title} ${p.type} ${p.tags}`);
    const score    = terms.reduce((s, t) => s + (haystack.includes(t) ? 1 : 0), 0);
    return { ...p, score };
  }).filter(p => p.score > 0).sort((a, b) => b.score - a.score);

  return scored.slice(0, limit);
}

// ── Formatear catálogo para el prompt de Claude ───────────────────────────────
function formatCatalogForPrompt(products) {
  if (!products?.length) return '';
  const lines = products.map(p => {
    const precio = `$${Math.round(p.price).toLocaleString('es-CL')}`;
    const stock  = p.stock ? '✅' : '❌ sin stock';
    const variant = p.variantTitle ? ` (${p.variantTitle})` : '';
    const link    = p.handle ? `https://yeppo.cl/products/${p.handle}` : '';
    const desc    = p.description ? `\n  ${p.description}` : '';
    return `• ${p.title}${variant} — ${precio} — ${stock}${link ? ` — ${link}` : ''}${desc}`;
  });
  return lines.join('\n');
}

// ── Detectar si el mensaje pregunta por productos/stock/precios ───────────────
function isProductQuery(text) {
  return /\b(tienen|hay|stock|precio|cuánto cuesta|cuanto vale|disponible|busco|tienes|existe|venden|producto|cuánto está|cuanto esta)\b/i.test(text);
}

async function invalidateCatalog() {
  const redis = await getRedis();
  if (redis) {
    try { await redis.del(CATALOG_KEY); } catch {}
  } else {
    catalogRam = null;
    catalogRamTs = 0;
  }
}

module.exports = { enrichContact, getProductCatalog, searchCatalog, formatCatalogForPrompt, isProductQuery, invalidateCatalog };
