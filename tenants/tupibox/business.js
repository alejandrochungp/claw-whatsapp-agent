/**
 * tenants/tupibox/business.js
 *
 * Lógica de negocio TupiBox Fresh.
 * Mantiene paridad con el bot actual (server.js del repo viejo).
 */

const fs   = require('fs');
const path = require('path');

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

  // ── Saludo ───────────────────────────────────────────────────────────────
  if (/^(hola|hi|buenas|buenos días|buenas tardes|buenas noches|saludos)$/.test(text)) {
    if (!isNew) {
      return { text: 'Hola de nuevo!\n\nen qué te puedo ayudar hoy?', useAI: false };
    }
    return {
      text: 'Hola! qué gusto que nos escribas.\n\nte puedo ayudar con info sobre planes, hacer un pedido nuevo, consultar uno existente o conectarte con el equipo.\n\nqué necesitas?',
      useAI: false
    };
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

module.exports = { quickReply, buildSystemPrompt };
