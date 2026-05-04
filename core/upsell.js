/**

 * core/upsell.js â€” LÃ³gica de upselling post-compra

 *

 * Procesa webhooks de Shopify (order_paid) y determina si corresponde

 * enviar un mensaje de upsell al cliente 1 hora despuÃ©s del pedido.

 *

 * El complemento sugerido no puede superar MAX_UPSELL_PCT (50%) del

 * producto mÃ¡s caro del pedido original, para evitar ofrecer productos

 * desproporcionadamente mÃ¡s costosos.

 */



const memory = require('./memory');

const meta   = require('./meta');

const slack  = require('./slack');

const logger = require('./logger');

const shopifyCatalog = require('./shopify').catalog || []; // catÃ¡logo compartido



// â”€â”€ Constante de filtro â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const MAX_UPSELL_PCT = 0.5; // 50% â€” el complemento no puede superar este % del precio referencia
const REMINDER_AFTER_MS = process.env.UPSELL_TEST_MODE === 'true' ? 30000 : 2 * 60 * 60 * 1000; // 2h (30s en test)
const REVERT_AFTER_MS   = process.env.UPSELL_TEST_MODE === 'true' ? 60000 : 5 * 60 * 60 * 1000; // 5h (60s en test)

function isQuietHours() {
  const hour = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Santiago', hour: 'numeric', hour12: false }));
  return hour >= 23 || hour < 9;
}




// â”€â”€ ConfiguraciÃ³n de campaÃ±as especiales de upsell â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

let upsellCampaignConfig = null;

try {

  upsellCampaignConfig = require(`../tenants/${process.env.TENANT}/upsell_config.json`);

} catch(e) {

  logger.log('[upsell] No upsell_config.json for tenant ' + process.env.TENANT + ', campaign upsell disabled');

}



// â”€â”€ Productos complementarios predefinidos â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Cada entrada mapea un producto comprado (tÃ­tulo) a uno o mÃ¡s complementos.

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



// â”€â”€ Obtener precio de un producto desde el catÃ¡logo â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function getProductPrice(productTitle) {

  if (!shopifyCatalog || !shopifyCatalog.length) return null;



  const normalized = productTitle.toLowerCase().trim();

  const product = shopifyCatalog.find(p => {

    return (p.title || '').toLowerCase().trim() === normalized;

  });



  if (!product || !product.variants || !product.variants.length) return null;



  // Primera variante, precio en pesos chilenos (Shopify lo envÃ­a como string)

  const price = parseFloat(product.variants[0].price);

  return isNaN(price) ? null : price;

}



// â”€â”€ Obtener el precio del producto mÃ¡s caro del pedido â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function getMaxLineItemPrice(order) {

  if (!order || !order.line_items || !order.line_items.length) return null;



  let maxPrice = 0;

  for (const item of order.line_items) {

    const price = parseFloat(item.price || 0);

    if (price > maxPrice) maxPrice = price;

  }



  return maxPrice > 0 ? maxPrice : null;

}



