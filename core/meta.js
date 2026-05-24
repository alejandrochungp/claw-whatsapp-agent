/**
 * core/meta.js — Envío de mensajes vía Meta Cloud API
 */

const axios = require('axios');

async function sendMessage(to, text, config) {
  const token         = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    console.error('❌ WHATSAPP_ACCESS_TOKEN o PHONE_NUMBER_ID no configurados');
    return null;
  }

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { body: text }
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );
    console.log(`✅ Mensaje enviado a ${to}`);
    return response.data;
  } catch (err) {
    console.error(`❌ Error enviando WhatsApp a ${to}:`, err.response?.data || err.message);
    return null;
  }
}

/**
 * Obtiene la URL de descarga de un media de WhatsApp (imagen, video, doc).
 * Devuelve { url, mimeType } o null.
 */
async function getMediaUrl(mediaId, config) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token || !mediaId) return null;
  try {
    const r = await axios.get(
      `https://graph.facebook.com/v18.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
    );
    return { url: r.data.url, mimeType: r.data.mime_type };
  } catch (e) {
    console.error('[meta] getMediaUrl error:', e.response?.data || e.message);
    return null;
  }
}

/**
 * Descarga un media de WhatsApp y devuelve el buffer en base64.
 */
async function downloadMedia(mediaUrl) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token || !mediaUrl) return null;
  try {
    const r = await axios.get(mediaUrl, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer',
      timeout: 20000
    });
    return Buffer.from(r.data).toString('base64');
  } catch (e) {
    console.error('[meta] downloadMedia error:', e.message);
    return null;
  }
}

/**
 * Envía un template de WhatsApp.
 * @param {string} to - número destino
 * @param {string} templateName - nombre del template
 * @param {string} languageCode - ej: 'es_CL'
 * @param {Array}  components   - parámetros del template
 */
async function sendTemplate(to, templateName, languageCode = 'es_CL', components = []) {
  const token         = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    console.error('❌ WHATSAPP_ACCESS_TOKEN o PHONE_NUMBER_ID no configurados');
    return null;
  }
  try {
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: { name: templateName, language: { code: languageCode }, components }
    };
    const response = await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      body,
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    console.log(`✅ Template [${templateName}] enviado a ${to}`);
    return response.data;
  } catch (err) {
    console.error(`❌ Error enviando template a ${to}:`, err.response?.data || err.message);
    return null;
  }
}

/**
 * Envía una imagen por WhatsApp.
 * @param {string} to - número destino
 * @param {object} options - { link, caption } o { filePath, caption }
 * @param {object} config - configuración del tenant
 */
async function sendImage(to, options = {}, config = {}) {
  const token         = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    console.error('[meta] sendImage: token/phoneNumberId no configurados');
    return null;
  }

  try {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'image'
    };

    if (options.link) {
      // Send by URL (image must be publicly accessible)
      payload.image = { link: options.link };
      if (options.caption) payload.image.caption = options.caption;
    } else if (options.filePath) {
      // Upload local file to Meta media endpoint first
      const fs = require('fs');
      const FormData = require('form-data');
      const imageBuffer = fs.readFileSync(options.filePath);
      
      const form = new FormData();
      form.append('file', imageBuffer, {
        filename: 'pack_inicia.jpg',
        contentType: 'image/jpeg'
      });
      form.append('messaging_product', 'whatsapp');
      
      const uploadRes = await axios.post(
        `https://graph.facebook.com/v18.0/${phoneNumberId}/media`,
        form,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            ...form.getHeaders()
          },
          timeout: 20000
        }
      );
      
      if (!uploadRes.data || !uploadRes.data.id) {
        console.error('[meta] sendImage: upload failed', uploadRes.data);
        return null;
      }
      
      payload.image = { id: uploadRes.data.id };
      if (options.caption) payload.image.caption = options.caption;
    } else {
      console.error('[meta] sendImage: must provide link or filePath');
      return null;
    }

    const response = await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );
    console.log(`[meta] Imagen enviada a ${to}`);
    return response.data;
  } catch (err) {
    console.error(`[meta] sendImage error a ${to}:`, err.response?.data || err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// Instagram Messaging
// ═══════════════════════════════════════════════════════════════

/**
 * Envía mensaje de texto a Instagram.
 * @param {string} igSenderId - Instagram Scoped ID (IGSID) del destinatario
 * @param {string} text - texto a enviar
 */
async function sendInstagramMessage(igSenderId, text) {
  const token = process.env.PAGE_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
  const igPageId = process.env.INSTAGRAM_PAGE_ID || process.env.INSTAGRAM_ACCOUNT_ID;
  if (!token || !igPageId) {
    console.error('[meta] sendInstagramMessage: INSTAGRAM_PAGE_ID/INSTAGRAM_ACCOUNT_ID o WHATSAPP_ACCESS_TOKEN no configurados');
    return null;
  }
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v18.0/${igPageId}/messages`,
      {
        recipient: { id: igSenderId },
        message: { text }
      },
      {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 15000
      }
    );
    console.log(`[meta] Instagram message sent to ${igSenderId}`);
    return response.data;
  } catch (err) {
    console.error(`[meta] sendInstagramMessage error (${igSenderId}):`, err.response?.data || err.message);
    return null;
  }
}

/**
 * Envía imagen a Instagram.
 * @param {string} igSenderId - IGSID del destinatario
 * @param {string} imageUrl - URL pública de la imagen
 */
async function sendInstagramImage(igSenderId, imageUrl) {
  const token = process.env.PAGE_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
  const igPageId = process.env.INSTAGRAM_PAGE_ID || process.env.INSTAGRAM_ACCOUNT_ID;
  if (!token || !igPageId) return null;
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v18.0/${igPageId}/messages`,
      {
        recipient: { id: igSenderId },
        message: {
          attachment: {
            type: 'image',
            payload: { url: imageUrl }
          }
        }
      },
      {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 15000
      }
    );
    console.log(`[meta] Instagram image sent to ${igSenderId}`);
    return response.data;
  } catch (err) {
    console.error(`[meta] sendInstagramImage error:`, err.response?.data || err.message);
    return null;
  }
}

