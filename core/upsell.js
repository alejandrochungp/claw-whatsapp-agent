/**
 * core/upsell.js — Lógica de upselling post-compra
 *
 * Procesa webhooks de Shopify (order_paid) y determina si corresponde
 * enviar un mensaje de upsell al cliente 1 hora después del pedido.
 *
 * El complemento sugerido no puede superar MAX_UPSELL_PCT (50%) del
 * producto más caro del pedido original, para evitar ofrecer productos
 * desproporcionadamente más costosos.
 */

const memory = require('./memory');
const meta   = require('./meta');
const slack  = require('./slack');
const logger = require('./logger');
const shopifyCatalog = require('./shopify').catalog || []; // catálogo compartido

// ── Constante de filtro ───────────────────────────────────────────────────────
const MAX_UPSELL_PCT = 0.5; // 50% — el complemento no puede superar este % del precio referencia

// ── Configuración de campañas especiales de upsell ────────────────────────────
let upsellCampaignConfig = null;
try {
  upsellCampaignConfig = require(`../tenants/${process.env.TENANT}/upsell_config.json`);
} catch(e) {
  logger.log('[upsell] No upsell_config.json for tenant ' + process.env.TENANT + ', campaign upsell disabled');
}

// ── Productos complementarios predefinidos ────────────────────────────────────
// Cada entrada mapea un producto comprado (título) a uno o más complementos.
// VariantId es opcional; si no se especifica, se usa la primera variante.
const COMPLEMENTOS = [
  {
    producto: 'Anua Heartleaf 77% Soothing Toner',
    complemento: 'Anua Heartleaf Cleansing Oil',
    variantId: null
  },
  {
    producto: 'Anua Heartleaf Cleansing Oil',
    complemento: 'Anua Heartleaf 77% Soothing Toner',
    variantId: null
  },
  {
    producto: 'Numbuzin No.3 Super Glowing Essence Toner',
    complemento: 'Numbuzin No.3 Skin Softening Serum',
    variantId: null
  },
  {
    producto: 'Numbuzin No.3 Skin Softening Serum',
    complemento: 'Numbuzin No.3 Super Glowing Essence Toner',
    variantId: null
  },
  {
    producto: 'SKIN1004 Madagascar Centella Light Cleansing Oil',
    complemento: 'SKIN1004 Madagascar Centella Ampoule Foam',
    variantId: null
  },
  {
    producto: 'SKIN1004 Madagascar Centella Ampoule Foam',
    complemento: 'SKIN1004 Madagascar Centella Light Cleansing Oil',
    variantId: null
  },
  {
    producto: 'COSRX Advanced Snail 96 Mucin Power Essence',
    complemento: 'COSRX Advanced Snail 92 All in One Cream',
    variantId: null
  },
  {
    producto: 'COSRX Advanced Snail 92 All in One Cream',
    complemento: 'COSRX Advanced Snail 96 Mucin Power Essence',
    variantId: null
  },
  {
    producto: 'Beauty of Joseon Relief Sun Rice + Probiotics SPF50',
    complemento: 'Beauty of Joseon Ginseng Cleansing Oil',
    variantId: null
  },
  {
    producto: 'Beauty of Joseon Ginseng Cleansing Oil',
    complemento: 'Beauty of Joseon Relief Sun Rice + Probiotics SPF50',
    variantId: null
  },
  {
    producto: 'Round Lab Birch Juice Moisturizing Sunscreen SPF50',
    complemento: 'Round Lab 1025 Dokdo Cleanser',
    variantId: null
  },
  {
    producto: 'Round Lab 1025 Dokdo Cleanser',
    complemento: 'Round Lab Birch Juice Moisturizing Sunscreen SPF50',
    variantId: null
  }
];

