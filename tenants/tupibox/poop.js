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
// Sheets del tenant para registrar análisis
const sheets = require('./sheets');

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

  const systemPrompt = `Eres un especialista en nutrición y salud digestiva canina de TupiBox Fresh.
Tienes experiencia evaluando la salud digestiva de perros a partir de sus heces.

CONTEXTO VETERINARIO:
${contextDoc}

REGLAS CRÍTICAS DE FORMATO — MUY IMPORTANTE:
- NUNCA uses asteriscos (*), guiones bajos (_), almohadillas (#) ni ningún markdown
- NUNCA uses bullets ni listas con símbolos (•, -, *)
- Escribe en texto plano, como si fuera un mensaje de WhatsApp de una persona real
- Usa saltos de línea simples para separar ideas
- Tono cercano, español chileno, sin alarmismo innecesario
- NO menciones TupiBox Fresh ni ningún producto
- NO hagas diagnóstico veterinario formal
- Máximo 160 palabras en total
- Si hay algo serio (sangre, parásitos, heces negras), recomendar vet SIN alarmismo

ESTRUCTURA DE LA RESPUESTA (en texto plano, sin títulos ni bullets):
- Primera línea: estado general (ej: "se ve con atención leve" / "se ve bastante normal" / "esto hay que revisarlo con un vet")
- Luego 2-3 observaciones concretas en párrafo corto: consistencia, color, forma
- Una línea sobre la posible causa
- Un consejo práctico de alimentación o hidratación

EJEMPLO DE TONO CORRECTO:
"se ve con atención leve

las heces están bastante blandas y sin forma definida, con un tono amarillo-verdoso y algo de mucosidad. eso sugiere que el tránsito intestinal está más acelerado de lo normal.

puede ser colitis leve, un cambio de dieta reciente o alguna intolerancia. no es urgente pero vale la pena observarlo.

ofrécele bastante agua y si en 48 horas no mejora o aparecen vómitos, pasa al vet"

Si la imagen no es clara o no es caca de perro, indícalo con naturalidad.`;

  // Prompt separado para extraer metadatos estructurados (no se envía al usuario)
  const metaPrompt = `Analiza esta imagen de heces caninas y responde SOLO con un JSON válido, sin texto adicional ni explicaciones.

Formato exacto requerido:
{
  "clasificacion": "NORMAL|ATENCION_LEVE|REVISION_VETERINARIA",
  "nivel_urgencia": "NORMAL|MONITOREAR|URGENTE|EMERGENCIA",
  "score_consistencia": "1-2|3|4-5|6|7",
  "color_principal": "marron_chocolate|marron_claro|amarillo|verde|negro|rojo|gris|blanco",
  "contenido_visible": "ninguno|mucosidad|sangre|parasitos|grasa|pasto|alimento_no_digerido",
  "posible_causa": "breve descripcion max 60 chars",
  "requiere_seguimiento": true
}

Solo el JSON. Sin texto antes ni después.`;

  // Llamada 1: texto para el usuario (máx 600 tokens = ~180 palabras)
  const analysisText = await ai.analyzeImage(imageBase64, mimeType, systemPrompt, {
    maxTokens: 600,
    userText: 'Analiza esta imagen de heces caninas siguiendo las instrucciones del sistema.'
  });
  if (!analysisText) throw new Error('Claude no retornó análisis');

  // Llamada 2: metadatos estructurados (máx 200 tokens, solo JSON)
  let meta = {};
  try {
    const metaRaw = await ai.analyzeImage(imageBase64, mimeType, metaPrompt, {
      maxTokens: 200,
      userText: 'Analiza esta imagen y devuelve solo el JSON con los metadatos solicitados.'
    });
    const jsonMatch = metaRaw?.match(/\{[\s\S]*\}/);
    if (jsonMatch) meta = JSON.parse(jsonMatch[0]);
  } catch(e) {
    console.log(`[poop] meta extracción falló: ${e.message}`);
  }

  // Clasificar resultado (preferir meta.clasificacion, fallback por texto)
  const lower = analysisText.toLowerCase();
  let result = meta.clasificacion || null;
  if (!result) {
    if (lower.includes('consultar veterinario') || lower.includes('visitar al vet') || lower.includes('veterinario urgente')) {
      result = 'REVISION_VETERINARIA';
    } else if (lower.includes('atención leve') || lower.includes('atencion leve') || lower.includes('hay que revisarlo')) {
      result = 'ATENCION_LEVE';
    } else {
      result = 'NORMAL';
    }
  }

  return { analysisText, result, meta };
}