/**
 * Obtiene URL de media de Instagram.
 */
async function getInstagramMediaUrl(mediaId) {
  const token = process.env.PAGE_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token || !mediaId) return null;
  try {
    const r = await axios.get(
      `https://graph.facebook.com/v18.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
    );
    return { url: r.data.url, mimeType: r.data.mime_type };
  } catch (e) {
    console.error('[meta] getInstagramMediaUrl error:', e.response?.data || e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// Facebook Messenger
// ═══════════════════════════════════════════════════════════════

/**
 * Envía mensaje de texto a Facebook Messenger.
 * @param {string} psid - Page Scoped ID del destinatario
 * @param {string} text - texto a enviar
 */
async function sendMessengerMessage(psid, text) {
  const token = process.env.PAGE_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
  const pageId = process.env.FACEBOOK_PAGE_ID;
  if (!token || !pageId) {
    console.error('[meta] sendMessengerMessage: FACEBOOK_PAGE_ID o WHATSAPP_ACCESS_TOKEN no configurados');
    return null;
  }
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v18.0/${pageId}/messages`,
      {
        messaging_type: 'RESPONSE',
        recipient: { id: psid },
        message: { text }
      },
      {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 15000
      }
    );
    console.log(`[meta] Messenger message sent to ${psid}`);
    return response.data;
  } catch (err) {
    console.error(`[meta] sendMessengerMessage error (${psid}):`, err.response?.data || err.message);
    return null;
  }
}

/**
 * Envía imagen a Facebook Messenger.
 */
async function sendMessengerImage(psid, imageUrl) {
  const token = process.env.PAGE_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
  const pageId = process.env.FACEBOOK_PAGE_ID;
  if (!token || !pageId) return null;
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v18.0/${pageId}/messages`,
      {
        messaging_type: 'RESPONSE',
        recipient: { id: psid },
        message: {
          attachment: {
            type: 'image',
            payload: { url: imageUrl }
          }
        }
      },
      {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 15000
      }
    );
    console.log(`[meta] Messenger image sent to ${psid}`);
    return response.data;
  } catch (err) {
    console.error(`[meta] sendMessengerImage error:`, err.response?.data || err.message);
    return null;
  }
}

/**
 * Obtiene URL de media de Messenger.
 */
async function getMessengerMediaUrl(mediaId) {
  const token = process.env.PAGE_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token || !mediaId) return null;
  try {
    const r = await axios.get(
      `https://graph.facebook.com/v18.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
    );
    return { url: r.data.url, mimeType: r.data.mime_type };
  } catch (e) {
    console.error('[meta] getMessengerMediaUrl error:', e.response?.data || e.message);
    return null;
  }
}