// ── Obtener precio de un producto desde el catálogo ──────────────────────────
function getProductPrice(productTitle) {
  if (!shopifyCatalog || !shopifyCatalog.length) return null;

  const normalized = productTitle.toLowerCase().trim();
  const product = shopifyCatalog.find(p => {
    return (p.title || '').toLowerCase().trim() === normalized;
  });

  if (!product || !product.variants || !product.variants.length) return null;

  // Primera variante, precio en pesos chilenos (Shopify lo envía como string)
  const price = parseFloat(product.variants[0].price);
  return isNaN(price) ? null : price;
}

// ── Obtener el precio del producto más caro del pedido ────────────────────────
function getMaxLineItemPrice(order) {
  if (!order || !order.line_items || !order.line_items.length) return null;

  let maxPrice = 0;
  for (const item of order.line_items) {
    const price = parseFloat(item.price || 0);
    if (price > maxPrice) maxPrice = price;
  }

  return maxPrice > 0 ? maxPrice : null;
}

// ── findComplemento ───────────────────────────────────────────────────────────
/**
 * Busca un complemento adecuado para el pedido.
 *
 * Algoritmo:
 * 1. Itera sobre line_items del pedido.
 * 2. Para cada item comprado, busca si existe un par en COMPLEMENTOS.
 * 3. Si existe, valida que el precio del complemento no supere
 *    MAX_UPSELL_PCT del producto más caro del pedido.
 * 4. Si pasa el filtro, retorna el match.
 * 5. Si ningún par pasa, retorna null (sin upsell).
 *
 * @param {object} order - pedido de Shopify con line_items
 * @returns {object|null} { par, variantId, precioComplemento, precioReferencia }
 */
function findComplemento(order) {
  if (!order || !order.line_items || !order.line_items.length) {
    logger.log('[upsell] Pedido sin line_items, no se puede buscar complemento');
    return null;
  }

  const maxPrice = getMaxLineItemPrice(order);
  logger.log('[upsell] Precio referencia (producto más caro): ' + (maxPrice ? '$' + maxPrice : 'N/A'));

  // Recolectar todos los títulos de productos comprados
  const purchasedTitles = order.line_items.map(item => (item.title || '').trim());

  for (const itemTitle of purchasedTitles) {
    const match = COMPLEMENTOS.find(c => {
      return c.producto.toLowerCase().trim() === itemTitle.toLowerCase().trim();
    });

    if (!match) continue;

    // ── Obtener precio del complemento desde el catálogo ──────────────────
    const precioComplemento = getProductPrice(match.complemento);

    if (precioComplemento === null) {
      logger.log('[upsell] Precio no encontrado para complemento: ' + match.complemento + ' — se omite filtro y se permite');
      // Fallback: si no podemos obtener el precio, permitimos el complemento
      return {
        par: match,
        variantId: match.variantId || null,
        precioComplemento: null,
        precioReferencia: maxPrice
      };
    }

    // ── Validar filtro de precio ──────────────────────────────────────────
    if (maxPrice !== null && maxPrice > 0) {
      const ratio = precioComplemento / maxPrice;
      if (ratio > MAX_UPSELL_PCT) {
        logger.log('[upsell] Saltando complemento ' + match.complemento +
                   ' por precio: ratio ' + ratio.toFixed(2) +
                   ' > ' + MAX_UPSELL_PCT +
                   ' ($' + precioComplemento + ' vs $' + maxPrice + ')');
        continue; // probar siguiente producto comprado
      }
      logger.log('[upsell] Complemento ' + match.complemento +
                 ' pasa filtro: ratio ' + ratio.toFixed(2) +
                 ' ($' + precioComplemento + ' vs $' + maxPrice + ')');
    }

    // ── Match válido ─────────────────────────────────────────────────────
    return {
      par: match,
      variantId: match.variantId || null,
      precioComplemento: precioComplemento,
      precioReferencia: maxPrice
    };
  }

  logger.log('[upsell] Ningún complemento pasó el filtro de precio');
  return null;
}

// ── handleNewOrder ────────────────────────────────────────────────────────────
/**
 * Recibe un pedido nuevo pagado, busca complemento, guarda en Redis
 * y agenda recordatorio para 1 hora después.
 */
