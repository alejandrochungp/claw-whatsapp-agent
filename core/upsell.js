/**
 * core/upsell.js — Upsell post-compra vía WhatsApp
 *
 * Mejoras:
 * 1. Contexto completo en Slack al recibir respuesta del cliente
 * 2. Lógica de selección por ticket: no recomendar si sube mucho el precio
 * 3. Si compra múltiples productos → elige el de mayor precio como referencia
 * 4. Al aceptar → notifica #logistics (C03L5HDQ0Q5)
 * 5. Draft Order con link de pago para agregar el complemento
 */

const meta      = require('./meta');
const logger    = require('./logger');
const slack     = require('./slack');
const https     = require('https');
const complementos = require('../tenants/yeppo/complementos.json');

const UPSELL_DELAY_MS   = process.env.UPSELL_TEST_MODE === 'true' ? 5000 : 15 * 60 * 1000;
const LOGISTICS_CHANNEL = 'C03L5HDQ0Q5';
// No recomendar si el complemento sube el ticket en más de este %
const MAX_UPSELL_PCT    = 0.5; // 50% del total del pedido

// ── Shopify API helper ───────────────────────────────────────────────────────
function shopifyRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const token = process.env.SHOPIFY_TOKEN;
    const store = process.env.SHOPIFY_STORE || '59c6fd-2.myshopify.com';
    const data  = body ? JSON.stringify(body) : null;

    const options = {
      hostname: store,
      path:     `/admin/api/2024-01${path}`,
      method,
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

// ── Buscar precio de un producto por título parcial ──────────────────────────
async function getPrecioComplemento(nombre) {
  try {
    const r = await shopifyRequest('GET', `/products.json?title=${encodeURIComponent(nombre)}&fields=title,variants&limit=5`);
    const products = r?.products || [];
    // Buscar el que más se parece
    const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const target = norm(nombre);
    const match = products.find(p => norm(p.title).includes(target)) || products[0];
    return match ? parseFloat(match.variants?.[0]?.price || 0) : 0;
  } catch { return 0; }
}

// ── Normalizar texto ─────────────────────────────────────────────────────────
function normalize(str) {
  return (str || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '').trim();
}

function nombreLimpio(str) {
  return str.split(' ').map(w =>
    w.length > 3 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()
  ).join(' ');
}

// ── Seleccionar mejor complemento para el pedido ─────────────────────────────
// Si hay múltiples productos, usa el de mayor precio como referencia
// No recomienda si el complemento sube el ticket en más de MAX_UPSELL_PCT
async function findComplemento(lineItems) {
  // Calcular total del pedido
  const totalPedido = lineItems.reduce((sum, i) => sum + parseFloat(i.price || 0) * (i.quantity || 1), 0);

  // Ordenar por precio desc — usar el más caro como referencia principal
  const sorted = [...lineItems].sort((a, b) => parseFloat(b.price || 0) - parseFloat(a.price || 0));

  for (const item of sorted) {
    const itemName = normalize(item.title || item.name || '');
    for (const par of complementos.pares) {
      if (itemName.includes(normalize(par.producto))) {
        const yaComprado = lineItems.some(i =>
          normalize(i.title || i.name || '').includes(normalize(par.complemento))
        );
        if (yaComprado) continue;

        // Obtener precio del complemento
        const precioComplemento = par.precio || await getPrecioComplemento(par.complemento);

        // No recomendar si sube el ticket en más del MAX_UPSELL_PCT
        if (totalPedido > 0 && precioComplemento / totalPedido > MAX_UPSELL_PCT) {
          logger.log(`[upsell] Complemento ${par.complemento} omitido — sube ticket ${Math.round(precioComplemento/totalPedido*100)}% (máx ${MAX_UPSELL_PCT*100}%)`);
          continue;
        }

        return { item, par, precioComplemento, totalPedido };
      }
    }
  }
  return null;
}

// ── Extraer teléfono del pedido ──────────────────────────────────────────────
function extractPhone(order) {
  const sources = [
    order.shipping_address?.phone,
    order.billing_address?.phone,
    order.customer?.phone,
    order.phone
  ];
  for (const raw of sources) {
    if (!raw) continue;
    const digits = raw.replace(/\D/g, '');
    if (digits.startsWith('56') && digits.length === 11) return digits;
    if (digits.startsWith('9') && digits.length === 9)  return `56${digits}`;
    if (digits.length === 8) return `569${digits}`;
    if (digits.length >= 10) return digits;
  }
  return null;
}

// ── Modificar pedido original agregando el complemento + obtener link de pago ─
async function editOrder(order, match) {
  try {
    const orderId = order.id;

    // 1. Iniciar edición del pedido
    const beginEdit = await shopifyRequest('POST', `/orders/${orderId}/edits.json`, {
      order_edit: { reason: `Upsell post-compra — agregar ${match.par.complemento}` }
    });

    const editId = beginEdit?.order_edit?.id;
    if (!editId) throw new Error('No se pudo iniciar edición del pedido');

    // 2. Buscar variant_id del complemento en Shopify
    const searchResult = await shopifyRequest('GET', `/products.json?title=${encodeURIComponent(match.par.complemento)}&fields=id,title,variants&limit=5`);
    const products = searchResult?.products || [];
    const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const product = products.find(p => norm(p.title).includes(norm(match.par.complemento))) || products[0];
    const variantId = product?.variants?.[0]?.id;

    if (!variantId) throw new Error(`No se encontró variant_id para ${match.par.complemento}`);

    // 3. Agregar producto a la edición
    await shopifyRequest('POST', `/orders/${orderId}/edits/${editId}/line_items.json`, {
      line_item: {
        variant_id: variantId,
        quantity: 1,
        applied_discount: {
          value_type: 'fixed_amount',
          value: '0',  // Sin descuento en envío
          description: 'Envío incluido en pedido original'
        }
      }
    });

    // 4. Confirmar edición y obtener link de pago
    const committed = await shopifyRequest('POST', `/orders/${orderId}/edits/${editId}/commit.json`, {
      order_edit: {
        notify_customer: false,  // No notificar por email — lo hace el agente por WA
        staffNote: `Upsell agregado por agente WhatsApp — ${match.par.complemento}`
      }
    });

    const paymentUrl = committed?.order_edit?.invoice_url || null;
    logger.log(`[upsell] Pedido #${order.name} editado — complemento agregado, link: ${paymentUrl}`);

    return { success: true, paymentUrl };

  } catch (err) {
    logger.log(`[upsell] Error editando pedido: ${err.message}`);
    return { success: false, paymentUrl: null };
  }
}

// ── Notificar #logistics ─────────────────────────────────────────────────────
async function notifyLogistics(order, match, phone, invoiceUrl, config) {
  const nombre  = order.customer?.first_name || '';
  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken) return;

  const axios = require('axios');
  const msg = `🛍️ *Upsell aceptado — modificación de pedido*

*Pedido original:* ${order.name}
*Cliente:* ${nombre} (+${phone})
*Producto original:* ${match.item.title}
*Complemento agregado:* ${match.par.complemento} ($${match.precioComplemento.toLocaleString('es-CL')})

*Link de pago:* ${invoiceUrl || 'pendiente'}

Verificar que el complemento se incluya en el despacho del pedido original.`;

  await axios.post('https://slack.com/api/chat.postMessage',
    { channel: LOGISTICS_CHANNEL, text: msg },
    { headers: { Authorization: `Bearer ${slackToken}`, 'Content-Type': 'application/json' } }
  ).catch(e => logger.log(`[upsell] Slack logistics error: ${e.message}`));

  logger.log(`[upsell] ✅ Notificación enviada a #logistics`);
}

