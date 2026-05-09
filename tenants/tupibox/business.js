/**
 * tenants/tupibox/business.js
 *
 * Lógica de negocio TupiBox Fresh.
 * v2.0 — Links MercadoPago directos, detección clientes recurrentes,
 *        skip inteligente de preferencias, follow-up por etapa.
 */

const fs         = require('fs');
const path       = require('path');
const axios      = require('axios');
const sheets     = require('./sheets');
const extraction = require('./extraction');

const PROMPT_BASE = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8');

// URL base del formulario (fallback si MP falla)
const FORM_URL = process.env.FORM_URL || 'https://go.tupibox.com';

// MercadoPago SDK — acceso directo a preferencias de checkout
const { MercadoPagoConfig, Preference } = require('mercadopago');
const MP_ACCESS_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN || '';
const mpClient = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
const preferenceClient = new Preference(mpClient);

/**
 * Reglas rápidas sin LLM — solo cosas 100% deterministas.
 * Retorna null si no aplica → core usará IA.
 */
async function quickReply(userText, context, history) {
  const text  = userText.toLowerCase().trim();
  const hasDogData = context && (context.dogName || context.weight);

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

  // ── Cliente con datos previos: detectar intención de "continuar" ─────────
  // Estos keywords SOLO aplican si hay datos de perro en Redis
  if (hasDogData && /^(si|dale|ok|continuar|continuemos|sigamos|listo|vamos|dale!)$/i.test(text.replace(/\W/g, '').trim())) {
    // Dejar que la IA maneje con contexto completo — más natural
    return null;
  }

  // ── Respuestas de desinterés en paso de alergias/proteína ─────────────────
  if (/^(no s[eé]|da lo mismo|cualquiera|lo que sea|ninguna|ninguno|no tiene|sin preferencia|sin alergia)/i.test(text)) {
    // Si estamos en etapa de captura, la IA decidirá si saltar
    return null;
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
    if (context.ageInMonths)    prompt += `- Edad: ${context.ageInMonths} meses\n`;
    if (context.activityLevel)  prompt += `- Actividad: ${context.activityLevel}\n`;
    if (context.allergies)      prompt += `- Alergias: ${context.allergies}\n`;
    if (context.protein)        prompt += `- Proteína preferida: ${context.protein}\n`;
    if (context.proteinPreference) prompt += `- Proteína preferida: ${context.proteinPreference}\n`;
    if (context.plan)           prompt += `- Plan actual/interesado: ${context.plan}\n`;
    if (context.city)           prompt += `- Ciudad: ${context.city}\n`;
    if (context.orderNumber)    prompt += `- Pedido en seguimiento: #${context.orderNumber}\n`;

    // 🔄 Cliente que vuelve con datos previos
    if (context.dogName && context.weight) {
      prompt += `\n🔄 CLIENTE QUE VUELVE: este cliente ya tiene datos (${context.dogName}, ${context.weight}kg)${context.activityLevel ? ', ' + context.activityLevel : ''}. NO preguntes "qué necesitas", "conoces nuestros productos" ni "Fresh o cajas". Saluda con: "hola de nuevo! seguimos con ${context.dogName}?" o "qué bueno verte de vuelta! continuamos con ${context.dogName}?"\n`;
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

    // Etapa del proceso (para follow-up inteligente)
    if (context.lastBotIntent) {
      const intent = context.lastBotIntent;
      prompt += `\n📍 ETAPA: ${intent.stage} (${intent.ts ? new Date(intent.ts).toLocaleString('es-CL', {timeZone:'America/Santiago'}) : 'desconocido'})\n`;
      if (intent.stage === 'link_sent') {
        prompt += 'El cliente recibió link de pago pero no ha comprado. Recuérdale que puede pagar ahora.\n';
      } else if (intent.stage === 'capturing_data') {
        prompt += 'Estábamos en proceso de capturar datos del perro. Retoma donde quedaste.\n';
      }
    }

    // Datos completos: instrucción de enviar link MP
    if (hasRequiredFields(context) && !context.mpLinkSent) {
      prompt += `\n⚠️ Datos completos: ya tienes nombre, peso, edad y actividad.\n`;
      prompt += `Dile al cliente: "ya tengo todo! te mando los links de pago ahora" — el sistema envía los links de MercadoPago automático.\n`;
    }
  }

  return prompt;
}

/**
 * Calcular porciones mensuales usando la fórmula veterinaria RER.
 * Misma fórmula que StepSix.vue del frontend.
 */
function calculatePortions(weight, ageInMonths, activityLevel) {
  const w = parseFloat(weight) || 10;
  const age = parseInt(ageInMonths) || 24;
  const activity = activityLevel || 'Medio';

  // RER = 70 × weight^0.75
  const rer = Math.round(70 * Math.pow(w, 0.75));

  // DER multiplier
  let activityMult = 1.4;
  if (activity === 'Bajo') activityMult = 1.2;
  if (activity === 'Alto') activityMult = 1.6;

  let ageMult = 1.0;
  if (age < 4) ageMult = 3.0;
  else if (age < 12) ageMult = 2.0;
  else if (age < 24) ageMult = 1.2;
  else if (age >= 84) ageMult = 0.8;

  const der = activityMult * ageMult;

  // Daily calories = RER × DER
  const dailyCalories = Math.round(rer * der);

  // Daily grams = (dailyCalories / 122) × 100
  const dailyGrams = Math.round((dailyCalories / 122) * 100);

  // Monthly grams = dailyGrams × 30
  const monthlyGrams = dailyGrams * 30;

  // Portions = ceil(monthlyGrams / 500)
  const portions = Math.ceil(monthlyGrams / 500);

  return portions;
}

/**
 * Calcular precios para 1, 3 y 6 meses.
 * Fórmula idéntica a StepSix.vue.
 */
function calculatePricing(portions, deliveryFrequency) {
  const pricePerUnit = 5490; // $5.490 por envase de 500g
  const deliveryCharge = deliveryFrequency === '2x' ? 2990 : 0;

  // Redondear hacia arriba terminando en 90
  const roundTo90 = (price) => {
    const hundreds = Math.ceil(price / 100);
    return (hundreds * 100) - 10;
  };

  const base1Month = (pricePerUnit * portions) + deliveryCharge;
  const base3Months = (Math.round(pricePerUnit * 0.95) * portions) + deliveryCharge;
  const base6Months = (Math.round(pricePerUnit * 0.90) * portions) + deliveryCharge;

  return {
    portions,
    pricePerUnit,
    oneMonth: roundTo90(base1Month),
    threeMonths: roundTo90(base3Months),
    sixMonths: roundTo90(base6Months),
    oneMonthPerUnit: Math.round(roundTo90(base1Month) / portions),
    threeMonthsPerUnit: Math.round(roundTo90(base3Months) / portions),
    sixMonthsPerUnit: Math.round(roundTo90(base6Months) / portions),
  };
}

/**
 * Crear preferencias de checkout MercadoPago directamente con el SDK.
 * Una para pago único (1 mes) y otra con auto_recurring (suscripción mensual).
 */
async function createMercadoPagoLinks(dogName, pricing, email) {
  const logger = require('../../core/logger');

  const description = `TupiBox Fresh - ${dogName} (${pricing.portions} envases/mes)`;
  const payerEmail = email || 'cliente@tupibox.com';
  const extRef = `tupibox_fresh_${dogName.replace(/\s/g, '_')}_${Date.now()}`;
  const baseUrl = 'https://go.tupibox.com';

  const results = { oneTimeUrl: null, subscriptionUrl: null, error: null };

  // Preferencia de pago único (1 mes)
  try {
    const oneTimePref = await preferenceClient.create({
      body: {
        items: [{
          id: `fresh_${pricing.portions}_1m`,
          title: `${description} - 1 mes`,
          quantity: 1,
          unit_price: pricing.oneMonth,
          currency_id: 'CLP'
        }],
        payer: { email: payerEmail },
        statement_descriptor: 'TUPIBOX FRESH',
        external_reference: `${extRef}_1m`,
        back_urls: { success: `${baseUrl}/success`, pending: `${baseUrl}/pending`, failure: `${baseUrl}/failure` },
        auto_return: 'approved',
        payment_methods: { installments: 12, default_installments: 1 },
        notification_url: 'https://tupibox-mercadopago-1b381874968c.herokuapp.com/webhook'
      }
    });
    results.oneTimeUrl = oneTimePref.init_point;
    logger.log(`[mp] Pago único: ${oneTimePref.init_point.slice(0, 60)}...`);
  } catch (e) {
    logger.log(`[mp] Error pago único: ${e.message}`);
  }

  // Preferencia con auto_recurring (suscripción mensual)
  try {
    const subPref = await preferenceClient.create({
      body: {
        items: [{
          id: `fresh_${pricing.portions}_sub`,
          title: `${description} - Suscripción mensual`,
          quantity: 1,
          unit_price: pricing.oneMonth,
          currency_id: 'CLP'
        }],
        payer: { email: payerEmail },
        statement_descriptor: 'TUPIBOX FRESH',
        external_reference: `${extRef}_sub`,
        back_urls: { success: `${baseUrl}/success`, pending: `${baseUrl}/pending`, failure: `${baseUrl}/failure` },
        auto_return: 'approved',
        payment_methods: { installments: 12, default_installments: 1 },
        auto_recurring: {
          frequency: 1,
          frequency_type: 'months',
          transaction_amount: pricing.oneMonth,
          currency_id: 'CLP'
        },
        notification_url: 'https://tupibox-mercadopago-1b381874968c.herokuapp.com/webhook'
      }
    });
    results.subscriptionUrl = subPref.init_point;
    logger.log(`[mp] Suscripción: ${subPref.init_point.slice(0, 60)}...`);
  } catch (e) {
    logger.log(`[mp] Error suscripción: ${e.message}`);
  }

  if (!results.oneTimeUrl && !results.subscriptionUrl) {
    results.error = 'No se pudieron crear links de MercadoPago';
  }

  return results;
}

/**
 * Hook post-respuesta: guardar lead, extraer datos, enviar link MP.
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
    }

    // Trackear etapa del proceso para follow-up inteligente
    await memory.updateContext(phone, {
      lastBotIntent: { stage: 'initial_contact', ts: Date.now() }
    });

    // 2. Extracción inteligente si hay suficiente conversación
    const extracted = history.length >= 4
      ? await extraction.extractFromConversation(history)
      : {};

    let mapped = {};
    if (Object.keys(extracted).length > 0) {
      mapped = extraction.mapToSheetFormat ? extraction.mapToSheetFormat(extracted) : extracted;
      await sheets.updateLead(phone, mapped);
      await memory.updateContext(phone, mapped);
      logger.log(`[sheets] Contexto actualizado con ${Object.keys(mapped).length} campos`);
    }

    // 3. Enviar link MP si datos completos (desde enrichContext o extracción)
    const merged = { ...context, ...mapped };
    if (!context.mpLinkSent && hasRequiredFields(merged)) {
      await sendMercadoPagoLinks(phone, merged, memory, logger);
    } else if (history.length >= 2 && Object.keys(merged).length > 2 && !hasRequiredFields(merged)) {
      // Estamos en proceso de captura
      await memory.updateContext(phone, {
        lastBotIntent: { stage: 'capturing_data', ts: Date.now() }
      });
    }
  } catch (err) {
    logger.log(`[sheets] afterReply error: ${err.message}`);
  }
}

/**
 * Enviar links de MercadoPago al cliente por WhatsApp.
 * Si falla, fallback al form prefill URL.
 */
async function sendMercadoPagoLinks(phone, ctx, memory, logger) {
  const config = require('./config');

  // Calcular edad en meses
  let ageInMonths = 24;
  if (ctx.ageInMonths) {
    ageInMonths = parseInt(ctx.ageInMonths);
  } else if (ctx.ageMonths) {
    ageInMonths = parseInt(ctx.ageMonths);
  } else if (ctx.ageYears) {
    ageInMonths = Math.round(parseFloat(ctx.ageYears) * 12);
  }

  // Calcular porciones y precios
  const portions = calculatePortions(ctx.weight, ageInMonths, ctx.activityLevel);
  const pricing = calculatePricing(portions);

  // Intentar crear links MP
  const mpLinks = await createMercadoPagoLinks(ctx.dogName, pricing, ctx.email);

  if (mpLinks.error || (!mpLinks.oneTimeUrl && !mpLinks.subscriptionUrl)) {
    // Fallback: link al formulario
    logger.log(`[mp] Fallback a form URL para ${phone}`);
    const fallbackUrl = buildPrefillUrl(ctx);
    const meta = require('../../core/meta');
    await meta.sendMessage(phone,
      `listo! aquí va el link para ${ctx.dogName} 🐾\n\n${fallbackUrl}\n\nestá pre-cargado con sus datos. cualquier duda me avisas!`,
      config
    );
    await memory.updateContext(phone, {
      mpLinkSent: true,
      mpLinksCreated: false,
      lastBotIntent: { stage: 'link_sent', ts: Date.now() },
      pricing: pricing
    });
    return;
  }

  // Construir mensaje con links MP
  const meta = require('../../core/meta');
  let msg = `listo! aquí tienes los links de pago para ${ctx.dogName} 🐾\n\n`;

  msg += `📊 ${portions} envases/mes (~${Math.round(portions * 500 / 1000)}kg)\n\n`;

  msg += `💳 *Pago único — 1 mes:* $${pricing.oneMonth.toLocaleString('es-CL')}\n`;
  if (mpLinks.oneTimeUrl) {
    msg += `${mpLinks.oneTimeUrl}\n\n`;
  }

  msg += `🔄 *Suscripción mensual:* $${pricing.oneMonth.toLocaleString('es-CL')}/mes\n`;
  if (mpLinks.subscriptionUrl) {
    msg += `${mpLinks.subscriptionUrl}\n\n`;
  }

  msg += `📦 *Plan 3 meses:* $${pricing.threeMonths.toLocaleString('es-CL')}/mes (${pricing.threeMonthsPerUnit.toLocaleString('es-CL')}/envase)\n`;
  msg += `📦 *Plan 6 meses:* $${pricing.sixMonths.toLocaleString('es-CL')}/mes (${pricing.sixMonthsPerUnit.toLocaleString('es-CL')}/envase)\n\n`;

  msg += `o si prefieres hablamos por acá y armamos el plan a tu medida 😊`;

  await meta.sendMessage(phone, msg, config);
  await memory.updateContext(phone, {
    mpLinkSent: true,
    mpLinksCreated: true,
    lastBotIntent: { stage: 'link_sent', ts: Date.now() },
    pricing: pricing
  });
  logger.log(`[mp] Links MP enviados a ${phone} para ${ctx.dogName}`);
}

/**
 * Construir URL del formulario con parámetros pre-cargados (fallback).
 */
function buildPrefillUrl(ctx) {
  const params = new URLSearchParams();

  if (ctx.dogName)       params.set('petname', ctx.dogName);
  if (ctx.weight)        params.set('weight', ctx.weight);
  if (ctx.sex)           params.set('sex', ctx.sex);
  if (ctx.activityLevel) params.set('activityLevel', ctx.activityLevel);
  if (ctx.allergies && ctx.allergies !== 'Sin alergias') params.set('allergie', ctx.allergies);

  if (ctx.ageMonths) {
    params.set('ageInMonths', ctx.ageMonths);
  } else if (ctx.ageYears) {
    params.set('ageInMonths', Math.round(parseFloat(ctx.ageYears) * 12));
  } else if (ctx.ageInMonths) {
    params.set('ageInMonths', ctx.ageInMonths);
  }

  return `${FORM_URL}?${params.toString()}&product_type=fresh`;
}

/**
 * enrichContext — Carga datos del cliente desde Sheets al primer mensaje.
 */
async function enrichContext(phone, savedContext) {
  try {
    const logger = require('../../core/logger');
    let data = null;
    let source = null;

    // 1. Fresh Subscribers
    data = await sheets.getCustomer(phone);
    if (data) { source = 'fresh_subscriber'; }

    // 2. Fresh Leads
    if (!data) {
      data = await sheets.getLead(phone);
      if (data) { source = 'fresh_lead'; }
    }

    // 3. TupiBox Original
    if (!data) {
      data = await sheets.getOriginalCustomer(phone);
      if (data) { source = 'tupibox_original'; }
    }

    if (!data) return {};

    logger.log(`[sheets] enrichContext: cliente encontrado en ${source}`);

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
    if (data.proteinPreference) ctx.protein    = data.proteinPreference;
    if (data.plan)          ctx.plan           = data.plan;
    if (data.status)        ctx.status         = data.status;
    if (data.city)          ctx.city           = data.city;
    if (data.email)         ctx.email          = data.email;

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

function isBusinessHours() {
  const now       = new Date();
  const chileTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Santiago' }));
  const day  = chileTime.getDay();
  const hour = chileTime.getHours();
  return day >= 1 && day <= 5 && hour >= 10 && hour < 18;
}

module.exports = {
  quickReply, buildSystemPrompt, afterReply, enrichContext,
  calculatePortions, calculatePricing, createMercadoPagoLinks,
  hasRequiredFields, sendMercadoPagoLinks, // exportadas para testing
};