async function handleNewOrder(order, config) {
  try {
    if (!order || !order.id) {
      logger.log('[upsell] handleNewOrder sin order.id');
      return;
    }

    const customerPhone = order.customer?.phone || order.shipping_address?.phone || order.billing_address?.phone;
    if (!customerPhone) {
      logger.log('[upsell] Pedido #' + order.name + ' sin teléfono, upsell descartado');
      return;
    }

    let complemento = findComplemento(order);
    if (!complemento) {
      const orderTotal = parseFloat(order.total_price);
      if (orderTotal < 20000 && upsellCampaignConfig) {
        const btsMatch = findBTSComplement(orderTotal, upsellCampaignConfig);
        if (btsMatch) {
          complemento = {
            par: { complemento: btsMatch.product },
            variantId: btsMatch.variantId,
            precioComplemento: btsMatch.price,
            btsCampaign: true
          };
          logger.log('[upsell] BTS upsell match pedido #' + order.name + ': ' + btsMatch.product + ' $' + btsMatch.price);
        }
      }
      if (!complemento) {
        logger.log('[upsell] Pedido #' + order.name + ' sin complemento válido');
        return;
      }
    }

    logger.log('[upsell] Match para pedido #' + order.name +
               ': ' + complemento.par.producto + ' → ' + complemento.par.complemento +
               (complemento.precioComplemento ? ' ($' + complemento.precioComplemento + ')' : ''));

    // Guardar intención de upsell en Redis (TTL 2 horas)
    const upsellData = {
      orderId: String(order.id),
      orderName: order.name,
      complemento: complemento.par.complemento,
      productoOriginal: complemento.par.producto,
      variantId: complemento.par.variantId,
      createdAt: new Date().toISOString(),
      phone: customerPhone,
      enviado: false
    };

    const redis = memory.getRedisClient ? memory.getRedisClient() : null;
    if (redis) {
      const key = 'upsell:' + order.id;
      await redis.set(key, JSON.stringify(upsellData));
      await redis.expire(key, 7200); // 2 horas
      logger.log('[upsell] Guardado en Redis: ' + key);
    }

    // Agendar recordatorio (1 hora después)
    setTimeout(async () => {
      await sendUpsellReminder(customerPhone, order, complemento, config);
    }, 60 * 60 * 1000); // 1 hora

    logger.log('[upsell] Recordatorio agendado para pedido #' + order.name + ' en 1 hora');

  } catch (err) {
    logger.log('[upsell] Error en handleNewOrder: ' + err.message);
  }
}

// ── sendUpsellReminder ────────────────────────────────────────────────────────
/**
 * Envía el mensaje de upsell al cliente por WhatsApp.
 */