// ── Contexto de la conversación en Slack ─────────────────────────────────────
async function createUpsellThread(phone, order, match, config) {
  const nombre     = order.customer?.first_name || '';
  const phoneLabel = `+${phone}`;
  const slackToken = process.env.SLACK_BOT_TOKEN;
  const channel    = process.env.SLACK_CHANNEL_ID || config.slackChannel;
  if (!slackToken) return;

  const axios = require('axios');
  const headerText = `🛍️ *Upsell post-compra* — ${phoneLabel}${nombre ? ` (${nombre})` : ''}

*Pedido:* ${order.name} — $${parseFloat(order.total_price || 0).toLocaleString('es-CL')}
*Producto comprado:* ${match.item.title}
*Complemento ofrecido:* ${match.par.complemento} — $${match.precioComplemento.toLocaleString('es-CL')}
*Razón:* ${match.par.razon}

Escribe \`tomar\` para tomar control o espera la respuesta del cliente.`;

  const result = await axios.post('https://slack.com/api/chat.postMessage',
    { channel, text: headerText },
    { headers: { Authorization: `Bearer ${slackToken}`, 'Content-Type': 'application/json' } }
  ).then(r => r.data).catch(() => null);

  if (result?.ts) {
    const threadData = { thread_ts: result.ts, channel, timestamp: Date.now(), isUpsell: true, orderId: order.id, match };
    slack.phoneToThread.set(phone, threadData);
    await slack.saveThreadExternal(phone, threadData);
    logger.log(`[upsell] Thread Slack creado para ${phone}`);
  }
}