// â”€â”€ findComplemento â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**

 * Busca un complemento adecuado para el pedido.

 *

 * Algoritmo:

 * 1. Itera sobre line_items del pedido.

 * 2. Para cada item comprado, busca si existe un par en COMPLEMENTOS.

 * 3. Si existe, valida que el precio del complemento no supere

 *    MAX_UPSELL_PCT del producto mÃ¡s caro del pedido.

 * 4. Si pasa el filtro, retorna el match.

 * 5. Si ningÃºn par pasa, retorna null (sin upsell).

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

  logger.log('[upsell] Precio referencia (producto mÃ¡s caro): ' + (maxPrice ? '$' + maxPrice : 'N/A'));



  // Recolectar todos los tÃ­tulos de productos comprados

  const purchasedTitles = order.line_items.map(item => (item.title || '').trim());



  for (const itemTitle of purchasedTitles) {

    const match = COMPLEMENTOS.find(c => {

      return c.producto.toLowerCase().trim() === itemTitle.toLowerCase().trim();

    });



    if (!match) continue;



    // â”€â”€ Obtener precio del complemento desde el catÃ¡logo â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    const precioComplemento = getProductPrice(match.complemento);



    if (precioComplemento === null) {

      logger.log('[upsell] Precio no encontrado para complemento: ' + match.complemento + ' â€” se omite filtro y se permite');

      // Fallback: si no podemos obtener el precio, permitimos el complemento

      return {

        par: match,

        variantId: match.variantId || null,

        precioComplemento: null,

        precioReferencia: maxPrice

      };

    }



    // â”€â”€ Validar filtro de precio â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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



    // â”€â”€ Match vÃ¡lido â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    return {

      par: match,

      variantId: match.variantId || null,

      precioComplemento: precioComplemento,

      precioReferencia: maxPrice

    };

  }



  logger.log('[upsell] NingÃºn complemento pasÃ³ el filtro de precio');

  return null;

}



// â”€â”€ handleNewOrder â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**

 * Recibe un pedido nuevo pagado, busca complemento, guarda en Redis

 * y agenda recordatorio para 1 hora despuÃ©s.

 */

async function handleNewOrder(order, config) {

  try {

    if (!order || !order.id) {

      logger.log('[upsell] handleNewOrder sin order.id');

      return;

    }



    const customerPhone = order.customer?.phone || order.shipping_address?.phone || order.billing_address?.phone;

    if (!customerPhone) {

      logger.log('[upsell] Pedido #' + order.name + ' sin telÃ©fono, upsell descartado');

      return;

    }



    let complemento = findComplemento(order);

    if (!complemento) {

      const orderTotal = parseFloat(order.total_price);

      if (orderTotal < 20000 && upsellCampaignConfig) {

        const btsMatch = await findBTSComplement(orderTotal, upsellCampaignConfig);

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

        logger.log('[upsell] Pedido #' + order.name + ' sin complemento vÃ¡lido');

        return;

      }

    }



    logger.log('[upsell] Match para pedido #' + order.name +

               ': ' + complemento.par.producto + ' â†’ ' + complemento.par.complemento +

               (complemento.precioComplemento ? ' ($' + complemento.precioComplemento + ')' : ''));



    // Guardar intenciÃ³n de upsell en Redis (TTL 2 horas)

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



    // Agendar recordatorio (1 hora despuÃ©s)

    setTimeout(async () => {

      await sendUpsellReminder(customerPhone, order, complemento, config);

    }, 60 * 60 * 1000); // 1 hora



    logger.log('[upsell] Recordatorio agendado para pedido #' + order.name + ' en 1 hora');



  } catch (err) {

    logger.log('[upsell] Error en handleNewOrder: ' + err.message);

  }

}



// â”€â”€ sendUpsellReminder â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**

 * EnvÃ­a el mensaje de upsell al cliente por WhatsApp.

 */

