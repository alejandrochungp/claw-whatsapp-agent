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

module.exports = { enrichContact };