// ── Product Messages (WhatsApp) ──────────────────────────────────────────

const META_CATALOG_ID = process.env.META_CATALOG_ID || '759929732681784';

/** Envía tarjeta de producto individual (WhatsApp) */
async function sendWhatsAppProduct(to, retailerId, bodyText, footerText) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.PHONE_NUMBER_ID;
  if (!token || !phoneNumberId || !retailerId) return null;

  try {
    const resp = await axios.post(
      `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive: {
          type: 'product',
          body: { text: (bodyText || '').slice(0, 1024) },
          footer: { text: (footerText || 'Yeppo').slice(0, 60) },
          action: {
            catalog_id: META_CATALOG_ID,
            product_retailer_id: retailerId
          }
        }
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 10000 }
    );
    return resp.data?.messages?.[0]?.id || null;
  } catch (e) {
    console.error('[meta] Product message error:', e.response?.data || e.message);
    return null;
  }
}

/** Envía lista de productos (WhatsApp) — hasta 30 productos */
async function sendWhatsAppProductList(to, productItems, headerText, bodyText, footerText) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.PHONE_NUMBER_ID;
  if (!token || !phoneNumberId || !productItems?.length) return null;

  try {
    const resp = await axios.post(
      `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive: {
          type: 'product_list',
          header: { type: 'text', text: (headerText || 'Recomendados').slice(0, 60) },
          body: { text: (bodyText || '').slice(0, 1024) },
          footer: { text: (footerText || 'Yeppo').slice(0, 60) },
          action: {
            catalog_id: META_CATALOG_ID,
            sections: [{
              title: 'Productos',
              product_items: productItems.slice(0, 30).map(rid => ({
                product_retailer_id: String(rid)
              }))
            }]
          }
        }
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 10000 }
    );
    return resp.data?.messages?.[0]?.id || null;
  } catch (e) {
    console.error('[meta] Product list error:', e.response?.data || e.message);
    return null;
  }
}

/** Busca productos en el catálogo de Meta */
async function searchMetaCatalog(query, limit = 5) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token || !query) return [];

  try {
    const q = encodeURIComponent(query.slice(0, 100));
    const resp = await axios.get(
      `https://graph.facebook.com/v22.0/${META_CATALOG_ID}/products?limit=${limit}&search=${q}&fields=id,name,retailer_id,price,sale_price,image_url,url&access_token=${token}`,
      { timeout: 10000 }
    );
    return resp.data?.data || [];
  } catch (e) {
    console.error('[meta] Catalog search error:', e.response?.data || e.message);
    return [];
  }
}

/** Busca un retailer_id por handle de Shopify (ej: "cica-regen-vegan-sun") */
async function getRetailerIdByHandle(handle, allProductsCache = null) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token || !handle) return null;

  // Buscar en cache primero
  if (allProductsCache && allProductsCache[handle]) {
    return allProductsCache[handle];
  }

  try {
    const q = encodeURIComponent(handle.split('-').slice(0, 3).join(' '));
    const resp = await axios.get(
      `https://graph.facebook.com/v22.0/${META_CATALOG_ID}/products?limit=10&search=${q}&fields=name,retailer_id,url&access_token=${token}`,
      { timeout: 10000 }
    );
    // Buscar el que mejor matchee el handle en la URL
    const products = resp.data?.data || [];
    for (const p of products) {
      if (p.url && p.url.includes(`/products/${handle}`)) {
        return String(p.retailer_id);
      }
    }
    // Fallback: primer resultado si hay alguno
    return products.length > 0 ? String(products[0].retailer_id) : null;
  } catch (e) {
    console.error('[meta] getRetailerId error:', e.response?.data || e.message);
    return null;
  }
}

// ── Product Messages (Instagram) ────────────────────────────────────────

// ── Meta Catalog Product ID Map ───────────────────────────────────────
let metaCatalogIdMap = null; // { retailer_id: catalog_product_id }

async function buildMetaCatalogIdMap() {
  const token = process.env.PAGE_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token) { console.log('[meta] buildMetaCatalogIdMap: sin token'); return {}; }

  const map = {};
  let url = `https://graph.facebook.com/v22.0/${META_CATALOG_ID}/products?limit=200&fields=id,retailer_id`;
  let count = 0;

  while (url) {
    try {
      const resp = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 });
      const products = resp.data?.data || [];
      for (const p of products) {
        if (p.retailer_id && p.id) map[String(p.retailer_id)] = p.id;
      }
      count += products.length;
      url = resp.data?.paging?.next || null;
    } catch (e) {
      console.error('[meta] buildMetaCatalogIdMap error:', e.message);
      break;
    }
  }
  metaCatalogIdMap = map;
  console.log(`[meta] Meta catalog map built: ${count} products, ${Object.keys(map).length} mapped`);
  return map;
}

