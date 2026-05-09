/**
 * tenants/tupibox/business.js
 *
 * Lógica de negocio TupiBox Fresh.
 * Mantiene paridad con el bot actual (server.js del repo viejo).
 */

const fs         = require('fs');
const path       = require('path');
const axios      = require('axios');
const sheets     = require('./sheets');
const extraction = require('./extraction');

const PROMPT_BASE = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8');

// URL base del formulario de pedido
const FORM_URL = process.env.FORM_URL || 'https://go.tupibox.com';

/**
 * Reglas rápidas sin LLM.
 * Retorna null si no aplica → core usará IA.
 */
async function quickReply(userText, context, history) {
  const text  = userText.toLowerCase().trim();
  const isNew = history.length <= 1;

  // REMOVIDO: saludos los maneja Claude (más natural)
  // if (/^(hola|hi|buenas|buenos días|buenas tardes|buenas noches|saludos)$/.test(text)) {
  //   if (!isNew) {
  //     return { text: 'Hola de nuevo!\n\nen qué te puedo ayudar hoy?', useAI: false };
  //   }
  //   return {
  //     text: 'Hola! qué gusto que nos escribas.\n\nte puedo ayudar con info sobre planes, hacer un pedido nuevo, consultar uno existente o conectarte con el equipo.\n\nqué necesitas?',
  //     useAI: false
  //   };
  // }

  // ── Returning user keywords → dejar que la IA maneje con contexto ────────
  if (/^(continuar|continuemos|dale|si|me interesa|quiero comprar)$/.test(text)) {
    if (context?.dogName && context?.weight && context?.activityLevel) {
      return null; // AI maneja con contexto enriquecido (returning user)
    }
  }

  // ── Pedir humano ─────────────────────────────────────────────────────────
  if (/humano|persona|equipo|ayuda/.test(text)) {
    const isOpen = isBusinessHours();
    const msg = isOpen
      ? 'Ok, te conecto con el equipo.\n\nen unos minutos te responden por acá mismo.'
      : 'Te entiendo! lamentablemente ahora estamos fuera de horario (lun-vie 10:00-18:00).\n\npero igual te conecto y apenas abramos te responden.';
    return { text: msg, notifySlack: true };
  }

  // ── Consultar pedido existente ───────────────────────────────────────────
  if (/(consultar|ver|estado|seguimiento).*(pedido)|(pedido).*(consultar|ver|estado)/.test(text)) {
    const msg = context?.orderNumber
      ? `Claro, te ayudo con el pedido #${context.orderNumber}.\n\npara ver el estado actualizado necesito conectarte con el equipo.\n\nescribe "humano" y te responden altiro.`
      : 'Claro, te ayudo con tu pedido.\n\npara ver el estado necesito conectarte con el equipo.\n\nescribe "humano" y te responden altiro.';
    return { text: msg, notifySlack: true };
  }

  // ── Respuesta indiferente en paso de proteína/alergias → sin preferencia ─
  if (/no\s*s[eé]|da\s*(lo\s*mismo|igual)|cualquiera|lo\s*que\s*sea|ninguna|sin\s*preferencia/.test(text)) {
    // Si ya tenemos datos base (nombre, peso, edad, actividad) → paso 5 o 6
    if (context?.dogName && context?.weight && (context?.ageYears || context?.ageMonths) && context?.activityLevel) {
      return null; // IA asume "sin preferencia" según instrucción en prompt
    }
  }

  // ── Todo lo demás → IA ───────────────────────────────────────────────────
  return null;
}

/**
 * Construir system prompt enriquecido con datos del cliente.
 */