async function sendUpsellReminder(phone, order, match, config) {

  try {

    if (!phone || !match) {

      logger.log('[upsell] sendUpsellReminder sin phone o match');

      return;

    }



    const redis = memory.getRedisClient ? memory.getRedisClient() : null;

    // Verificar si ya se enviÃ³

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

      mensaje = 'ðŸŽ« *Â¡Participa por entradas para BTS ARIRANG!*\n\n' +

        'Tu pedido va en *$' + parseFloat(order.total_price).toLocaleString('es-CL') + '*. ' +

        'Agregando *' + complementoNombre + '*' +

        (precioFormateado ? ' (' + precioFormateado + ')' : '') +

        ' alcanzas los $20.000 y participas en el sorteo por entradas para ver a BTS en el Estadio Nacional ðŸŸï¸\n\n' +

        'El 17 de octubre 2026. Mas de 600 clientes ya estan participando. Te lo agrego?\n\n' +

        'Responde *si* y te ayudo.';

    } else {

      mensaje = '*Gracias por tu compra en Yeppo!*\n\n' +

        'Note que compraste *' + match.par.producto + '*. ' +

        'Te interesa agregar *' + complementoNombre + '*' +

        (precioFormateado ? ' (' + precioFormateado + ')' : '') +

        ' a tu rutina?\n\n' +

        'Es el complemento perfecto. Si quieres, te lo puedo agregar\n\n' +

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

      await meta.sendMessage(phone, mensaje, config);

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

        await redis.expire(key, 3600); // extender 1 hora mÃ¡s

      }

    }



    // Notificar en Slack

    if (match.btsCampaign) {

      await slack.sendNotification(

        'ðŸŽ« *Upsell BTS enviado*\n' +

        'Cliente: ' + phone + '\n' +

        'Pedido: ' + (order ? order.name : 'N/A') + '\n' +

        'Total pedido: $' + parseFloat(order.total_price).toLocaleString('es-CL') + '\n' +

        'Sugerido: ' + complementoNombre +

        (precioFormateado ? ' (' + precioFormateado + ')' : ''),

        config

      );

    } else {

      await slack.sendNotification(

        'ðŸ“¬ *Upsell enviado*\n' +

        'Cliente: ' + phone + '\n' +

        'Pedido: ' + (order ? order.name : 'N/A') + '\n' +

        'ComprÃ³: ' + match.par.producto + '\n' +

        'Sugerido: ' + complementoNombre +

        (precioFormateado ? ' (' + precioFormateado + ')' : ''),

        config

      );

    }



    // Guardar upsell pendiente para que quickReply lo detecte al responder

    const pendingData = {

      orderId: String(order.id),

      orderName: order.name,

      orderStatusUrl: order.order_status_url || null,

      customerId: order.customer?.id || null,

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

    // Fallback graceful: si falla el envÃ­o, no hacer nada mÃ¡s

  }

}



// â”€â”€ Helpers GraphQL/REST Shopify (para Order Editing) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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



// Upsells son siempre para pedidos web → siempre despachan desde Bodega Central

const BODEGA_CENTRAL_LOCATION_ID = '70187188373';

async function getOrderLocationId(_orderId) {

  return BODEGA_CENTRAL_LOCATION_ID;

}



// â”€â”€ handleUpsellAccepted â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**

 * Cliente aceptÃ³ el upsell. Agrega el producto via GraphQL Order Editing API.

 * Mismo mÃ©todo que funcionÃ³ el 2026-03-25 (commit 22f11e8).

 */

// \u2500\u2500 scheduleUpsellFollowup \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Despues de que el cliente acepta, programa:
//   - Reminder a 2h si sigue sin pagar
//   - Revert automatico a 5h si sigue sin pagar
// Envia mensaje directo de seguimiento sin sobreescribir el pending
async function sendFollowupDirectMessage(phone, config) {
  try {
    const pending = await memory.getUpsellPending(phone);
    if (!pending || pending.status !== 'accepted') return;
    const complemento = pending.match?.complemento || 'el producto';
    const payLink = pending.orderStatusUrl || '';
    const msg = '\u23f0 *Recordatorio:* \u00bfYa pudiste pagar el saldo de *' + complemento + '*?' + (payLink ? '\n\n' + payLink : '') + '\n\nSi no puedes, no te preocupes \ud83d\ude4f';
    await meta.sendMessage(phone, msg, config);
  } catch (e) { logger.log('[upsell-followup] Error enviando reminder: ' + e.message); }
}

