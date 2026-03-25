/**
 * tenants/yeppo/business.js
 *
 * Lógica de negocio de Yeppo.
 *
 * Dos funciones obligatorias que el core espera:
 *   quickReply(userText, context, history) → { text, notifySlack, useAI } | null
 *   buildSystemPrompt(context)             → string
 */

const fs     = require('fs');
const path   = require('path');
const upsell = require('../../core/upsell');

// Cargar prompt base + base de conocimiento
const PROMPT_BASE = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8');
const KNOWLEDGE_DOC_PATH = path.join(__dirname, 'knowledge', 'knowledge_doc.md');
const KNOWLEDGE_DOC = fs.existsSync(KNOWLEDGE_DOC_PATH)
  ? fs.readFileSync(KNOWLEDGE_DOC_PATH, 'utf8')
  : '';

/**
 * Reglas rápidas sin LLM.
 * Devuelve null si no aplica ninguna → core usará IA.
 */
async function quickReply(userText, context, history) {
  const text  = userText.toLowerCase().trim();
  const isNew = history.length <= 1;

  // ── Saludo ───────────────────────────────────────────────────────────────
  if (/^(hola|hi|buenas|buenos días|buenas tardes|buenas noches|saludos)$/.test(text)) {
    if (!isNew) {
      return { text: 'Hola de nuevo! en qué te puedo ayudar?' };
    }
    return {
      text: 'Hola! Bienvenido a Yeppo 👋\n\nEn qué te puedo ayudar?',
      useAI: false
    };
  }

  // ── Respuesta a upsell pendiente ─────────────────────────────────────────
  const memory = require('../../core/memory');
  const upsellPending = await memory.getUpsellPending(context._phone);
  if (upsellPending) {
    const acepta  = /\b(sí|si|dale|ok|quiero|me interesa|agrega|perfecto|claro|bueno|ya|yes)\b/.test(text);
    const rechaza = /\b(no|nop|paso|no gracias|no me interesa|no quiero)\b/.test(text);

    if (acepta) {
      const orderMock = { id: upsellPending.orderId, name: upsellPending.orderName, total_price: '0', customer: {} };
      const matchMock = {
        item: { title: upsellPending.match?.producto },
        par:  { complemento: upsellPending.match?.complemento, razon: '', variantId: upsellPending.match?.variantId },
        precioComplemento: upsellPending.match?.precio || 0
      };
      upsell.handleUpsellAccepted(context._phone, orderMock, matchMock, context._config).catch(() => {});
      return { text: null, useAI: false, skipReply: true };
    }

    if (rechaza) {
      await memory.clearUpsellPending(context._phone);
      return { text: 'sin problema! si en algún momento lo necesitas, avisame 😊' };
    }
    // Si no es clara la respuesta → dejar que la IA maneje con contexto de upsell
  }

  // ── Pedir humano ─────────────────────────────────────────────────────────
  if (/humano|persona|equipo|hablar con alguien|asesor/.test(text)) {
    return {
      text: 'Claro, te conecto con el equipo. En unos minutos te responden por acá.',
      notifySlack: true
    };
  }

  // ── Horario ──────────────────────────────────────────────────────────────
  if (/horario|cuando abren|hora|atienden/.test(text)) {
    return {
      text: 'Atendemos lunes a viernes de 10:00 a 18:00 (Santiago).\n\nSi es fuera de horario, igual déjanos tu mensaje y te respondemos en cuanto abramos.'
    };
  }

  // ── Ubicación ────────────────────────────────────────────────────────────
  if (/donde están|dirección|ubicación|local|tienda|patronato/.test(text)) {
    return {
      text: 'Estamos en el barrio Patronato, Santiago.\n\nSi necesitas la dirección exacta o cómo llegar, escríbenos y te ayudamos!'
    };
  }

  // ── Todo lo demás → IA ───────────────────────────────────────────────────
  return null;
}

/**
 * Construir system prompt para Claude.
 * Puede enriquecer con datos del contexto (nombre del cliente, historial, etc.)
 */
function buildSystemPrompt(context) {
  let prompt = PROMPT_BASE;

  // Agregar base de conocimiento si está disponible
  if (KNOWLEDGE_DOC) {
    prompt += `\n\n---\n\n${KNOWLEDGE_DOC}`;
  }

  // Personalizar con datos del cliente si los tenemos
  if (context && Object.keys(context).length > 0) {
    prompt += '\n\n---\n\n## Contexto del cliente actual\n';
    if (context.name)        prompt += `Nombre: ${context.name}\n`;
    if (context.orderNumber) prompt += `Pedido en seguimiento: #${context.orderNumber}\n`;
  }

  return prompt;
}

module.exports = { quickReply, buildSystemPrompt };
