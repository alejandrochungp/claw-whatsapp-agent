/**
 * tenants/tupibox/poop.js - Módulo de análisis de caca para TupiBox Fresh
 *
 * Adaptado desde tupibox-fresh/webhook/poop-analysis.js para el repo multi-tenant.
 * Usa core/ai.js para el análisis de imagen (en vez de axios directo a Claude).
 *
 * Flujo:
 * 1. Lead recibe E1 del funnel evergreen
 * 2. Clickea CTA → abre WhatsApp con mensaje pre-cargado
 * 3. Envía foto de la caca de su perro
 * 4. Este módulo detecta la foto, analiza con Claude Vision via core/ai
 * 5. Responde con análisis personalizado
 * 6. Tagea en MailerLite
 */

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

// Módulo AI del core (usa Claude Vision internamente)
const ai = require('../../core/ai');

const CLAUDE_API_KEY  = process.env.CLAUDE_API_KEY;
const MAILERLITE_TOKEN = process.env.MAILERLITE_TOKEN;

// Estados de conversación de análisis de caca
const POOP_STATES = {
  IDLE:          'idle',           // Sin análisis activo
  WAITING_PHOTO: 'waiting_photo',  // Esperando foto tras CTA
  ANALYZING:     'analyzing',      // Procesando imagen
  DONE:          'done'            // Análisis completado
};

// Cache de estados por número de teléfono
const poopSessions = new Map();

// Persistencia en Redis (evita perder sesiones si Railway reinicia)
let redisClient = null;
try {
  if (process.env.REDIS_URL) {
    let createClient;
    try { createClient = require('redis').createClient; } catch { createClient = null; }
    if (createClient) {
      redisClient = createClient({ url: process.env.REDIS_URL });
      redisClient.connect().catch(e => {
        console.error('[poop] Redis no disponible, usando RAM:', e.message);
        redisClient = null;
      });
    }
  }
} catch (e) { redisClient = null; }

async function getPoopSessionPersisted(phone) {
  if (redisClient) {
    try {
      const val = await redisClient.get(`poop:${phone}`);
      return val ? JSON.parse(val) : { state: POOP_STATES.IDLE };
    } catch { /* fallback */ }
  }
  return poopSessions.get(phone) || { state: POOP_STATES.IDLE };
}

async function setPoopSessionPersisted(phone, session) {
  poopSessions.set(phone, session);
  if (redisClient) {
    try {
      await redisClient.setEx(`poop:${phone}`, 7200, JSON.stringify(session)); // TTL 2h
    } catch { /* no crítico */ }
  }
}

// Cargar documento de contexto veterinario
function loadContextDoc() {
  // Primero: variable de entorno (para Railway)
  if (process.env.POOP_CONTEXT_DOC) {
    return process.env.POOP_CONTEXT_DOC;
  }

  // Segundo: archivo local (junto a este módulo)
  const contextPath = path.join(__dirname, 'poop-context.md');
  if (fs.existsSync(contextPath)) {
    return fs.readFileSync(contextPath, 'utf8');
  }

  // Fallback: contexto base mínimo
  return `
# Guía de análisis de heces caninas

## Escala de consistencia (Bristol canina)
- Tipo 1-2: Muy duras/secas → posible deshidratación, dieta seca excesiva
- Tipo 3-4: Ideales → bien hidratadas, forma definida, no dejan residuo
- Tipo 5-6: Blandas/pastosas → digestión acelerada, intolerancia, estrés
- Tipo 7: Líquidas/acuosas → infección, parásitos, urgencia veterinaria

## Colores y significado
- Marrón oscuro normal: saludable
- Marrón muy oscuro/negro: posible sangrado digestivo alto → veterinario
- Rojo/sangre visible: sangrado digestivo bajo → veterinario
- Amarillo/naranja: hígado, dieta rica en zanahoria/batata, bilis
- Verde: hierba comida en exceso, tránsito rápido
- Blanco/grisáceo: exceso de calcio (huesos), problemas de hígado/páncreas

## Clasificación de resultados
- NORMAL: consistencia 3-4, marrón oscuro, sin moco ni sangre
- ATENCION_LEVE: consistencia 5-6 ocasional, color amarillo, moco leve
- REVISION_VETERINARIA: sangre, parásitos visibles, líquida persistente, negro
  `.trim();
}

