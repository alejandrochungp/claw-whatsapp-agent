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

module.exports = { sendMessage };
