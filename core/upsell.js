/**
 * core/upsell.js — Upsell post-compra vía WhatsApp
 *
 * Flujo:
 * 1. Shopify envía webhook order/paid → POST /shopify/order
 * 2. Se busca el teléfono del cliente
 * 3. Se verifica si hay un complemento recomendado para los productos comprados
 * 4. Se envía mensaje WhatsApp personalizado ~15 min después
 */

const meta      = require('./meta');
const logger    = require('./logger');
const complementos = require('../tenants/yeppo/complementos.json');

// Tiempo de espera antes de enviar upsell (15 min)
const UPSELL_DELAY_MS = 15 * 60 * 1000;

// ── Normalizar nombre de producto para matching parcial ─────────────────────
function normalize(str) {
  return str.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quitar tildes
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
}

function findComplemento(lineItems) {
  for (const item of lineItems) {
    const itemName = normalize(item.title || item.name || '');
    for (const par of complementos.pares) {
      if (itemName.includes(normalize(par.producto))) {
        // Verificar que el complemento no esté ya en el carrito
        const yaComprado = lineItems.some(i =>
          normalize(i.title || i.name || '').includes(normalize(par.complemento))
        );
        if (!yaComprado) return { item, par };
      }
    }
  }
  return null;
}

// ── Extraer teléfono del pedido ─────────────────────────────────────────────
function extractPhone(order) {
  // Intentar desde shipping, billing, customer
  const sources = [
    order.shipping_address?.phone,
    order.billing_address?.phone,
    order.customer?.phone,
    order.phone
  ];

  for (const raw of sources) {
    if (!raw) continue;
    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 8) {
      // Normalizar a formato sin + (ej: 56977282566)
      if (digits.startsWith('56') && digits.length === 11) return digits;
      if (digits.startsWith('9') && digits.length === 9) return `56${digits}`;
      if (digits.length === 8) return `569${digits}`;
      return digits;
    }
  }
  return null;
}

// ── Generar mensaje de upsell ────────────────────────────────────────────────
function buildUpsellMessage(order, match) {
  const nombre    = order.customer?.first_name || order.shipping_address?.first_name || '';
  const producto  = match.item.title || match.item.name;
  const complemento = match.par.complemento;
  const razon     = match.par.razon;

  // Versión natural del nombre del producto (sin mayúsculas raras)
  const productoLimpio   = producto.split(' ').map(w =>
    w.length > 3 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()
  ).join(' ');
  const complementoLimpio = complemento.split(' ').map(w =>
    w.length > 3 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()
  ).join(' ');

  const saludo = nombre ? `hola ${nombre}!` : 'hola!';

  return `${saludo} tu pedido ya está confirmado 🎉

llevaste el ${productoLimpio} — muchas clientas lo combinan con el ${complementoLimpio} porque ${razon} 🌟

si quieres te lo agregamos antes del despacho, te lo enviamos todo junto sin costo adicional de envío. avisame y lo coordino!`;
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

    const match = findComplemento(lineItems);
    if (!match) {
      logger.log(`[upsell] Pedido #${order.name} — sin complemento relevante`);
      return;
    }

    logger.log(`[upsell] Pedido #${order.name} — enviando upsell a ${phone} en ${UPSELL_DELAY_MS/60000} min`);

    // Enviar después del delay
    setTimeout(async () => {
      const msg = buildUpsellMessage(order, match);
      await meta.sendMessage(phone, msg, config);
      logger.log(`[upsell] ✅ Mensaje enviado a ${phone}: ${match.par.complemento}`);
    }, UPSELL_DELAY_MS);

  } catch (err) {
    logger.log(`[upsell] Error: ${err.message}`);
  }
}

module.exports = { handleNewOrder };