function buildSystemPrompt(context) {
  let prompt = PROMPT_BASE;

  if (context && Object.keys(context).length > 0) {
    prompt += '\n\n---\n\n📋 DATOS DEL CLIENTE (úsalos para personalizar):\n';

    if (context.customerName)   prompt += `- Cliente: ${context.customerName}\n`;
    if (context.dogName)        prompt += `- Perro: ${context.dogName}${context.breed ? ` (${context.breed})` : ''}\n`;
    if (context.weight)         prompt += `- Peso: ${context.weight}kg\n`;
    if (context.ageYears)       prompt += `- Edad: ${context.ageYears} años\n`;
    if (context.ageMonths)      prompt += `- Edad: ${context.ageMonths} meses\n`;
    if (context.activityLevel)  prompt += `- Actividad: ${context.activityLevel}\n`;
    if (context.allergies)      prompt += `- Alergias: ${context.allergies}\n`;
    if (context.protein)        prompt += `- Proteína preferida: ${context.protein}\n`;
    if (context.plan)           prompt += `- Plan actual/interesado: ${context.plan}\n`;
    if (context.city)           prompt += `- Ciudad: ${context.city}\n`;
    if (context.orderNumber)    prompt += `- Pedido en seguimiento: #${context.orderNumber}\n`;

    // Usuario con datos previos en Redis (cualquier fuente)
    if (context.dogName && context.weight && context.activityLevel) {
      prompt += `\n⭐ CLIENTE QUE VUELVE: este cliente ya tiene datos guardados (${context.dogName}, ${context.weight}kg, actividad ${context.activityLevel}).\n`;
      prompt += `NO preguntes "que necesitas" o "Fresh o cajas tematicas". Saluda con: "hola de nuevo! seguimos con ${context.dogName}?"\n`;
      prompt += `Si el cliente dice "si", "dale", "continuar", "ok", "me interesa" -> di "perfecto! retomemos. tenias a ${context.dogName}, ${context.weight}kg. quieres modificar algo o seguimos con el link?"\n`;
    }

    // Cliente recurrente de TupiBox Original
    if (context.isReturningCustomer) {
      prompt += `\n⭐ CLIENTE RECURRENTE: tiene ${context.totalOrders || 'varios'} pedido(s) de TupiBox Original (cajas temáticas).\n`;
      prompt += `Reconócelo como cliente conocido. Puedes mencionar que ya conoce la marca y presentarle Fresh como el siguiente paso natural.\n`;
      prompt += `Ejemplo: "ya que conoces TupiBox, Fresh es la versión de alimentación — mismo cuidado pero en comida diaria para [nombre perro]"\n`;
    }

    // Template de seguimiento: el usuario responde a un mensaje que enviamos
    if (context.tplFollowup) {
      const tpl = context.tplFollowup;
      prompt += `\n📨 SEGUIMIENTO: este usuario respondió a nuestro mensaje de seguimiento "${tpl.template}" que enviamos hace ${tpl.repliedAfterMin} minutos.\n`;
      prompt += `El usuario fue reactivado por este mensaje automático. Asume que retomó el interés. Pregúntale en qué quedó o si necesita ayuda para decidir.\n`;
    }

    // El sistema enviará los links de MercadoPago automáticamente cuando estén los datos.
    if (context.dogName && context.weight && (context.ageYears || context.ageMonths) && context.activityLevel && !context.prefillUrlSent) {
      prompt += `\n⚠️ Datos completos: ya tienes nombre, peso, edad y actividad.\n`;
      prompt += `Dile al cliente: "ya tengo todo! te mando los links de pago ahora" — el sistema los envía automático via MercadoPago.\n`;
    }
  }

  return prompt;
}

/**
 * Construir URL del formulario con parámetros pre-cargados.
 */
function buildPrefillUrl(ctx) {
  const params = new URLSearchParams();

  if (ctx.dogName)       params.set('petname', ctx.dogName);
  if (ctx.weight)        params.set('weight', ctx.weight);
  if (ctx.sex)           params.set('sex', ctx.sex);
  if (ctx.activityLevel) params.set('activityLevel', ctx.activityLevel);
  if (ctx.allergies && ctx.allergies !== 'Sin alergias') params.set('allergie', ctx.allergies);

  // Edad en meses
  if (ctx.ageMonths) {
    params.set('ageInMonths', ctx.ageMonths);
  } else if (ctx.ageYears) {
    params.set('ageInMonths', Math.round(parseFloat(ctx.ageYears) * 12));
  }

  return `${FORM_URL}?${params.toString()}&product_type=fresh`;
}

/**
 * Calcular porciones mensuales según peso y actividad.
 */
function calcPortions(weight, activityLevel) {
  const act = (activityLevel || 'medio').toLowerCase();
  let ratio;
  if (/alto|alta|high/.test(act))       ratio = 2.3;
  else if (/bajo|baja|low/.test(act))   ratio = 1.4;
  else                                   ratio = 1.9; // medio/default
  return Math.ceil(parseFloat(weight) * ratio);
}

/**
 * Llamar al backend MercadoPago y obtener links de pago.
 * Retorna { portions, price1month, price3months, price6months, paymentLink, subscriptionLink }
 * En caso de error parcial, los links fallidos quedan null.
 */