async function sendUpsellReminder(phone, order, match, config) {
  try {
    if (!phone || !match) {
      logger.log('[upsell] sendUpsellReminder sin phone o match');
      return;
    }

    const redis = memory.getRedisClient ? memory.getRedisClient() : null;
    // Verificar si ya se envió
    if (redis && order) {
      const key = 'upsell:' + order.id;
      const existing = await redis.get(key);
      if (existing) {
        const data = JSON.parse(existing);
        if (data.enviado) {
          logger.log('[upsell] Ya enviado para pedido ' + order.name + ', skip');
          return;
        }
      }
    }

    const complementoNombre = match.par.complemento;
    const precioFormateado = match.precioComplemento
      ? '$' + match.precioComplemento.toLocaleString('es-CL')
      : '';

    let mensaje;
    if (match.btsCampaign) {
      mensaje = '🎫 *¡Participa por entradas para BTS ARIRANG!*\n\n' +
        'Tu pedido va en *$' + parseFloat(order.total_price).toLocaleString('es-CL') + '*. ' +
        'Agregando *' + complementoNombre + '*' +
        (precioFormateado ? ' (' + precioFormateado + ')' : '') +
        ' alcanzas los $20.000 y participas en el sorteo por entradas para ver a BTS en el Estadio Nacional 🏟️\n\n' +
        'El 17 de octubre 2026. Más de 600 clientes ya están participando. ¿Te lo agrego?\n\n' +
        'Responde *sí* y te ayudo.';
    } else {
      mensaje = '🌸 *¡Gracias por tu compra en Yeppo!*\n\n' +
        'Noté que compraste *' + match.par.producto + '*. ' +
        '¿Te interesa agregar *' + complementoNombre + '*' +
        (precioFormateado ? ' (' + precioFormateado + ')' : '') +
        ' a tu rutina?\n\n' +
        'Es el complemento perfecto. Si quieres, te lo puedo agregar con un descuento especial 🥰\n\n' +
        'Responde este mensaje y te ayudo.';
    }

    logger.log('[upsell] Enviando recordatorio a ' + phone + ': ' + complementoNombre);

    if (match.btsCampaign) {
      const orderTotalStr = '$' + parseFloat(order.total_price).toLocaleString('es-CL');
      await meta.sendTemplate(phone, 'upsell_bts_sorteo', 'es_CL', [
        { type: 'body', parameters: [
          { type: 'text', text: orderTotalStr },
          { type: 'text', text: complementoNombre },
          { type: 'text', text: precioFormateado }
        ]}
      ]);
    } else {
      await meta.sendText(phone, mensaje, config);
    }

    // Marcar como enviado en Redis
    if (redis && order) {
      const key = 'upsell:' + order.id;
      const existing = await redis.get(key);
      if (existing) {
        const data = JSON.parse(existing);
        data.enviado = true;
        data.sentAt = new Date().toISOString();
        await redis.set(key, JSON.stringify(data));
        await redis.expire(key, 3600); // extender 1 hora más
      }
    }

    // Notificar en Slack
    if (match.btsCampaign) {
      await slack.sendNotification(
        '🎫 *Upsell BTS enviado*\n' +
        'Cliente: ' + phone + '\n' +
        'Pedido: ' + (order ? order.name : 'N/A') + '\n' +
        'Total pedido: $' + parseFloat(order.total_price).toLocaleString('es-CL') + '\n' +
        'Sugerido: ' + complementoNombre +
        (precioFormateado ? ' (' + precioFormateado + ')' : ''),
        config
      );
    } else {
      await slack.sendNotification(
        '📬 *Upsell enviado*\n' +
        'Cliente: ' + phone + '\n' +
        'Pedido: ' + (order ? order.name : 'N/A') + '\n' +
        'Compró: ' + match.par.producto + '\n' +
        'Sugerido: ' + complementoNombre +
        (precioFormateado ? ' (' + precioFormateado + ')' : ''),
        config
      );
    }

    // Guardar upsell pendiente para que quickReply lo detecte al responder
    const pendingData = {
      orderId: String(order.id),
      orderName: order.name,
      status: 'sent',
      match: {
        producto: match.par.producto || null,
        complemento: complementoNombre,
        variantId: match.par.variantId,
        precio: match.precioComplemento || 0
      },
      btsCampaign: match.btsCampaign || false
    };
    await memory.setUpsellPending(phone, pendingData);
    logger.log('[upsell] Upsell pendiente guardado para ' + phone + ': ' + complementoNombre);

    // Trackear evento
    try {
      const upsellStats = require('./upsell-stats');
      await upsellStats.trackEvent('sent', phone, {
        complemento: complementoNombre,
        orderName: order.name,
        btsCampaign: match.btsCampaign || false
      });
    } catch (e) { /* non-blocking */ }

  } catch (err) {
    logger.log('[upsell] Error en sendUpsellReminder: ' + err.message);
    // Fallback graceful: si falla el envío, no hacer nada más
  }
}

// ── Helpers GraphQL/REST Shopify (para Order Editing) ───────────────────────────
const https = require('https');

function shopifyRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const token = process.env.SHOPIFY_TOKEN;
    const store = process.env.SHOPIFY_DOMAIN || '59c6fd-2.myshopify.com';
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
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('shopify timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

function shopifyGraphQL(query, variables) {
  return new Promise((resolve, reject) => {
    const token = process.env.SHOPIFY_TOKEN;
    const store = process.env.SHOPIFY_DOMAIN || '59c6fd-2.myshopify.com';
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
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('GraphQL timeout')); });
    req.write(data);
    req.end();
  });
}

