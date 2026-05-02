/**
 * core/shopify.js ÔÇö Lookup de clientes en Shopify por n├║mero de tel├®fono
 *
 * Busca en m├║ltiples formatos porque los n├║meros pueden estar guardados
 * de distintas maneras en Shopify (con/sin +56, con/sin 9, etc.)
 */

const https = require('https');

const SHOP  = process.env.SHOPIFY_STORE  || '59c6fd-2.myshopify.com';
const TOKEN = process.env.SHOPIFY_TOKEN;
const API   = '2024-01';

// ÔöÇÔöÇ Normalizar n├║mero a m├║ltiples formatos para b├║squeda ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
function phoneVariants(phone) {
  // phone llega como "56977282566" (sin +)
  const digits = phone.replace(/\D/g, '');

  const variants = new Set();

  // Con + completo
  variants.add(`+${digits}`);
  // Sin +
  variants.add(digits);

  // Si empieza con 56 ÔåÆ tambi├®n probar sin 56
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

// ÔöÇÔöÇ Request helper ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
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

// Versi├│n que devuelve body + headers (para paginaci├│n con Link)
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

// ÔöÇÔöÇ Verificar que el tel├®fono del cliente realmente coincide ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
function phonesMatch(searchPhone, customerPhone) {
  if (!customerPhone) return false;
  // Normalizar ambos a solo d├¡gitos
  const a = searchPhone.replace(/\D/g, '');
  const b = customerPhone.replace(/\D/g, '');
  // Comparar los ├║ltimos 9 d├¡gitos (n├║mero local sin prefijo pa├¡s)
  const aSuffix = a.slice(-9);
  const bSuffix = b.slice(-9);
  return aSuffix === bSuffix;
}

// ÔöÇÔöÇ Buscar cliente por tel├®fono ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
async function findCustomer(phone) {
  if (!TOKEN) return null;

  const variants = phoneVariants(phone);

  for (const variant of variants) {
    const encoded = encodeURIComponent(variant);
    const result  = await shopifyGet(`/customers/search.json?query=phone:${encoded}&limit=5&fields=id,first_name,last_name,email,phone,orders_count,total_spent,tags,note`);

    if (result?.customers?.length) {
      // Verificar que el tel├®fono realmente coincide ÔÇö Shopify hace b├║squeda parcial
      const exactMatch = result.customers.find(c => phonesMatch(phone, c.phone));
      if (exactMatch) return exactMatch;
    }
  }

  return null;
}

// ÔöÇÔöÇ Obtener ├║ltimos pedidos del cliente ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
async function getRecentOrders(customerId, limit = 3) {
  if (!TOKEN || !customerId) return [];

  const result = await shopifyGet(`/orders.json?customer_id=${customerId}&limit=${limit}&status=any&fields=id,name,created_at,financial_status,fulfillment_status,total_price,line_items`);

  return result?.orders || [];
}

// ÔöÇÔöÇ Formatear contexto para Claude ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
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
    ctx += `\n├ÜLTIMOS PEDIDOS:\n`;
    for (const order of orders) {
      const date    = new Date(order.created_at).toLocaleDateString('es-CL');
      const status  = order.fulfillment_status || 'pendiente';
      const payment = order.financial_status || '?';
      const total   = `$${parseFloat(order.total_price).toLocaleString('es-CL')}`;
      const items   = order.line_items?.map(i => i.name).join(', ') || '';
      ctx += `  ÔÇó ${order.name} (${date}) ÔÇö ${total} ÔÇö ${status} ÔÇö ${payment}\n`;
      if (items) ctx += `    Productos: ${items}\n`;
    }
  } else {
    ctx += `\nSin pedidos registrados.\n`;
  }

  return ctx;
}

// ÔöÇÔöÇ Formatear para mensaje de Slack ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
function buildSlackCustomerInfo(customer, orders) {
  if (!customer) return null;

  const name  = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || 'Cliente';
  const spent = customer.total_spent ? `$${parseFloat(customer.total_spent).toLocaleString('es-CL')}` : '?';

  let info = `\n­ƒæñ *Cliente Shopify identificado:* ${name}`;
  if (customer.email) info += ` (${customer.email})`;
  info += `\n­ƒøì´©Å ${customer.orders_count || 0} pedidos | Total gastado: ${spent}`;

  if (orders.length) {
    info += `\n­ƒôª ├Ültimo pedido: ${orders[0].name} ÔÇö $${parseFloat(orders[0].total_price).toLocaleString('es-CL')} ÔÇö ${orders[0].fulfillment_status || 'pendiente'}`;
  }

  return info;
}

// ÔöÇÔöÇ API principal ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
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

// ÔöÇÔöÇ Cat├ílogo de productos con cach├® Redis ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
// Solo campos necesarios para el bot: t├¡tulo, precio, stock, tipo
// Se refresca cada hora ÔÇö no se consulta en cada mensaje, solo cuando relevante

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
    console.log('[shopify] fetch productos - count:', r?.products?.length, 'link:', linkHeader ? 's├¡' : 'no');
    if (!r?.products?.length) break;

    for (const p of r.products) {
      // Para productos con m├║ltiples variantes, tomar la de menor precio con stock
      const variants = p.variants || [];
      const activeVariants = variants.filter(v => (v.inventory_quantity || 0) > 0 || v.inventory_policy === 'continue');
      const bestVariant = activeVariants.sort((a, b) => parseFloat(a.price) - parseFloat(b.price))[0] || variants[0];

      if (!bestVariant) continue;

      // Limpiar HTML de la descripci├│n
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

    // Paginaci├│n via header Link de Shopify
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
    // Fallback RAM ÔÇö TTL 1 hora
    if (catalogRam && Date.now() - catalogRamTs < CATALOG_TTL * 1000) return catalogRam;
  }

  // Fetch desde Shopify
  console.log('[shopify] Refrescando cat├ílogo de productos...');
  const products = await fetchCatalogFromShopify();

  // Guardar en cach├®
  if (redis) {
    try { await redis.setEx(CATALOG_KEY, CATALOG_TTL, JSON.stringify(products)); } catch {}
  } else {
    catalogRam   = products;
    catalogRamTs = Date.now();
  }

  console.log(`[shopify] Cat├ílogo cargado: ${products.length} productos`);
  return products;
}

