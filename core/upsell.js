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

// ── Shopify REST helper ──────────────────────────────────────────────────────
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

// ── Shopify GraphQL helper ───────────────────────────────────────────────────
function shopifyGraphQL(query, variables) {
  return new Promise((resolve, reject) => {
    const token = process.env.SHOPIFY_TOKEN;
    const store = process.env.SHOPIFY_STORE || '59c6fd-2.myshopify.com';
    const data  = JSON.stringify({ query, variables });

    const options = {
      hostname: store,
      path:     '/admin/api/2024-01/graphql.json',
      method:   'POST',
      headers:  {
        'X-Shopify-Access-Token': token,
        'Content-Type':           'application/json',
        'Content-Length':         Buffer.byteLength(data)
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
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('GraphQL timeout')); });
    req.write(data);
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

        // Filtro de precio desactivado — siempre recomendar
        // TODO: definir lógica de precio con Alejandro

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

// ── Obtener location_id del pedido original ──────────────────────────────────
async function getOrderLocationId(orderId) {
  try {
    const r = await shopifyRequest('GET', `/orders/${orderId}.json?fields=id,fulfillments,location_id`);
    // Intentar desde fulfillments primero
    const fulfillmentLocationId = r?.order?.fulfillments?.[0]?.location_id;
    if (fulfillmentLocationId) return fulfillmentLocationId;
    // Fallback: location_id directo del pedido
    return r?.order?.location_id || null;
  } catch { return null; }
}

// ── Obtener link de pago de la diferencia via payment terms ──────────────────
async function getPaymentLink(orderId) {
  try {
    // Usar send_invoice para enviar por email al cliente
    const r = await shopifyRequest('POST', `/orders/${orderId}/send_invoice.json`, {});
    if (r?.order_invoice) return true;
    return false;
  } catch { return false; }
}

// ── Modificar pedido original vía GraphQL Order Edits API ───────────────────
async function editOrder(order, match) {
  try {
    const orderGid = `gid://shopify/Order/${order.id}`;

    // 1. Usar variantId directo de la tabla de complementos
    const variantId = match.par.variantId;
    if (!variantId) throw new Error(`variantId no configurado para: ${match.par.complemento}`);
    const variantGid = `gid://shopify/ProductVariant/${variantId}`;

    // 1b. Obtener location_id del pedido original
    const locationId = await getOrderLocationId(order.id);
    const locationGid = locationId ? `gid://shopify/Location/${locationId}` : null;
    if (locationId) logger.log(`[upsell] Usando location: ${locationId}`);

    logger.log(`[upsell] Variant encontrado: ${variantGid}`);

    // 2. Iniciar edición (GraphQL)
    const beginResult = await shopifyGraphQL(`
      mutation orderEditBegin($id: ID!) {
        orderEditBegin(id: $id) {
          calculatedOrder { id }
          userErrors { field message }
        }
      }
    `, { id: orderGid });

    const errors1 = beginResult?.data?.orderEditBegin?.userErrors;
    if (errors1?.length) throw new Error(errors1.map(e => e.message).join(', '));

    const calcOrderId = beginResult?.data?.orderEditBegin?.calculatedOrder?.id;
    if (!calcOrderId) throw new Error('No se obtuvo calculatedOrder ID');

    // 3. Agregar producto a la edición (con location si está disponible)
    const addVars = { id: calcOrderId, variantId: variantGid, quantity: 1 };
    const addMutation = locationGid
      ? `mutation orderEditAddVariant($id: ID!, $variantId: ID!, $quantity: Int!, $locationId: ID!) {
          orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity, locationId: $locationId) {
            calculatedOrder { id }
            calculatedLineItem { id }
            userErrors { field message }
          }
        }`
      : `mutation orderEditAddVariant($id: ID!, $variantId: ID!, $quantity: Int!) {
          orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity) {
            calculatedOrder { id }
            calculatedLineItem { id }
            userErrors { field message }
          }
        }`;
    if (locationGid) addVars.locationId = locationGid;

    const addResult = await shopifyGraphQL(addMutation, addVars);

    const errors2 = addResult?.data?.orderEditAddVariant?.userErrors;
    if (errors2?.length) throw new Error(errors2.map(e => e.message).join(', '));

    // 4. Confirmar edición
    const commitResult = await shopifyGraphQL(`
      mutation orderEditCommit($id: ID!) {
        orderEditCommit(id: $id, notifyCustomer: false, staffNote: "Upsell WhatsApp — complemento agregado") {
          order { id name }
          userErrors { field message }
        }
      }
    `, { id: calcOrderId });

    const errors3 = commitResult?.data?.orderEditCommit?.userErrors;
    if (errors3?.length) throw new Error(errors3.map(e => e.message).join(', '));

    // 5. Mover fulfillment order del complemento a la misma ubicación del pedido original
    if (locationId) {
      try {
        const foResult = await shopifyRequest('GET', `/orders/${order.id}/fulfillment_orders.json`);
        const openFOs = (foResult?.fulfillment_orders || []).filter(fo =>
          fo.status === 'open' && fo.assigned_location_id !== locationId &&
          fo.line_items?.some(li => li.variant_id?.toString() === variantId.toString())
        );

        for (const fo of openFOs) {
          await shopifyRequest('POST', `/fulfillment_orders/${fo.id}/move.json`, {
            fulfillment_order: { new_location_id: locationId }
          });
          logger.log(`[upsell] FO ${fo.id} movido de ${fo.assigned_location_id} → ${locationId}`);
        }
      } catch (e) {
        logger.log(`[upsell] Warning: no se pudo mover FO: ${e.message}`);
      }
    }

    // 6. Enviar factura al cliente por email
    const invoiceResult = await shopifyGraphQL(`
      mutation orderInvoiceSend($id: ID!) {
        orderInvoiceSend(id: $id) {
          order { id name email }
          userErrors { field message }
        }
      }
    `, { id: orderGid }).catch(e => { logger.log(`[upsell] invoice catch: ${e.message}`); return null; });

    const invoiceErrors = invoiceResult?.data?.orderInvoiceSend?.userErrors;
    const invoiceOrder  = invoiceResult?.data?.orderInvoiceSend?.order;
    if (invoiceErrors?.length) {
      logger.log(`[upsell] ❌ Invoice error: ${JSON.stringify(invoiceErrors)}`);
    } else if (invoiceOrder) {
      logger.log(`[upsell] ✅ Factura enviada a: ${invoiceOrder.email}`);
    } else {
      logger.log(`[upsell] ⚠️ Invoice resultado inesperado: ${JSON.stringify(invoiceResult)}`);
    }
    const invoiceSent = !invoiceErrors?.length && !!invoiceOrder;
    logger.log(`[upsell] ✅ Pedido ${order.name} editado — ${match.par.complemento} agregado, location OK${invoiceSent ? ', factura enviada' : ', sin factura'}`);
    return { success: true, invoiceSent };

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

// ── Notificar pago completo del complemento upsell ───────────────────────────
async function notifyPaymentComplete(phone, order, pendingUpsell, config) {
  try {
    const axios     = require('axios');
    const slackToken = process.env.SLACK_BOT_TOKEN;
    const nombre    = order.customer?.first_name || '';
    const complemento = pendingUpsell.match?.complemento || 'complemento';
    const precio    = pendingUpsell.match?.precio || 0;

    // Notificar #logistics
    const logisticsMsg = `✅ *Pago de complemento confirmado*

*Cliente:* ${nombre ? nombre + ' — ' : ''}+${phone}
*Pedido:* ${order.name}
*Complemento pagado:* ${complemento} ($${Math.round(precio).toLocaleString('es-CL')})

El pedido ya incluye el complemento. Despachar todo junto.`;

    if (slackToken) {
      await axios.post('https://slack.com/api/chat.postMessage', {
        channel: LOGISTICS_CHANNEL,
        text: logisticsMsg
      }, { headers: { Authorization: `Bearer ${slackToken}`, 'Content-Type': 'application/json' } })
      .catch(e => logger.log(`[upsell] Error notif logistics pago: ${e.message}`));

      // También notificar en el thread del cliente en el canal principal
      const threadData = slack.phoneToThread.get(phone);
      const mainChannel = process.env.SLACK_CHANNEL_ID || process.env.SLACK_CHANNEL_WHATSAPP || 'C05FES87S9J';
      if (threadData?.thread_ts) {
        await axios.post('https://slack.com/api/chat.postMessage', {
          channel: threadData.channel || mainChannel,
          thread_ts: threadData.thread_ts,
          text: `✅ *Pago del complemento confirmado* — ${complemento} ($${Math.round(precio).toLocaleString('es-CL')})\nDespachar todo junto con pedido ${order.name}.`
        }, { headers: { Authorization: `Bearer ${slackToken}`, 'Content-Type': 'application/json' } })
        .catch(() => {});
      }
    }

    // Mensaje al cliente confirmando
    await meta.sendMessage(phone, `listo! el pago quedó confirmado 🎉 agregamos el ${nombreLimpio(complemento)} a tu pedido y lo despachamos todo junto. cualquier duda me avisas!`, config);

    logger.log(`[upsell] ✅ Pago complemento confirmado para ${phone} — ${complemento}`);
  } catch (e) {
    logger.log(`[upsell] Error notifyPaymentComplete: ${e.message}`);
  }
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

    const memory = require('./memory');

    // ── Ignorar si es un pago de complemento upsell ya aceptado ──────────
    // Cuando el cliente paga el link del complemento, Shopify dispara otro
    // webhook paid para el mismo pedido editado. Lo detectamos así:
    // 1. El pedido tiene nota o tag de upsell, o
    // 2. Ya no hay upsell pendiente para este cliente (ya lo aceptó/rechazó)
    //    y el pedido tiene más de 1 line_item con el mismo orderId que el upsell
    const tags = (order.tags || '').toLowerCase();
    if (tags.includes('upsell-paid') || tags.includes('upsell_paid')) {
      logger.log(`[upsell] Pedido #${order.name} — pago de upsell ya procesado, ignorando`);
      return;
    }

    // Si hay un upsell ACEPTADO para este número Y el orderId coincide → es el webhook de pago del complemento
    const pendingUpsell = await memory.getUpsellPending(phone);
    if (pendingUpsell && pendingUpsell.status === 'accepted' && String(pendingUpsell.orderId) === String(order.id)) {
      logger.log(`[upsell] Pedido #${order.name} — pago de complemento confirmado → notificando`);
      await notifyPaymentComplete(phone, order, pendingUpsell, config);
      await memory.clearUpsellPending(phone);
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

    setTimeout(async () => {
      // 1. Crear thread en Slack con contexto completo
      await createUpsellThread(phone, order, match, config);

      // 2. Guardar upsell pendiente en clave Redis separada (después del delay, justo antes de enviar)
      // Así evitamos race conditions con mensajes entrantes del cliente
      await memory.setUpsellPending(phone, {
        orderId:   order.id,
        orderName: order.name,
        match:     { producto: match.item.title, complemento: match.par.complemento, precio: match.precioComplemento, variantId: match.par.variantId }
      });

      // 3. Enviar mensaje WhatsApp
      const nombre            = order.customer?.first_name || order.shipping_address?.first_name || '';
      const saludo            = nombre ? `hola ${nombre}!` : 'hola!';
      const productoLimpio    = nombreLimpio(match.item.title);
      const complementoLimpio = nombreLimpio(match.par.complemento);
      const precioStr         = match.precioComplemento > 0 ? ` ($${Math.round(match.precioComplemento).toLocaleString('es-CL')})` : '';

      // Usar template aprobado (evita error 131047 - ventana 24h)
      const templateName = process.env.UPSELL_TEMPLATE || 'pago_confirmado_upsell';
      const templateResult = await meta.sendTemplate(phone, templateName, 'es_CL', [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: nombre || 'ahí' },           // {{1}} nombre
            { type: 'text', text: productoLimpio },             // {{2}} producto comprado
            { type: 'text', text: complementoLimpio },          // {{3}} complemento
            { type: 'text', text: match.par.razon || 'se complementan perfecto' } // {{4}} razón
          ]
        }
      ]);

      // Fallback a texto libre si el template falla (ej: cliente dentro de ventana 24h)
      if (!templateResult) {
        const msg = `${saludo} tu pedido ya está confirmado!\n\nllevaste el ${productoLimpio} — muchas clientas lo combinan con el ${complementoLimpio}${precioStr} porque ${match.par.razon}\n\nsi quieres te lo agregamos antes del despacho, te lo enviamos todo junto sin costo adicional. avisame si te interesa!`;
        await meta.sendMessage(phone, msg, config);
      }
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

    // 2. Notificar #logistics
    await notifyLogistics(order, match, phone, null, config);

    // 3. Responder al cliente
    let msgCliente;
    if (edit?.invoiceSent) {
      msgCliente = `perfecto! agregamos el ${nombreLimpio(match.par.complemento)} a tu pedido 🎉\n\nte llegará un email con el link para pagar la diferencia. una vez confirmado lo despachamos todo junto 🚚`;
    } else {
      msgCliente = `perfecto! ya agregamos el ${nombreLimpio(match.par.complemento)} a tu pedido. el equipo te contactará para coordinar el pago y lo despachamos todo junto 😊`;
    }

    await meta.sendMessage(phone, msgCliente, config);

    // 4. Marcar como aceptado (no borrar — necesitamos el orderId para detectar el webhook de pago)
    const memory = require('./memory');
    const existing = await memory.getUpsellPending(phone);
    if (existing) {
      await memory.setUpsellPending(phone, { ...existing, status: 'accepted' });
    }

    logger.log(`[upsell] ✅ Flujo completo para ${phone} — esperando pago del complemento`);
  } catch (err) {
    logger.log(`[upsell] Error handleUpsellAccepted: ${err.message}`);
  }
}

module.exports = { handleNewOrder, handleUpsellAccepted };