async function getOrderLocationId(orderId) {
  try {
    const r = await shopifyRequest('GET', `/orders/${orderId}.json?fields=id,fulfillments,location_id`);
    return r?.order?.fulfillments?.[0]?.location_id || r?.order?.location_id || null;
  } catch { return null; }
}

// ── handleUpsellAccepted ──────────────────────────────────────────────────────
/**
 * Cliente aceptó el upsell. Agrega el producto via GraphQL Order Editing API.
 * Mismo método que funcionó el 2026-03-25 (commit 22f11e8).
 */
async function handleUpsellAccepted(phone, order, match, config) {
  try {
    if (!order.id) { logger.log('[upsell] handleUpsellAccepted sin order.id'); return; }

    const variantId = match.par?.variantId;
    if (!variantId) { logger.log('[upsell] handleUpsellAccepted sin variantId'); return; }

    const orderGid  = `gid://shopify/Order/${order.id}`;
    const variantGid = `gid://shopify/ProductVariant/${variantId}`;

    // location_id del pedido original (para mover el fulfillment order)
    const locationId  = await getOrderLocationId(order.id);
    const locationGid = locationId ? `gid://shopify/Location/${locationId}` : null;
    if (locationId) logger.log('[upsell] Usando location: ' + locationId);

    logger.log('[upsell] Editando pedido ' + order.name + ': variantId=' + variantId);

    // 1. orderEditBegin
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

    // 2. orderEditAddVariant
    const addVars = { id: calcOrderId, variantId: variantGid, quantity: 1 };
    const addMutation = locationGid
      ? `mutation orderEditAddVariant($id: ID!, $variantId: ID!, $quantity: Int!, $locationId: ID!) {
          orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity, locationId: $locationId) {
            calculatedOrder { id } userErrors { field message }
          }
        }`
      : `mutation orderEditAddVariant($id: ID!, $variantId: ID!, $quantity: Int!) {
          orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity) {
            calculatedOrder { id } userErrors { field message }
          }
        }`;
    if (locationGid) addVars.locationId = locationGid;
    const addResult = await shopifyGraphQL(addMutation, addVars);
    const errors2 = addResult?.data?.orderEditAddVariant?.userErrors;
    if (errors2?.length) throw new Error(errors2.map(e => e.message).join(', '));

    // 3. orderEditCommit (sin notificar al cliente — lo hace el bot por WhatsApp)
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

    // 4. Mover fulfillment order a la misma ubicación del pedido original
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
          logger.log('[upsell] FO ' + fo.id + ' movido → ' + locationId);
        }
      } catch (e) { logger.log('[upsell] Warning: no se pudo mover FO: ' + e.message); }
    }

    // 5. Enviar invoice al cliente por email (GraphQL)
    const invoiceResult = await shopifyGraphQL(`
      mutation orderInvoiceSend($id: ID!) {
        orderInvoiceSend(id: $id) {
          order { id name email }
          userErrors { field message }
        }
      }
    `, { id: orderGid }).catch(e => { logger.log('[upsell] invoice catch: ' + e.message); return null; });
    const invoiceErrors = invoiceResult?.data?.orderInvoiceSend?.userErrors;
    const invoiceOrder  = invoiceResult?.data?.orderInvoiceSend?.order;
    const invoiceSent   = !invoiceErrors?.length && !!invoiceOrder;
    if (invoiceSent) {
      logger.log('[upsell] ✅ Factura enviada a: ' + invoiceOrder.email);
    } else if (invoiceErrors?.length) {
      logger.log('[upsell] ⚠️ Invoice error: ' + JSON.stringify(invoiceErrors));
    }

    // 6. Confirmar al cliente por WhatsApp
    const complementoNombre = match.par?.complemento || 'el producto';
    const precio = match.precioComplemento || 0;
    const precioStr = precio ? ' ($' + Math.round(precio).toLocaleString('es-CL') + ')' : '';
    const msgCliente = invoiceSent
      ? '✅ *¡Listo!* Agregué *' + complementoNombre + '*' + precioStr + ' a tu pedido #' + order.name + '.\n\nTe llegó un email con el link para pagar la diferencia. Una vez confirmado lo despachamos todo junto 🙏'
      : '✅ *¡Listo!* Agregué *' + complementoNombre + '*' + precioStr + ' a tu pedido #' + order.name + '.\n\nEl equipo te contactará para coordinar el pago adicional 🙏';
    await meta.sendText(phone, msgCliente, config);

    // 7. Marcar como aceptado y notificar Slack/stats
    await memory.updateUpsellStatus(phone, 'accepted');
    await slack.sendNotification(
      '✅ *Upsell ACEPTADO*\nCliente: ' + phone + '\nPedido: ' + order.name +
      '\nProducto: ' + complementoNombre + (precioStr ? ' ' + precioStr : '') +
      (invoiceSent ? '\nFactura enviada ✅' : '\n⚠️ Factura no enviada'),
      config
    ).catch(() => {});
    try {
      const upsellStats = require('./upsell-stats');
      await upsellStats.trackEvent('accepted', phone, { complemento: complementoNombre, orderName: order.name });
    } catch (e) { /* non-blocking */ }

    logger.log('[upsell] ✅ Upsell aceptado: ' + order.name + ' → ' + complementoNombre + (invoiceSent ? ' + factura' : ''));

  } catch (err) {
    logger.log('[upsell] ❌ Error en handleUpsellAccepted: ' + err.message);
    await slack.sendNotification(
      '⚠️ *Error al procesar upsell aceptado*\nCliente: ' + phone +
      '\nPedido: ' + (order?.name || 'N/A') + '\nError: ' + err.message,
      config
    ).catch(() => {});
    await meta.sendText(phone,
      '¡Gracias por tu interés! Tuve un pequeño problema técnico. El equipo lo revisará y te contactará pronto 🙏',
      config
    ).catch(() => {});
  }
}