/**
 * Detecta si un mensaje es un CTA de análisis de caca usando Claude.
 * Costo: ~$0.00005 USD por mensaje (Claude Haiku, solo texto corto).
 */
async function isPoopCTAMessage(messageText) {
  if (!messageText || messageText.length < 3) return false;

  // Chequeo rápido: si no tiene ninguna señal mínima, no gastar tokens
  const lower = messageText.toLowerCase();
  const hasSignal = /caca|heces|deposic|analiz|poopo|popo|mierda|popó|excrement|materia fecal/.test(lower);
  if (!hasSignal) return false;

  // Llamar a Claude Haiku para confirmar intención
  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-3-haiku-20240307',
        max_tokens: 10,
        messages: [{
          role: 'user',
          content: `¿Este mensaje indica que una persona quiere que analicen la caca/heces de su perro? Responde solo "SI" o "NO".\n\nMensaje: "${messageText}"`
        }]
      },
      {
        headers: {
          'x-api-key': CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        timeout: 5000
      }
    );
    const answer = response.data?.content?.[0]?.text?.trim().toUpperCase();
    return answer === 'SI' || answer === 'SÍ';
  } catch (e) {
    // Si Claude falla, fallback a regex básico
    console.error('[poop] Claude CTA detection fallback:', e.message);
    return /caca|heces|analiz/.test(lower);
  }
}

/**
 * Detecta si el mensaje contiene una imagen
 */
function hasImage(message) {
  return message?.type === 'image' && message?.image?.id;
}

/**
 * Obtiene el estado actual de análisis para un número
 */
function getPoopSession(phone) {
  return poopSessions.get(phone) || { state: POOP_STATES.IDLE };
}

/**
 * Limpia sesiones viejas (>2 horas)
 */
function cleanOldSessions() {
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  const now = Date.now();
  for (const [phone, session] of poopSessions.entries()) {
    if (now - session.startedAt > TWO_HOURS) {
      poopSessions.delete(phone);
    }
  }
}
setInterval(cleanOldSessions, 30 * 60 * 1000); // Limpiar cada 30 min

/**
 * Descarga la imagen de WhatsApp usando la Media API de Meta
 */