async function buildMercadoPagoLink(ctx) {
  const config = require('./config');
  const logger = require('../../core/logger');

  const backendUrl = config.mercadoPagoBackendUrl;
  const portions   = calcPortions(ctx.weight || 10, ctx.activityLevel);

  const price1month  = portions * 5490;
  const price3months = portions * 5216; // 5% dto
  const price6months = portions * 4941; // 10% dto

  const ageInMonths = ctx.ageMonths
    ? parseInt(ctx.ageMonths)
    : ctx.ageYears
      ? Math.round(parseFloat(ctx.ageYears) * 12)
      : null;

  const dogData = {
    petname:           ctx.dogName || '',
    weight:            ctx.weight  || '',
    ageInMonths,
    activityLevel:     ctx.activityLevel || '',
    allergies:         ctx.allergies || '',
    proteinPreference: ctx.protein  || '',
    portions,
  };

  const headers = { 'Content-Type': 'application/json' };
  if (config.mercadoPagoAccessToken) {
    headers['Authorization'] = `Bearer ${config.mercadoPagoAccessToken}`;
  }

  let paymentLink      = null;
  let subscriptionLink = null;

  try {
    const res = await axios.post(`${backendUrl}/payment`, {
      ...dogData,
      amount:      price1month,
      currency_id: 'CLP',
      title:       `TupiBox Fresh - ${ctx.dogName} - 1 mes`,
      description: `Plan mensual: ${portions} envases`,
    }, { headers, timeout: 10000 });
    paymentLink = res.data?.init_point || null;
  } catch (err) {
    logger.log(`[mp] /payment error: ${err.message}`);
  }

  try {
    const res = await axios.post(`${backendUrl}/create_subscription`, {
      ...dogData,
      amount:      price1month,
      currency_id: 'CLP',
      reason:      `TupiBox Fresh - ${ctx.dogName} - suscripcion mensual`,
    }, { headers, timeout: 10000 });
    subscriptionLink = res.data?.init_point || null;
  } catch (err) {
    logger.log(`[mp] /create_subscription error: ${err.message}`);
  }

  return { portions, price1month, price3months, price6months, paymentLink, subscriptionLink };
}

function isBusinessHours() {
  const now       = new Date();
  const chileTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Santiago' }));
  const day  = chileTime.getDay();
  const hour = chileTime.getHours();
  return day >= 1 && day <= 5 && hour >= 10 && hour < 18;
}

/**
 * Hook post-respuesta: guardar lead + extraer datos con IA
 * Llamado por el core después de enviar la respuesta al cliente.
 */
