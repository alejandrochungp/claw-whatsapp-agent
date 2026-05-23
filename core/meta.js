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
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const igPageId = process.env.INSTAGRAM_PAGE_ID;
  if (!token || !igPageId) {
    console.error('[meta] sendInstagramMessage: INSTAGRAM_PAGE_ID o WHATSAPP_ACCESS_TOKEN no configurados');
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
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const igPageId = process.env.INSTAGRAM_PAGE_ID;
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
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
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
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
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
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
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
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
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

module.exports = {
  sendMessage, sendTemplate, sendImage, getMediaUrl, downloadMedia,
  sendInstagramMessage, sendInstagramImage, getInstagramMediaUrl,
  sendMessengerMessage, sendMessengerImage, getMessengerMediaUrl
};
