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

module.exports = { sendMessage, sendTemplate, sendImage, getMediaUrl, downloadMedia };
