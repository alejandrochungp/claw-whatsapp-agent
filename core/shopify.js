/**
 * core/shopify.js — Lookup de clientes y pedidos en Shopify
 *
 * Busca clientes por teléfono (múltiples formatos) y pedidos por número de orden.
 * También mantiene caché del catálogo de productos.
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

// ── Helper: número de orden a formato Shopify ───────────────────────────────
function normalizeOrderNumber(input) {
  // input puede ser: "#1001", "1001", "# 1001", "pedido #1001", etc.
  const digits = (input || '').replace(/\D/g, '');
  if (!digits) return null;
  return '#' + digits; // Formato exacto de Shopify: #1001
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
  const a = searchPhone.replace(/\D/g, '');
  const b = customerPhone.replace(/\D/g, '');
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

// ── Buscar pedido por número de orden (#XXXX) ────────────────────────────────
async function getOrderByNumber(rawInput) {
  if (!TOKEN) {
    return { found: false, error: 'Token de Shopify no configurado' };
  }

  const orderName = normalizeOrderNumber(rawInput);
  if (!orderName) {
    return { found: false, error: 'Número de pedido inválido' };
  }

  try {
    // Consultar por nombre exacto — Shopify devuelve coincidencias parciales,
    // así que pedimos varios y filtramos por nombre exacto
    const result = await shopifyGet(
      `/orders.json?name=${encodeURIComponent(orderName)}&status=any&limit=10&fields=id,name,email,created_at,financial_status,fulfillment_status,fulfillments,line_items,total_price,shipping_address,customer`
    );

    if (!result || !result.orders || !result.orders.length) {
      return { found: false, orderNumber: orderName };
    }

    // Filtrar por nombre exacto (Shopify puede devolver #1001, #10010, #21001...)
    const exact = result.orders.find(o => o.name === orderName);
    if (!exact) {
      return { found: false, orderNumber: orderName, partialMatches: result.orders.length };
    }

    const order = exact;

    // Extraer info de tracking de los fulfillments
    let trackingUrl   = null;
    let trackingCompany = null;
    let shipmentStatus  = order.fulfillment_status || 'pendiente';

    if (order.fulfillments && order.fulfillments.length > 0) {
      // Tomar el fulfillment más reciente
      const lastFulfillment = order.fulfillments[order.fulfillments.length - 1];
      trackingUrl     = lastFulfillment.tracking_url || null;
      trackingCompany = lastFulfillment.tracking_company || null;
      if (lastFulfillment.shipment_status) {
        shipmentStatus = lastFulfillment.shipment_status;
      }
    }

    // Resumir productos
    const items = (order.line_items || []).map(item => ({
      name:     item.name,
      quantity: item.quantity,
      price:    item.price
    }));

    const total = parseFloat(order.total_price || 0).toLocaleString('es-CL');

    // Construir respuesta
    return {
      found:            true,
      orderNumber:      order.name,
      orderId:          order.id,
      createdAt:        order.created_at,
      financialStatus:  order.financial_status,
      fulfillmentStatus: order.fulfillment_status,
      shipmentStatus:   shipmentStatus,
      trackingUrl:      trackingUrl,
      trackingCompany:  trackingCompany,
      totalPrice:       total,
      items:            items,
      customerEmail:    order.email || (order.customer?.email || null),
      // Mensaje pre-formateado para que el bot responda directo
      botReply:         buildOrderStatusReply(order.name, shipmentStatus, trackingUrl, trackingCompany, total)
    };

  } catch (err) {
    return { found: false, error: 'Error consultando Shopify: ' + (err.message || 'desconocido') };
  }
}

// ── Construir respuesta amigable para el bot ─────────────────────────────────
function buildOrderStatusReply(orderName, status, trackingUrl, trackingCompany, total) {
  const statusEmoji = {
    'pending':       '⏳',
    'fulfilled':     '✅',
    'partial':       '📦',
    'on_hold':       '🔄',
    'scheduled':     '📅',
    'unfulfilled':   '⏳',
    'pendiente':     '⏳',
    'delivered':     '🏠',
    'in_transit':    '🚚',
    'out_for_delivery': '🛵',
    'cancelled':     '❌'
  };

  const emoji = statusEmoji[status] || '📋';

  let reply = `Holi! ${emoji} Tu pedido *${orderName}* está *${status}*`;

  if (total) {
    reply += ` (total: $${total})`;
  }

  reply += '.\n\n';

  if (trackingUrl && trackingCompany) {
    reply += `🚚 Lo mandamos por *${trackingCompany}*. Puedes seguir tu envío aquí:\n${trackingUrl}`;
  } else if (trackingUrl) {
    reply += `🚚 Puedes seguir tu envío aquí:\n${trackingUrl}`;
  } else if (status === 'fulfilled' || status === 'delivered') {
    reply += 'Si tu pedido ya fue entregado y tienes alguna duda, dime y te ayudo.';
  } else if (status === 'pending' || status === 'unfulfilled') {
    reply += 'Aún lo estamos preparando con mucho amor 🌸. Apenas salga te avisamos con el link de seguimiento.';
  } else {
    reply += 'Cualquier cosa me avisas y te ayudo.';
  }

  return reply;
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
  let path = '/products.json?status=active&limit=250&fields=id,title,handle,vendor,product_type,variants';

  while (path) {
    const { body, linkHeader } = await shopifyGetWithHeaders(path);
    if (!body || !body.products) break;
    products.push(...body.products);

    // Paginación: extraer next link del header
    path = null;
    if (linkHeader) {
      const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (match) {
        const fullUrl = match[1];
        const urlObj = new URL(fullUrl);
        path = urlObj.pathname + urlObj.search;
      }
    }
  }

  return products;
}

async function refreshCatalog() {
  const products = await fetchCatalogFromShopify();
  if (!products.length) return catalogRam || [];

  catalogRam   = products;
  catalogRamTs = Date.now();

  const redis = await getRedis();
  if (redis) {
    try {
      await redis.setEx(CATALOG_KEY, CATALOG_TTL, JSON.stringify(products));
    } catch (e) {
      // Redis fallback silencioso — ya está en RAM
    }
  }

  return products;
}

async function getCatalog() {
  // Intentar Redis primero
  const redis = await getRedis();
  if (redis) {
    try {
      const cached = await redis.get(CATALOG_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length) return parsed;
      }
    } catch (e) {
      // Seguir a RAM
    }
  }

  // Fallback a RAM si está fresco (< 2h)
  if (catalogRam && (Date.now() - catalogRamTs) < 7200_000) {
    return catalogRam;
  }

  // Refrescar
  return await refreshCatalog();
}

// ── Export ───────────────────────────────────────────────────────────────────
module.exports = {
  findCustomer,
  getRecentOrders,
  buildCustomerContext,
  buildSlackCustomerInfo,
  enrichContact,
  getOrderByNumber,
  fetchCatalogFromShopify,
  getCatalog,
  refreshCatalog
};