function scheduleUpsellFollowup(phone, order, match, config) {
  // Reminder a 2h
  setTimeout(async () => {
    try {
      const pending = await memory.getUpsellPending(phone);
      if (!pending || pending.status !== 'accepted') return; // ya pago o fue cancelado
      if (isQuietHours()) {
        // Postponer al siguiente 09:00 Chile
        const now = new Date();
        const next9 = new Date(now.toLocaleString('en-US', { timeZone: 'America/Santiago' }));
        next9.setHours(9, 0, 0, 0);
        if (next9 <= now) next9.setDate(next9.getDate() + 1);
        const delay = next9 - now;
        logger.log('[upsell-followup] Quiet hours \u2014 postponiendo reminder ' + Math.round(delay/60000) + 'min');
        setTimeout(() => sendFollowupDirectMessage(phone, config).catch(e => logger.log('[upsell-followup] reminder error: ' + e.message)), delay);
      } else {
        await sendFollowupDirectMessage(phone, config);
        logger.log('[upsell-followup] Reminder enviado a ' + phone);
      }
    } catch (e) { logger.log('[upsell-followup] Error en reminder timeout: ' + e.message); }
  }, REMINDER_AFTER_MS);

  // Revert automatico a 5h
  setTimeout(async () => {
    try {
      const pending = await memory.getUpsellPending(phone);
      if (!pending || pending.status !== 'accepted') return; // ya pago o fue cancelado
      logger.log('[upsell-followup] Revirtiendo upsell por falta de pago: ' + (order?.name || pending.orderName));
      await revertUpsell(phone, order, match, config, 'no_payment_5h');
    } catch (e) { logger.log('[upsell-followup] Error en revert timeout: ' + e.message); }
  }, REVERT_AFTER_MS);

  logger.log('[upsell-followup] Followup programado para ' + phone + ' \u2014 reminder en 2h, revert en 5h');
}

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



    // 3. orderEditCommit (sin notificar al cliente â€” lo hace el bot por WhatsApp)

    const commitResult = await shopifyGraphQL(`

      mutation orderEditCommit($id: ID!) {

        orderEditCommit(id: $id, notifyCustomer: false, staffNote: "Upsell WhatsApp â€” complemento agregado") {

          order { id name }

          userErrors { field message }

        }

      }

    `, { id: calcOrderId });

    const errors3 = commitResult?.data?.orderEditCommit?.userErrors;

    if (errors3?.length) throw new Error(errors3.map(e => e.message).join(', '));



    // 4. Mover fulfillment order a la misma ubicaciÃ³n del pedido original

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

          logger.log('[upsell] FO ' + fo.id + ' movido â†’ ' + locationId);

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

      logger.log('[upsell] âœ… Factura enviada a: ' + invoiceOrder.email);

    } else if (invoiceErrors?.length) {

      logger.log('[upsell] âš ï¸ Invoice error: ' + JSON.stringify(invoiceErrors));

    }



    // 6. Confirmar al cliente por WhatsApp (con link de pago)

    const complementoNombre = match.par?.complemento || 'el producto';
    const precio = match.precioComplemento || 0;
    const precioStr = precio ? ' ($' + Math.round(precio).toLocaleString('es-CL') + ')' : '';

    // Link de pago: viene del pendingData (order_status_url guardado al enviar reminder)
    // Si no está en el mock, consultar Shopify directamente
    let paymentLink = order.order_status_url || null;
    if (!paymentLink) {
      try {
        const freshOrder = await shopifyRequest('GET', '/orders/' + order.id + '.json?fields=id,order_status_url');
        paymentLink = freshOrder?.order?.order_status_url || null;
      } catch (e) { logger.log('[upsell] Warning: no se pudo obtener order_status_url: ' + e.message); }
    }

    let msgCliente;
    if (paymentLink) {
      msgCliente = '\u2705 *\u00a1Listo!* Agregu\u00e9 *' + complementoNombre + '*' + precioStr + ' a tu pedido #' + order.name + '.\n\nPaga el saldo aqu\u00ed:\n' + paymentLink + '\n\nUna vez confirmado lo despachamos todo junto \ud83d\ude4f';
    } else if (invoiceSent) {
      msgCliente = '\u2705 *\u00a1Listo!* Agregu\u00e9 *' + complementoNombre + '*' + precioStr + ' a tu pedido #' + order.name + '.\n\nTe lleg\u00f3 un email con el link para pagar la diferencia. Una vez confirmado lo despachamos todo junto \ud83d\ude4f';
    } else {
      msgCliente = '\u2705 *\u00a1Listo!* Agregu\u00e9 *' + complementoNombre + '*' + precioStr + ' a tu pedido #' + order.name + '.\n\nEl equipo te contactar\u00e1 para coordinar el pago adicional \ud83d\ude4f';
    }
    await meta.sendMessage(phone, msgCliente, config);



    // 7. Marcar como aceptado y notificar Slack/stats

    await memory.updateUpsellStatus(phone, 'accepted');

    await slack.sendNotification(

      'âœ… *Upsell ACEPTADO*\nCliente: ' + phone + '\nPedido: ' + order.name +

      '\nProducto: ' + complementoNombre + (precioStr ? ' ' + precioStr : '') +

      (invoiceSent ? '\nFactura enviada âœ…' : '\nâš ï¸ Factura no enviada'),

      config

    ).catch(() => {});

    try {

      const upsellStats = require('./upsell-stats');

      await upsellStats.trackEvent('accepted', phone, { complemento: complementoNombre, orderName: order.name });

    } catch (e) { /* non-blocking */ }



    // Programar reminder (2h) y revert automatico (5h) si no paga
    scheduleUpsellFollowup(phone, order, match, config);

    logger.log('[upsell] âœ… Upsell aceptado: ' + order.name + ' â†’ ' + complementoNombre + (invoiceSent ? ' + factura' : ''));



  } catch (err) {

    logger.log('[upsell] âŒ Error en handleUpsellAccepted: ' + err.message);

    await slack.sendNotification(

      'âš ï¸ *Error al procesar upsell aceptado*\nCliente: ' + phone +

      '\nPedido: ' + (order?.name || 'N/A') + '\nError: ' + err.message,

      config

    ).catch(() => {});

    await meta.sendMessage(phone,

      '\u00a1Gracias por tu interes! Tuve un problema tecnico. El equipo lo revisara y te contactara pronto \ud83d\ude4f',

      config

    ).catch(() => {});

  }

}