async function afterReply(phone, userText, botReply, history, context) {
  const logger = require('../../core/logger');
  const memory = require('../../core/memory');

  try {
    // 1. Capturar lead si es nuevo
    const isNew = await sheets.isNewLead(phone);
    if (isNew) {
      await sheets.captureLead({
        phone,
        source: 'WhatsApp Bot',
        intent: context?.lastIntent || '',
        message: userText,
        notes: `Primera conversación: ${new Date().toISOString()}`
      });
      await memory.updateContext(phone, { last_bot_intent: 'initial_contact', last_bot_intent_ts: Date.now() });
    }

    // 2. Extracción inteligente si hay suficiente conversación
    if (history.length >= 4) {
      const extracted = await extraction.extractFromConversation(history);
      if (Object.keys(extracted).length > 0) {
        const mapped = extraction.mapToSheetFormat ? extraction.mapToSheetFormat(extracted) : extracted;
        await sheets.updateLead(phone, mapped);

        // Actualizar contexto Redis con los datos extraídos
        await memory.updateContext(phone, mapped);
        logger.log(`[sheets] Contexto actualizado con ${Object.keys(mapped).length} campos`);

        // 3. Si tenemos los datos requeridos y aún no se envió el link, enviarlo ahora
        const merged = { ...context, ...mapped };
        if (!context.prefillUrlSent && hasRequiredFields(merged)) {
          const meta   = require('../../core/meta');
          const config = require('./config');

          let messageText;
          let mpData = null;

          try {
            mpData = await buildMercadoPagoLink(merged);
          } catch (err) {
            logger.log(`[mp] buildMercadoPagoLink error: ${err.message}`);
          }

          if (mpData && (mpData.paymentLink || mpData.subscriptionLink)) {
            const { dogName } = merged;
            const { portions, price1month, price3months, price6months, paymentLink, subscriptionLink } = mpData;
            const fmt = n => n.toLocaleString('es-CL');

            messageText = `aqui van los links de pago para ${dogName} 🐾\n\n`;
            messageText += `plan 1 mes: $${fmt(price1month)}/mes (${portions} envases)\n`;
            if (paymentLink) messageText += `→ pago unico: ${paymentLink}\n`;
            messageText += `\nplan 3 meses: $${fmt(price3months)}/mes (5% dto)\n`;
            messageText += `plan 6 meses: $${fmt(price6months)}/mes (10% dto)\n`;
            if (subscriptionLink) messageText += `→ suscripcion mensual: ${subscriptionLink}\n`;
            messageText += `\ncualquier duda me avisas!`;
          } else {
            // Fallback al formulario pre-cargado
            const url = buildPrefillUrl(merged);
            messageText = `aqui va 👉 ${url}\n\nya esta pre-cargado con los datos de ${merged.dogName}, solo confirmas y listo 🐾\n\ncualquier duda me avisas!`;
            logger.log(`[mp] usando fallback form URL para ${phone}`);
          }

          await meta.sendMessage(phone, messageText, config);
          await memory.updateContext(phone, { prefillUrlSent: true, last_bot_intent: 'link_sent', last_bot_intent_ts: Date.now() });
          logger.log(`[sheets] Link enviado a ${phone} para ${merged.dogName}`);
        } else if (!context.prefillUrlSent) {
          // Aún capturando datos
          await memory.updateContext(phone, { last_bot_intent: 'capturing_data', last_bot_intent_ts: Date.now() });
        }
      }
    }
  } catch (err) {
    // No crítico — no bloquear el flujo
    logger.log(`[sheets] afterReply error: ${err.message}`);
  }
}

/**
 * enrichContext — Carga datos del cliente desde Sheets al primer mensaje.
 * El core lo llama una vez y guarda el resultado en Redis (tenantEnriched=true).
 */
async function enrichContext(phone, savedContext) {
  try {
    const logger = require('../../core/logger');
    let data = null;
    let source = null;

    // 1. Fresh Subscribers (cliente activo Fresh — máxima prioridad)
    data = await sheets.getCustomer(phone);
    if (data) { source = 'fresh_subscriber'; }

    // 2. Fresh Leads (prospecto Fresh)
    if (!data) {
      data = await sheets.getLead(phone);
      if (data) { source = 'fresh_lead'; }
    }

    // 3. TupiBox Original (cliente histórico de cajas)
    if (!data) {
      data = await sheets.getOriginalCustomer(phone);
      if (data) { source = 'tupibox_original'; }
    }

    if (!data) return {};

    logger.log(`[sheets] enrichContext: cliente encontrado en ${source}`);

    // Mapear campos al contexto Redis
    const ctx = { dataSource: source };
    if (data.name)          ctx.customerName   = data.name;
    if (data.dogName)       ctx.dogName        = data.dogName;
    if (data.weight)        ctx.weight         = data.weight;
    if (data.breed)         ctx.breed          = data.breed;
    if (data.ageYears)      ctx.ageYears       = data.ageYears;
    if (data.ageMonths)     ctx.ageMonths      = data.ageMonths;
    if (data.activityLevel) ctx.activityLevel  = data.activityLevel;
    if (data.allergies)     ctx.allergies      = data.allergies;
    if (data.protein)       ctx.protein        = data.protein;
    if (data.plan)          ctx.plan           = data.plan;
    if (data.status)        ctx.status         = data.status;
    if (data.city)          ctx.city           = data.city;
    if (data.email)         ctx.email          = data.email;
    // Cliente Original: indicar que es recurrente y cuántos pedidos tiene
    if (source === 'tupibox_original') {
      ctx.isReturningCustomer = true;
      ctx.totalOrders = data.totalOrders;
    }

    return ctx;
  } catch (e) {
    const logger = require('../../core/logger');
    logger.log(`[sheets] enrichContext error: ${e.message}`);
    return {};
  }
}

function hasRequiredFields(ctx) {
  return !!(ctx.dogName && ctx.weight && (ctx.ageYears || ctx.ageMonths || ctx.ageInMonths || ctx.birthDate) && ctx.activityLevel);
}

module.exports = { quickReply, buildSystemPrompt, afterReply, enrichContext };