async function downloadWhatsAppImage(imageId, accessToken) {
  // Paso 1: obtener URL de descarga
  const mediaResp = await axios.get(
    `https://graph.facebook.com/v17.0/${imageId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const mediaUrl = mediaResp.data.url;

  // Paso 2: descargar la imagen como buffer
  const imgResp = await axios.get(mediaUrl, {
    responseType: 'arraybuffer',
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  return {
    base64: Buffer.from(imgResp.data).toString('base64'),
    mimeType: imgResp.headers['content-type'] || 'image/jpeg'
  };
}

/**
 * Analiza la imagen de la caca usando core/ai.analyzeImage
 *
 * NOTA: ai.analyzeImage(base64, mimeType, systemPrompt) acepta 3 parámetros.
 * Combinamos el systemPrompt con el userPrompt en el campo system para
 * que Claude reciba ambas instrucciones correctamente.
 */
async function analyzePoopImage(imageBase64, mimeType) {
  const contextDoc = loadContextDoc();

  const systemPrompt = `Eres un asistente especializado en nutrición y salud digestiva canina de TupiBox Fresh.
Tienes experiencia evaluando la salud digestiva de perros a partir de sus heces.

CONTEXTO VETERINARIO:
${contextDoc}

REGLAS CRÍTICAS:
- Responde en español chileno, tono cercano y amigable (no alarmar innecesariamente)
- NO menciones TupiBox Fresh ni ningún producto en este mensaje
- NO hagas diagnóstico veterinario formal
- Si hay algo serio (sangre, parásitos visibles, heces negras), recomendar visita al vet SIN alarmismo
- Máximo 180 palabras en total
- Sé concreto y útil, no genérico

INSTRUCCIÓN DE ANÁLISIS:
Por favor analiza estas heces caninas y responde con:

1. Estado general: (una línea: Normal / Atención leve / Consultar veterinario)
2. Lo que observo (2-3 puntos concretos): consistencia, color, forma
3. Posible causa (1-2 líneas): qué puede estar pasando
4. Un consejo práctico relacionado con alimentación o hidratación

Si la imagen no es clara o no es una foto de heces caninas, indícalo amablemente.`;

  // ai.analyzeImage(base64, mimeType, systemPrompt) — firma del core
  const analysisText = await ai.analyzeImage(imageBase64, mimeType, systemPrompt);

  if (!analysisText) throw new Error('Claude no retornó análisis');

  // Clasificar resultado
  const lower = analysisText.toLowerCase();
  let result;
  if (lower.includes('consultar veterinario') || lower.includes('visitar al vet') || lower.includes('veterinario urgente')) {
    result = 'REVISION_VETERINARIA';
  } else if (lower.includes('atención leve') || lower.includes('atencion leve') || lower.includes('mejorar')) {
    result = 'ATENCION_LEVE';
  } else {
    result = 'NORMAL';
  }

  return { analysisText, result };
}

/**
 * Tagea al lead como "interesado_fresh" en MailerLite
 * Crea el suscriptor si no existe (usando email generado desde teléfono)
 */
async function tagInMailerLite(phone) {
  if (!MAILERLITE_TOKEN) return;

  try {
    const phoneNormalized = phone.replace(/\D/g, '');
    const phoneEmail = `${phoneNormalized}@whatsapp.tupibox.com`;
    let subscriberId = null;

    // Buscar suscriptor por email generado desde teléfono
    const searchResp = await axios.get(
      `https://connect.mailerlite.com/api/subscribers/${encodeURIComponent(phoneEmail)}`,
      { headers: { Authorization: `Bearer ${MAILERLITE_TOKEN}` } }
    ).catch(() => ({ data: null }));

    if (searchResp.data?.data?.id) {
      subscriberId = searchResp.data.data.id;
      console.log(`📧 MailerLite: suscriptor encontrado ${subscriberId}`);
    } else {
      // Crear suscriptor nuevo
      const createResp = await axios.post(
        'https://connect.mailerlite.com/api/subscribers',
        {
          email: phoneEmail,
          fields: {
            phone: phone,
            etapa1_cta_click: 'true',
            interesado_fresh: 'true',
            canal_origen: 'whatsapp'
          }
        },
        { headers: { Authorization: `Bearer ${MAILERLITE_TOKEN}`, 'Content-Type': 'application/json' } }
      );
      subscriberId = createResp.data?.data?.id;
      console.log(`✅ MailerLite: nuevo suscriptor creado desde WA ${subscriberId}`);
    }

    if (subscriberId) {
      await axios.put(
        `https://connect.mailerlite.com/api/subscribers/${subscriberId}`,
        {
          fields: {
            etapa1_cta_click: 'true',
            interesado_fresh: 'true',
            analisis_caca_completado: 'true'
          }
        },
        { headers: { Authorization: `Bearer ${MAILERLITE_TOKEN}`, 'Content-Type': 'application/json' } }
      );
      console.log(`✅ MailerLite: ${phone} tageado correctamente`);
    }
  } catch (err) {
    console.error(`⚠️ Error MailerLite: ${err.message}`);
  }
}

