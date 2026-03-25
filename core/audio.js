/**
 * core/audio.js — Transcripción de notas de voz vía OpenAI Whisper
 *
 * Flujo:
 * 1. Recibe media_id de Meta
 * 2. Obtiene URL de descarga desde Graph API
 * 3. Descarga el audio
 * 4. Envía a Whisper para transcripción
 * 5. Retorna texto
 */

const axios  = require('axios');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const FormData = require('form-data');

const OPENAI_KEY = process.env.OPENAI_API_KEY;

/**
 * Descargar y transcribir audio de WhatsApp
 * @param {string} mediaId — ID del media de Meta
 * @param {object} config — config del tenant (tiene WHATSAPP_ACCESS_TOKEN)
 * @returns {string|null} — texto transcrito o null si falla
 */
async function transcribeWhatsAppAudio(mediaId, config) {
  const waToken = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!OPENAI_KEY) {
    console.log('[audio] OPENAI_API_KEY no configurado — ignorando audio');
    return null;
  }

  try {
    // 1. Obtener URL de descarga desde Meta Graph API
    const mediaInfo = await axios.get(
      `https://graph.facebook.com/v18.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${waToken}` }, timeout: 10000 }
    );

    const mediaUrl  = mediaInfo.data.url;
    const mimeType  = mediaInfo.data.mime_type || 'audio/ogg';

    // 2. Descargar el audio
    const audioResp = await axios.get(mediaUrl, {
      headers: { Authorization: `Bearer ${waToken}` },
      responseType: 'arraybuffer',
      timeout: 30000
    });

    // 3. Guardar en archivo temporal
    const ext      = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'mp4' : 'ogg';
    const tmpPath  = path.join(os.tmpdir(), `wa_audio_${mediaId}.${ext}`);
    fs.writeFileSync(tmpPath, Buffer.from(audioResp.data));

    // 4. Enviar a Whisper
    const form = new FormData();
    form.append('file', fs.createReadStream(tmpPath), { filename: `audio.${ext}`, contentType: mimeType });
    form.append('model', 'whisper-1');
    form.append('language', 'es');

    const whisperResp = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      form,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_KEY}`,
          ...form.getHeaders()
        },
        timeout: 30000
      }
    );

    // 5. Limpiar archivo temporal
    fs.unlinkSync(tmpPath);

    const text = whisperResp.data.text?.trim();
    if (text) {
      console.log(`[audio] Transcrito (${mediaId}): "${text.slice(0, 80)}..."`);
    }
    return text || null;

  } catch (err) {
    console.error(`[audio] Error transcribiendo ${mediaId}:`, err.response?.data || err.message);
    return null;
  }
}

module.exports = { transcribeWhatsAppAudio };