// ── revertUpsell ──────────────────────────────────────────────────────────────
/**
 * Revertir upsell: cliente rechazó después de haber aceptado.
 * Intenta quitar el line item del pedido en Shopify y reenviar invoice.
 */
async function revertUpsell(phone, order, match, config, reason) {
  try {
    const shopifyToken = config?.shopifyToken || process.env.SHOPIFY_TOKEN;
    const shopifyDomain = config?.shopifyDomain || process.env.SHOPIFY_DOMAIN || '59c6fd-2.myshopify.com';

    if (!shopifyToken || !order.id) {
      logger.log('[upsell] revertUpsell sin token o order.id');
      return;
    }

    logger.log('[upsell] Revirtiendo upsell para pedido ' + order.name + ': ' + (reason || 'sin razón'));

    // 1. Obtener line items actuales del pedido
    const axios = require('axios');
    const shopUrl = `https://${shopifyDomain}/admin/api/2024-01/orders/${order.id}.json`;
    const getRes = await axios.get(shopUrl, {
      headers: {
        'X-Shopify-Access-Token': shopifyToken,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });

    const currentOrder = getRes.data.order;
    const variantId = match.par?.variantId;
    
    // 2. Quitar el line item que coincide con el variantId del upsell
    if (variantId && currentOrder.line_items) {
      const keptItems = currentOrder.line_items
        .filter(li => String(li.variant_id) !== String(variantId))
        .map(li => ({
          variant_id: li.variant_id,
          quantity: li.quantity
        }));

      if (keptItems.length < currentOrder.line_items.length) {
        await axios.put(shopUrl, {
          order: {
            id: order.id,
            line_items: keptItems
          }
        }, {
          headers: {
            'X-Shopify-Access-Token': shopifyToken,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        });

        // Reenviar invoice actualizado
        const invoiceUrl = `https://${shopifyDomain}/admin/api/2024-01/orders/${order.id}/send_invoice.json`;
        await axios.post(invoiceUrl, {}, {
          headers: {
            'X-Shopify-Access-Token': shopifyToken,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        }).catch(() => {});

        logger.log('[upsell] Producto removido del pedido ' + order.name);
      }
    }

    // 3. Limpiar estado
    await memory.clearUpsellPending(phone);

    // 4. Mensaje al cliente
    await meta.sendText(phone,
      'Entendido, dejamos tu pedido como estaba originalmente. Cualquier cosa me avisas 😊',
      config
    ).catch(() => {});

    // 5. Notificar Slack
    await slack.sendNotification(
      '🔄 *Upsell REVERTIDO*\n' +
      'Cliente: ' + phone + '\n' +
      'Pedido: ' + order.name + '\n' +
      'Razón: ' + (reason || 'rechazo del cliente'),
      config
    );

    // 6. Trackear evento
    try {
      const upsellStats = require('./upsell-stats');
      await upsellStats.trackEvent('reverted', phone, {
        complemento: match.par?.complemento,
        orderName: order.name,
        reason: reason || 'rejected'
      });
    } catch (e) { /* non-blocking */ }

    logger.log('[upsell] Upsell revertido: ' + order.name);

  } catch (err) {
    logger.log('[upsell] Error en revertUpsell: ' + err.message);
    
    // Limpiar estado aunque falle
    await memory.clearUpsellPending(phone).catch(() => {});
    
    await slack.sendNotification(
      '⚠️ *Error al revertir upsell*\n' +
      'Cliente: ' + phone + '\n' +
      'Pedido: ' + (order?.name || 'N/A') + '\n' +
      'Error: ' + err.message + '\n' +
      'REVISAR MANUALMENTE EN SHOPIFY',
      config
    ).catch(() => {});
  }
}

// ── getStats ──────────────────────────────────────────────────────────────────
/**
 * Retorna estadísticas de upsells (para endpoint /admin/upsell/stats)
 */
async function getStats() {
  try {
    const redis = memory.getRedisClient ? memory.getRedisClient() : null;
    if (!redis) return { upsells: [], total: 0, enviados: 0 };

    const keys = await redis.keys('upsell:*');
    const upsells = [];

    for (const key of keys) {
      const raw = await redis.get(key);
      if (raw) {
        try {
          upsells.push(JSON.parse(raw));
        } catch (e) { /* skip */ }
      }
    }

    const enviados = upsells.filter(u => u.enviado).length;

    return {
      upsells,
      total: upsells.length,
      enviados,
      pendientes: upsells.length - enviados
    };
  } catch (err) {
    logger.log('[upsell] Error en getStats: ' + err.message);
    return { upsells: [], total: 0, enviados: 0, error: err.message };
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────
function findBTSComplement(orderTotal, config) {
  if (!config || !config.btsCampaign || !config.cheapProducts) return null;
  const campaign = config.btsCampaign;
  if (campaign.active === false) return null;

  if (campaign.startDate && campaign.endDate) {
    const now = new Date();
    const start = new Date(campaign.startDate);
    const end = new Date(campaign.endDate);
    if (now < start || now > end) return null;
  }

  const cheapProducts = config.cheapProducts
    .filter(p => {
      const price = parseFloat(p.price);
      return !isNaN(price) && price >= 1990 && price <= 9990;
    })
    .sort((a, b) => parseFloat(a.price) - parseFloat(b.price));

  for (const prod of cheapProducts) {
    const price = parseFloat(prod.price);
    if (orderTotal + price >= 20000) {
      return {
        product: prod.name,
        variantId: prod.variantId,
        price: price
      };
    }
  }
  return null;
}

module.exports = {
  findComplemento,
  findBTSComplement,
  handleNewOrder,
  sendUpsellReminder,
  handleUpsellAccepted,
  revertUpsell,
  getStats,
  MAX_UPSELL_PCT,
  COMPLEMENTOS,
  get campaignConfig() { return upsellCampaignConfig; }
};