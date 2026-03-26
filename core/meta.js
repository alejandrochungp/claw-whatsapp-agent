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

module.exports = { sendMessage, getMediaUrl, downloadMedia };
