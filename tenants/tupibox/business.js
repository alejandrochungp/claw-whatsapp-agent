/**
 * tenants/tupibox/business.js
 *
 * Lógica de negocio TupiBox Fresh.
 * Mantiene paridad con el bot actual (server.js del repo viejo).
 */

const fs         = require('fs');
const path       = require('path');
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

    if (context.name)          prompt += `- Cliente: ${context.name}\n`;
    if (context.dogName)       prompt += `- Perro: ${context.dogName}\n`;
    if (context.weight)        prompt += `- Peso: ${context.weight}kg\n`;
    if (context.ageYears)      prompt += `- Edad: ${context.ageYears} años\n`;
    if (context.activityLevel) prompt += `- Actividad: ${context.activityLevel}\n`;
    if (context.allergies)     prompt += `- Alergias: ${context.allergies}\n`;
    if (context.protein)       prompt += `- Proteína preferida: ${context.protein}\n`;
    if (context.orderNumber)   prompt += `- Pedido en seguimiento: #${context.orderNumber}\n`;

    // Si tenemos los 6 datos, agregar el link pre-cargado
    if (context.dogName && context.weight && (context.ageYears || context.ageMonths) && context.activityLevel) {
      const prefillUrl = buildPrefillUrl(context);
      prompt += `\n👉 Link formulario pre-cargado: ${prefillUrl}\n`;
      prompt += `Usa este link cuando el cliente quiera hacer el pedido (solo después de capturar todos los datos).`;
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

    // 2. Extracción inteligente si hay suficiente conversación
    if (history.length >= 4) {
      const extracted = await extraction.extractFromConversation(history);
      if (Object.keys(extracted).length > 0) {
        const mapped = extraction.mapToSheetFormat ? extraction.mapToSheetFormat(extracted) : extracted;
        await sheets.updateLead(phone, mapped);
      }
    }
  } catch (err) {
    // No crítico — no bloquear el flujo
    const logger = require('../../core/logger');
    logger.log(`[sheets] afterReply error: ${err.message}`);
  }
}

/**
 * enrichContext — Carga datos del cliente desde Sheets al primer mensaje.
 * El core lo llama una vez y guarda el resultado en Redis (tenantEnriched=true).
 */
async function enrichContext(phone, savedContext) {
  try {
    // Buscar en Subscribers primero, luego en Leads
    let data = await sheets.getCustomer(phone);
    if (!data) data = await sheets.getLead(phone);
    if (!data) return {};

    // Mapear campos de Sheets al contexto Redis
    const ctx = {};
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

    return ctx;
  } catch (e) {
    const logger = require('../../core/logger');
    logger.log(`[sheets] enrichContext error: ${e.message}`);
    return {};
  }
}

module.exports = { quickReply, buildSystemPrompt, afterReply, enrichContext };