/**
 * FUNCIÓN PRINCIPAL
 * Procesa un mensaje entrante y determina si es parte del flujo de análisis
 *
 * @param {string} phone        - Número del lead (E.164)
 * @param {object} message      - Objeto mensaje de Meta API
 * @param {string} accessToken  - Token de WhatsApp Business
 * @returns {object|null}       - { reply, handled, result?, followUpReply? } o null si no aplica
 */
async function handleMessage(phone, message, accessToken) {
  const session = await getPoopSessionPersisted(phone);

  // CASO 1: Mensaje de texto con CTA → iniciar flujo
  if (message.type === 'text' && await isPoopCTAMessage(message.text?.body)) {
    const newSession = { state: POOP_STATES.WAITING_PHOTO, startedAt: Date.now(), attempts: 0 };
    await setPoopSessionPersisted(phone, newSession);

    // Tagear en MailerLite (async, no bloqueante)
    tagInMailerLite(phone).catch(() => {});

    return {
      handled: true,
      reply: `Perfecto! 🐾 para saber más sobre la digestión de tu perro necesito que me mandes una foto clara de su caca.\n\nSi puedes, tómala con luz natural y que se vea bien de cerca. La analizo en segundos y te cuento qué está indicando sobre su alimentación!`
    };
  }

  // CASO 2: Imagen llegó mientras esperábamos foto
  if (hasImage(message) && session.state === POOP_STATES.WAITING_PHOTO) {
    // Actualizar estado
    await setPoopSessionPersisted(phone, { ...session, state: POOP_STATES.ANALYZING });

    try {
      // Descargar imagen
      const { base64, mimeType } = await downloadWhatsAppImage(message.image.id, accessToken);

      // Analizar con Claude Vision via core/ai
      const { analysisText, result } = await analyzePoopImage(base64, mimeType);

      // Marcar sesión como completada
      await setPoopSessionPersisted(phone, { ...session, state: POOP_STATES.DONE, result });

      console.log(`✅ [poop] Análisis completado para ${phone}: ${result}`);

      // Mensaje de continuidad según resultado
      let followUpReply = '';
      if (result === 'NORMAL') {
        followUpReply = `buena señal! lo que ves en las heces refleja directamente cómo está procesando la comida tu perro.\n\nsi quieres entender más sobre qué revela la digestión canina y cómo la alimentación impacta en esto, te mando info por correo — sin spam, solo lo útil. te sirve?`;
      } else if (result === 'ATENCION_LEVE') {
        followUpReply = `hay algunas señales que vale la pena observar. la buena noticia es que con ajustes en la alimentación se corrige en días.\n\nsi quieres, te mando por correo una guía sobre qué cambios dietarios ayudan — con base en lo que acabas de ver. te parece?`;
      } else if (result === 'REVISION_VETERINARIA') {
        followUpReply = `lo más importante ahora es ir al vet, no esperes.\n\nsi quieres entender mejor qué está pasando y cómo la dieta puede apoyar la recuperación, puedo mandarte info por correo. tienes el correo a mano?`;
      }

      return {
        handled: true,
        reply: analysisText,
        followUpReply,
        result
      };

    } catch (err) {
      console.error(`❌ [poop] Error analizando imagen de ${phone}:`, err.message);
      poopSessions.delete(phone);

      return {
        handled: true,
        reply: `Lo siento, tuve un problema procesando la imagen. Puedes intentar enviarla de nuevo? Asegúrate que sea una foto directa (no captura de pantalla) y que se vea con claridad. 📸`
      };
    }
  }

  // CASO 3: Imagen llegó pero no estaban en el flujo → dejar que flujo normal maneje
  if (hasImage(message) && session.state === POOP_STATES.IDLE) {
    return null;
  }

  // No aplica este módulo
  return null;
}

module.exports = {
  handleMessage,
  isPoopCTAMessage,
  hasImage,
  getPoopSession,
  POOP_STATES
};