/**
 * Tagea al lead en MailerLite.
 * Prioridad: email real (desde Sheets) > email generado desde teléfono.
 * Actualiza campos custom: etapa1_cta_click, interesado_fresh, analisis_caca_completado.
 */
async function tagInMailerLite(phone, realEmail = null) {
  if (!MAILERLITE_TOKEN) return;

  try {
    const phoneNormalized = phone.replace(/\D/g, '');
    // Usar email real si lo tenemos, fallback a email generado
    const emailToUse = realEmail || `${phoneNormalized}@whatsapp.tupibox.com`;
    let subscriberId = null;

    // Buscar suscriptor por email
    const searchResp = await axios.get(
      `https://connect.mailerlite.com/api/subscribers/${encodeURIComponent(emailToUse)}`,
      { headers: { Authorization: `Bearer ${MAILERLITE_TOKEN}` } }
    ).catch(() => ({ data: null }));

    if (searchResp.data?.data?.id) {
      subscriberId = searchResp.data.data.id;
      console.log(`📧 MailerLite: suscriptor encontrado (${emailToUse}) → ${subscriberId}`);
    } else {
      // Crear suscriptor nuevo
      const createResp = await axios.post(
        'https://connect.mailerlite.com/api/subscribers',
        {
          email: emailToUse,
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
      console.log(`✅ MailerLite: nuevo suscriptor creado (${emailToUse}) → ${subscriberId}`);
    }

    if (subscriberId) {
      await axios.put(
        `https://connect.mailerlite.com/api/subscribers/${subscriberId}`,
        {
          fields: {
            phone: phone,
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
 * Tagea el resultado del análisis en MailerLite (llamado después del análisis)
 * Busca el suscriptor por teléfono (campo phone) para actualizarlo
 */
async function tagInMailerLiteResult(phone, result) {
  if (!MAILERLITE_TOKEN) return;
  try {
    const phoneNormalized = phone.replace(/\D/g, '');
    // Intentar encontrar por email generado o email real (ambas variantes)
    const emailsToTry = [
      `${phoneNormalized}@whatsapp.tupibox.com`,
    ];
    // También buscar por email real si lo tenemos en Sheets
    try {
      const sub = await sheets.getCustomer(phone) || await sheets.getLead(phone);
      const orig = sub ? null : await sheets.getOriginalCustomer(phone);
      const realEmail = sub?.email || orig?.email;
      if (realEmail) emailsToTry.unshift(realEmail); // priorizar email real
    } catch(e) {}

    let subscriberId = null;
    for (const email of emailsToTry) {
      const r = await axios.get(
        `https://connect.mailerlite.com/api/subscribers/${encodeURIComponent(email)}`,
        { headers: { Authorization: `Bearer ${MAILERLITE_TOKEN}` } }
      ).catch(() => ({ data: null }));
      if (r.data?.data?.id) { subscriberId = r.data.data.id; break; }
    }

    if (!subscriberId) {
      console.log(`[poop] MailerLite: no se encontró suscriptor para ${phone}, creando con email generado`);
      const created = await axios.post('https://connect.mailerlite.com/api/subscribers',
        { email: `${phoneNormalized}@whatsapp.tupibox.com`, fields: { phone, canal_origen: 'whatsapp' } },
        { headers: { Authorization: `Bearer ${MAILERLITE_TOKEN}`, 'Content-Type': 'application/json' } }
      );
      subscriberId = created.data?.data?.id;
    }

    if (!subscriberId) return;

    const tagField = result === 'NORMAL' ? 'caca_normal'
      : result === 'ATENCION_LEVE' ? 'caca_atencion_leve'
      : 'caca_revision_vet';

    await axios.put(
      `https://connect.mailerlite.com/api/subscribers/${subscriberId}`,
      { fields: { analisis_caca_completado: 'true', [tagField]: 'true', interesado_fresh: 'true' } },
      { headers: { Authorization: `Bearer ${MAILERLITE_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    console.log(`✅ MailerLite post-análisis: ${phone} → ${tagField}`);
  } catch(err) {
    console.error(`⚠️ MailerLite post-análisis error: ${err.message}`);
  }
}

/**
 * Postea el análisis al canal Slack para supervisión
 */
async function postPoopToSlack(phone, result, analysisText, meta) {
  const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
  const SLACK_CHANNEL = process.env.SLACK_CHANNEL_ID || 'C06BWBXMHSQ';
  if (!SLACK_TOKEN) return;

  const emoji = result === 'NORMAL' ? '🟢' : result === 'ATENCION_LEVE' ? '🟡' : '🔴';
  const urgencia = meta?.nivel_urgencia || result;
  const score = meta?.score_consistencia ? `Score ${meta.score_consistencia}` : '';
  const color = meta?.color_principal ? `Color: ${meta.color_principal}` : '';
  const contenido = meta?.contenido_visible && meta.contenido_visible !== 'ninguno' ? `Contenido: ${meta.contenido_visible}` : '';

  const metaLine = [score, color, contenido].filter(Boolean).join(' | ');

  const text = `${emoji} *Análisis de caca* — \`${phone}\`\n*Resultado:* ${result} (${urgencia})\n${metaLine ? `*Detalles:* ${metaLine}\n` : ''}*Posible causa:* ${meta?.posible_causa || 'no determinada'}\n\n_${analysisText.substring(0, 300).replace(/\n/g, ' ')}_`;

  try {
    await axios.post('https://slack.com/api/chat.postMessage',
      { channel: SLACK_CHANNEL, text, mrkdwn: true },
      { headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    console.log(`✅ [poop] Slack notificado`);
  } catch(e) {
    console.log(`[poop] Slack error: ${e.message}`);
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

    // Obtener email real desde Sheets si existe
    let realEmail = null;
    try {
      const sub = await sheets.getCustomer(phone) || await sheets.getLead(phone);
      if (!sub) {
        const orig = await sheets.getOriginalCustomer(phone);
        realEmail = orig?.email || null;
      } else {
        realEmail = sub?.email || null;
      }
    } catch(e) {}

    // Tagear en MailerLite con email real si lo tenemos
    tagInMailerLite(phone, realEmail).catch(() => {});

    return {
      handled: true,
      reply: `Perfecto! 🐾 para saber más sobre la digestión de tu perro necesito que me mandes una foto clara de su caca.\n\nSi puedes, tómala con luz natural y que se vea bien de cerca. La analizo en segundos y te cuento qué está indicando sobre su alimentación!`
    };
  }

  // CASO 2: Imagen llegó mientras esperábamos foto
  if (hasImage(message) && session.state === POOP_STATES.WAITING_PHOTO) {
    await setPoopSessionPersisted(phone, { ...session, state: POOP_STATES.ANALYZING });

    try {
      const { base64, mimeType } = await downloadWhatsAppImage(message.image.id, accessToken);
      const { analysisText, result, meta } = await analyzePoopImage(base64, mimeType);
      await setPoopSessionPersisted(phone, { ...session, state: POOP_STATES.DONE, result });

      console.log(`✅ [poop] Análisis completado para ${phone}: ${result}`);

      // Registrar en Sheets con metadatos estructurados
      sheets.appendRow('Análisis Caca', [
        new Date().toISOString(),
        phone,
        result,
        meta.nivel_urgencia || '',
        meta.score_consistencia || '',
        meta.color_principal || '',
        meta.contenido_visible || '',
        meta.posible_causa || '',
        meta.requiere_seguimiento ? 'sí' : 'no',
        analysisText.substring(0, 500),
        'whatsapp'
      ]).catch(e => console.log(`[poop] sheets log error: ${e.message}`));

      // Tagear resultado en MailerLite post-análisis
      tagInMailerLiteResult(phone, result).catch(() => {});

      // Notificar Slack para supervisión
      postPoopToSlack(phone, result, analysisText, meta).catch(() => {});

      // Mensaje de continuidad según resultado
      let followUpReply = '';
      if (result === 'NORMAL') {
        followUpReply = `lo que comes impacta directamente en lo que ves ahí 🐾\n\nsi te interesa saber más sobre cómo la alimentación afecta la digestión de tu perro, cuéntame qué come actualmente y te doy mi opinión`;
      } else if (result === 'ATENCION_LEVE') {
        followUpReply = `este tipo de señales generalmente mejoran bastante rápido con ajustes en la alimentación.\n\nsi quieres, cuéntame qué come actualmente y vemos si hay algo que pueda estar causando esto`;
      } else if (result === 'REVISION_VETERINARIA') {
        followUpReply = `lo primero es el vet, no lo postergues.\n\ncuando ya estén más tranquilos, si quieres conversamos sobre la dieta y cómo puede ayudar en la recuperación`;
      }

      return {
        handled: true,
        // Acuse inmediato — el análisis llega "después" vía delayedReply
        reply: `listo, ya vi la foto 👀 te mando el análisis en un momento`,
        delayedReply: analysisText,
        followUpReply,
        result
      };

    } catch (err) {
      console.error(`❌ [poop] Error analizando imagen de ${phone}:`, err.message);
      poopSessions.delete(phone);
      return {
        handled: true,
        reply: `tuve un problema procesando la imagen, puedes enviarla de nuevo? asegúrate que sea foto directa y con buena luz`
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