// â”€â”€ revertUpsell â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**

 * Revertir upsell: cliente rechazÃ³ despuÃ©s de haber aceptado.

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



    const variantId = match.par?.variantId;
    if (!variantId) { logger.log('[upsell] revertUpsell sin variantId'); return; }

    logger.log('[upsell] Revirtiendo upsell para pedido ' + order.name + ': ' + (reason || 'sin razón'));

    // 1. Iniciar edición con GraphQL (orderEditBegin + orderEditSetQuantity + orderEditCommit)
    const orderGid = 'gid://shopify/Order/' + order.id;
    const variantGid = 'gid://shopify/ProductVariant/' + variantId;

    const beginResult = await shopifyGraphQL(`
      mutation orderEditBeginR($id: ID!) {
        orderEditBegin(id: $id) {
          calculatedOrder {
            id
            lineItems(first: 50) {
              edges {
                node {
                  id
                  variant { id }
                }
              }
            }
          }
          userErrors { field message }
        }
      }
    `, { id: orderGid });
    const err1 = beginResult?.data?.orderEditBegin?.userErrors;
    if (err1?.length) throw new Error(err1.map(e => e.message).join(', '));

    const calcOrderId = beginResult?.data?.orderEditBegin?.calculatedOrder?.id;
    if (!calcOrderId) throw new Error('No se obtuvo calculatedOrder ID');

    const lineItemEdges = beginResult?.data?.orderEditBegin?.calculatedOrder?.lineItems?.edges || [];
    const targetEdge = lineItemEdges.find(edge => edge.node?.variant?.id === variantGid);
    if (!targetEdge) {
      logger.log('[upsell] No se encontró el line item del complemento');
      throw new Error('Line item del upsell no encontrado');
    }
    const lineItemGid = targetEdge.node.id;
    logger.log('[upsell] Line item a remover: ' + lineItemGid);

    // 2. orderEditSetQuantity (quantity=0 para remover line item)
    const removeResult = await shopifyGraphQL(`
      mutation orderEditSetQty($id: ID!, $lineItemId: ID!, $quantity: Int!) {
        orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: $quantity) {
          calculatedOrder { id }
          userErrors { field message }
        }
      }
    `, { id: calcOrderId, lineItemId: lineItemGid, quantity: 0 });
    if (!removeResult?.data?.orderEditSetQuantity) {
      logger.log('[upsell] orderEditSetQuantity returned: ' + JSON.stringify(removeResult?.data || removeResult));
      throw new Error('orderEditSetQuantity returned null');
    }
    const err2 = removeResult?.data?.orderEditSetQuantity?.userErrors;
    if (err2?.length) throw new Error(err2.map(e => e.message).join(', '));

    // 3. orderEditCommit
    const commitResult = await shopifyGraphQL(`
      mutation orderEditCommitR($id: ID!) {
        orderEditCommit(id: $id, notifyCustomer: false, staffNote: "Upsell revertido — " + (reason || '')) {
          order { id name }
          userErrors { field message }
        }
      }
    `, { id: calcOrderId });
    if (!commitResult?.data?.orderEditCommit) {
      logger.log('[upsell] orderEditCommit returned: ' + JSON.stringify(commitResult?.data || commitResult));
      throw new Error('orderEditCommit returned null');
    }
    const err3 = commitResult?.data?.orderEditCommit?.userErrors;
    if (err3?.length) throw new Error(err3.map(e => e.message).join(', '));

    // 4. Enviar invoice actualizada
    await shopifyGraphQL(`
      mutation orderInvoiceSendR($id: ID!) {
        orderInvoiceSend(id: $id) {
          order { id }
          userErrors { field message }
        }
      }
    `, { id: orderGid }).catch(() => {});

    logger.log('[upsell] Complemento removido del pedido ' + order.name);

    await memory.clearUpsellPending(phone);



    // 4. Mensaje al cliente

    await meta.sendMessage(phone,

      'Entendido, dejamos tu pedido como estaba originalmente. Cualquier cosa me avisas ðŸ˜Š',

      config

    ).catch(() => {});



    // 5. Notificar Slack

    await slack.sendNotification(

      'ðŸ”„ *Upsell REVERTIDO*\n' +

      'Cliente: ' + phone + '\n' +

      'Pedido: ' + order.name + '\n' +

      'RazÃ³n: ' + (reason || 'rechazo del cliente'),

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

      'âš ï¸ *Error al revertir upsell*\n' +

      'Cliente: ' + phone + '\n' +

      'Pedido: ' + (order?.name || 'N/A') + '\n' +

      'Error: ' + err.message + '\n' +

      'REVISAR MANUALMENTE EN SHOPIFY',

      config

    ).catch(() => {});

  }

}



// â”€â”€ getStats â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**

 * Retorna estadÃ­sticas de upsells (para endpoint /admin/upsell/stats)

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



// â”€â”€ Exports â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function findBTSComplement(orderTotal, config) {

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

    // Verificar stock antes de sugerir
    try {
      const invRes = await shopifyRequest('GET', '/variants/' + prod.variantId + '.json?fields=id,inventory_quantity');
      const qty = invRes?.variant?.inventory_quantity;
      if (qty !== undefined && qty <= 0) {
        logger.log('[upsell] Producto sin stock, omitiendo: ' + prod.name + ' (qty=' + qty + ')');
        continue;
      }
    } catch (e) { /* si falla verificacion, continuar igual */ }

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