// ── Handler principal ────────────────────────────────────────────────────────
async function handleNewOrder(order, config) {
  try {
    const phone = extractPhone(order);
    if (!phone) {
      logger.log(`[upsell] Pedido #${order.name} sin teléfono — omitiendo`);
      return;
    }

    const lineItems = order.line_items || [];
    if (!lineItems.length) return;

    const match = await findComplemento(lineItems);
    if (!match) {
      logger.log(`[upsell] Pedido #${order.name} — sin complemento relevante o precio muy alto`);
      return;
    }

    logger.log(`[upsell] Pedido #${order.name} — upsell en ${UPSELL_DELAY_MS/1000}s → ${match.par.complemento} ($${match.precioComplemento})`);

    // Guardar contexto del upsell en memoria para cuando el cliente responda
    const memory = require('./memory');
    await memory.updateContext(phone, {
      upsellPendiente: true,
      upsellOrderId:   order.id,
      upsellOrderName: order.name,
      upsellMatch:     { producto: match.item.title, complemento: match.par.complemento, precio: match.precioComplemento }
    });

    setTimeout(async () => {
      // 1. Crear thread en Slack con contexto completo
      await createUpsellThread(phone, order, match, config);

      // 2. Enviar mensaje WhatsApp
      const nombre           = order.customer?.first_name || order.shipping_address?.first_name || '';
      const saludo           = nombre ? `hola ${nombre}!` : 'hola!';
      const productoLimpio   = nombreLimpio(match.item.title);
      const complementoLimpio = nombreLimpio(match.par.complemento);
      const precioStr        = match.precioComplemento > 0 ? ` ($${Math.round(match.precioComplemento).toLocaleString('es-CL')})` : '';

      const msg = `${saludo} tu pedido ya está confirmado 🎉

llevaste el ${productoLimpio} — muchas clientas lo combinan con el ${complementoLimpio}${precioStr} porque ${match.par.razon} 🌟

si quieres te lo agregamos antes del despacho, te lo enviamos todo junto sin costo adicional de envío. avisame si te interesa!`;

      await meta.sendMessage(phone, msg, config);
      logger.log(`[upsell] ✅ Mensaje enviado a ${phone}`);
    }, UPSELL_DELAY_MS);

  } catch (err) {
    logger.log(`[upsell] Error: ${err.message}`);
  }
}

// ── Handler cuando cliente acepta el upsell ──────────────────────────────────
// Llamado desde business.js cuando el cliente responde afirmativamente
async function handleUpsellAccepted(phone, order, match, config) {
  try {
    logger.log(`[upsell] Cliente ${phone} aceptó upsell — creando draft order`);

    // 1. Modificar pedido original agregando el complemento
    const edit = await editOrder(order, match);
    const invoiceUrl = edit?.paymentUrl;

    // 2. Notificar #logistics
    await notifyLogistics(order, match, phone, invoiceUrl, config);

    // 3. Responder al cliente con el link
    let msgCliente;
    if (invoiceUrl) {
      msgCliente = `perfecto! te paso el link para completar el pago del ${nombreLimpio(match.par.complemento)} 👇\n\n${invoiceUrl}\n\nes un pago separado pero lo despachamos junto con tu pedido 🚚`;
    } else {
      msgCliente = `perfecto! ya le avisé al equipo para coordinar el envío del ${nombreLimpio(match.par.complemento)} junto con tu pedido. te contactarán para el pago 😊`;
    }

    await meta.sendMessage(phone, msgCliente, config);

    // 4. Limpiar contexto upsell
    const memory = require('./memory');
    await memory.updateContext(phone, { upsellPendiente: false });

    logger.log(`[upsell] ✅ Flujo completo para ${phone}`);
  } catch (err) {
    logger.log(`[upsell] Error handleUpsellAccepted: ${err.message}`);
  }
}

module.exports = { handleNewOrder, handleUpsellAccepted };