// ÔöÇÔöÇ Buscar productos relevantes por query del cliente ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
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

// ÔöÇÔöÇ Formatear cat├ílogo para el prompt de Claude ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
function formatCatalogForPrompt(products) {
  if (!products?.length) return '';
  const lines = products.map(p => {
    const precio = `$${Math.round(p.price).toLocaleString('es-CL')}`;
    const stock  = p.stock ? 'Ô£à' : 'ÔØî sin stock';
    const variant = p.variantTitle ? ` (${p.variantTitle})` : '';
    const link    = p.handle ? `https://yeppo.cl/products/${p.handle}` : '';
    const desc    = p.description ? `\n  ${p.description}` : '';
    return `ÔÇó ${p.title}${variant} ÔÇö ${precio} ÔÇö ${stock}${link ? ` ÔÇö ${link}` : ''}${desc}`;
  });
  return lines.join('\n');
}

// ÔöÇÔöÇ Detectar si el mensaje pregunta por productos/stock/precios ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
function isProductQuery(text) {
  const t = (text || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // quitar tildes para comparar

  // Palabras clave de precio
  const precioKw = ['precio', 'costo', 'valor', 'vale', 'cuesta', 'cobran', 'cuanto', 'cu├ínto',
    'tarifa', 'monto', 'importe', 'rate', 'sale', 'oferta', 'descuento', 'promo'];

  // Palabras clave de disponibilidad / producto
  const prodKw = ['stock', 'disponible', 'disponibilidad', 'tienen', 'tienes', 'hay', 'existe',
    'venden', 'busco', 'producto', 'catalogo', 'catalogo', 'quiero', 'necesito',
    'me gustaria', 'podrian', 'podrian', 'quisiera'];

  const all = [...precioKw, ...prodKw];
  return all.some(kw => t.includes(kw));
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


// ── Consulta de estado de pedido por número ──────────────────────────────────

function normalizeOrderNumber(input) {
  const s = String(input).trim().replace(/^#/, '');
  return /^\d{4,6}$/.test(s) ? '#' + s : null;
}

async function getOrderByNumber(rawInput) {
  const raw = String(rawInput).trim();
  // Soporta: 247090, #247090, n247090, #n247090 (formato POS Shopify)
  const m = raw.match(/^#?n?(\d{4,6})$/i);
  if (!m) return { found: false, error: 'Numero de pedido invalido' };
  // Shopify POS usa prefijo 'n', ecommerce usa '#'
  // Probar ambos formatos
  const orderNameN = '#n' + m[1];
  const orderNameH = '#' + m[1];

  try {
    // Probar formato POS (#n247090) primero, luego ecommerce (#247090)
    let result = await shopifyGet(
      '/orders.json?name=' + encodeURIComponent(orderNameN) +
      '&status=any&limit=5&fields=id,name,financial_status,fulfillment_status,fulfillments,total_price'
    );
    if (!result || !result.orders || !result.orders.length) {
      result = await shopifyGet(
        '/orders.json?name=' + encodeURIComponent(orderNameH) +
        '&status=any&limit=5&fields=id,name,financial_status,fulfillment_status,fulfillments,total_price'
      );
    }
    const orderName = orderNameN; // para mensaje de error
    if (!result || !result.orders || !result.orders.length) {
      return { found: false, orderNumber: m[1] };
    }
    const order = result.orders.find(function(o) { return o.name === orderNameN || o.name === orderNameH; }) || result.orders[0];

    let trackingUrl = null;
    let trackingCompany = null;
    const shipmentStatus = order.fulfillment_status || 'pendiente';

    if (order.fulfillments && order.fulfillments.length > 0) {
      const last = order.fulfillments[order.fulfillments.length - 1];
      trackingUrl     = last.tracking_url || null;
      trackingCompany = last.tracking_company || null;
    }

    const total = parseFloat(order.total_price || 0).toLocaleString('es-CL');
    const statusMap = {
      'fulfilled':   'despachado',
      'unfulfilled': 'en preparacion',
      'partial':     'parcialmente despachado',
      'pendiente':   'en preparacion'
    };
    const statusText = statusMap[shipmentStatus] || shipmentStatus;

    let reply = 'Holi! Tu pedido *' + orderName + '* esta *' + statusText + '* (total: $' + total + ').\n';
    if (trackingUrl && trackingCompany) {
      reply += 'Enviado por *' + trackingCompany + '*. Sigue tu envio aca: ' + trackingUrl;
    } else if (shipmentStatus === 'unfulfilled' || shipmentStatus === 'pendiente') {
      reply += 'Aun lo estamos preparando. Cuando salga te llega el link de seguimiento.';
    } else {
      reply += 'Cualquier duda me avisas!';
    }

    return {
      found:             true,
      orderNumber:       orderName,
      fulfillmentStatus: shipmentStatus,
      trackingUrl:       trackingUrl,
      trackingCompany:   trackingCompany,
      botReply:          reply
    };
  } catch (err) {
    return { found: false, error: 'Error consultando Shopify: ' + (err.message || 'desconocido') };
  }
}


module.exports = {
  getOrderByNumber, enrichContact, getProductCatalog, searchCatalog, formatCatalogForPrompt, isProductQuery, invalidateCatalog };