function getMetaCatalogId(retailerId) {
  if (!metaCatalogIdMap) return null;
  return metaCatalogIdMap[String(retailerId)] || null;
}

// ── Product Messages (Instagram) ───────────────────────────────────────

/**
 * Envía product template en Instagram (formato oficial Meta).
 * Soporta uno o varios productos (hasta 10).
 * @param {string} igUserId - IGSID del usuario
 * @param {string[]} retailerIds - IDs de variante Shopify (retailer_id de Meta)
 */
async function sendInstagramProduct(igUserId, retailerIds) {
  const token = process.env.PAGE_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
  // Probar con IG Business Account ID (docs dicen PAGE-ID pero la app no renderiza con FB Page ID)
  const endpointId = process.env.INSTAGRAM_ACCOUNT_ID || '17841410830948390';
  if (!token || !igUserId || !retailerIds?.length) return null;

  // Mapear retailer_id → catalog product id
  if (!metaCatalogIdMap) await buildMetaCatalogIdMap();
  const elements = [];
  for (const rid of retailerIds) {
    const catalogId = getMetaCatalogId(String(rid));
    if (catalogId) {
      elements.push({ id: catalogId });
    }
  }

  if (!elements.length) {
    console.error('[meta] IG product: no catalog ids found for', retailerIds);
    return null;
  }

  try {
    const resp = await axios.post(
      `https://graph.facebook.com/v22.0/${endpointId}/messages`,
      {
        messaging_product: 'instagram',
        recipient: { id: igUserId },
        message: {
          attachment: {
            type: 'template',
            payload: {
              template_type: 'product',
              elements: elements.slice(0, 10)
            }
          }
        }
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 10000 }
    );
    return resp.data?.message_id || null;
  } catch (e) {
    console.error('[meta] IG product error:', e.response?.data || e.message);
    return null;
  }
}

// ── Product Messages (Messenger) ────────────────────────────────────────

async function sendMessengerProduct(fbUserId, retailerId, title, subtitle) {
  const token = process.env.PAGE_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
  const fbPageId = process.env.FACEBOOK_PAGE_ID || '408038929930148';
  if (!token || !fbUserId || !retailerId) return null;

  try {
    // Messenger usa Generic Template para mostrar productos
    const productInfo = await getProductInfo(retailerId, token);
    const resp = await axios.post(
      `https://graph.facebook.com/v22.0/${fbPageId}/messages`,
      {
        messaging_product: 'messenger',
        recipient: { id: fbUserId },
        message: {
          attachment: {
            type: 'template',
            payload: {
              template_type: 'generic',
              elements: [{
                title: (title || productInfo?.name || 'Producto Yeppo').slice(0, 80),
                subtitle: (subtitle || productInfo?.price || '').slice(0, 80),
                image_url: productInfo?.image_url || '',
                buttons: [{
                  type: 'web_url',
                  url: productInfo?.url || `https://yeppo.cl/products/${title?.toLowerCase().replace(/\s+/g, '-') || 'producto'}`,
                  title: 'Ver producto'
                }]
              }]
            }
          }
        }
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 10000 }
    );
    return resp.data?.message_id || null;
  } catch (e) {
    console.error('[meta] Messenger product error:', e.response?.data || e.message);
    return null;
  }
}

async function getProductInfo(retailerId, token) {
  try {
    const resp = await axios.get(
      `https://graph.facebook.com/v22.0/${retailerId}?fields=name,price,sale_price,image_url,url&access_token=${token}`,
      { timeout: 5000 }
    );
    return resp.data || null;
  } catch { return null; }
}

module.exports = {
  sendMessage, sendTemplate, sendImage, getMediaUrl, downloadMedia,
  sendInstagramMessage, sendInstagramImage, getInstagramMediaUrl,
  sendMessengerMessage, sendMessengerImage, getMessengerMediaUrl,
  sendWhatsAppProduct, sendWhatsAppProductList, searchMetaCatalog,
  getRetailerIdByHandle,
  sendInstagramProduct, sendMessengerProduct,
  META_CATALOG_ID, buildMetaCatalogIdMap
};
