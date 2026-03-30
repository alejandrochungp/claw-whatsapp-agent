/**
 * tenants/yeppo/business.js
 *
 * Lógica de negocio de Yeppo.
 *
 * Dos funciones obligatorias que el core espera:
 *   quickReply(userText, context, history) → { text, notifySlack, useAI } | null
 *   buildSystemPrompt(context)             → string
 */

const fs       = require('fs');
const path     = require('path');
const upsell   = require('../../core/upsell');
const learning = require('../../core/learning');

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
  const text = userText.toLowerCase().trim();

  // ── Upsell pendiente — lógica de negocio que REQUIERE código, no solo texto ──
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
      if (upsellPending.status === 'accepted') {
        // Cliente rechaza DESPUÉS de haber aceptado (ej: respondió "no" al reminder de 2h)
        // → hay que revertir el pedido en Shopify inmediatamente
        const orderMock = { id: upsellPending.orderId, name: upsellPending.orderName, total_price: '0', customer: {} };
        const matchMock = {
          item: { title: upsellPending.match?.producto },
          par:  { complemento: upsellPending.match?.complemento, razon: '', variantId: upsellPending.match?.variantId },
          precioComplemento: upsellPending.match?.precio || 0
        };
        upsell.revertUpsell(context._phone, orderMock, matchMock, context._config, 'rejected').catch(() => {});
        // revertUpsell ya limpia el pending, manda mensaje al cliente y notifica Slack
        return { text: null, useAI: false, skipReply: true };
      } else {
        // Rechazo inicial (antes de aceptar) → solo limpiar, Claude responde naturalmente
        await memory.clearUpsellPending(context._phone);
        await require('../../core/upsell-stats').trackEvent('rejected', context._phone, {
          complemento: upsellPending.match?.complemento,
          orderName: upsellPending.orderName
        });
        return { text: null, useAI: true };
      }
    }
  }

  // ── Todo lo demás → Claude con contexto completo ─────────────────────────
  return null;
}

/**
 * Construir system prompt para Claude.
 * Puede enriquecer con datos del contexto (nombre del cliente, historial, etc.)
 */
async function buildSystemPrompt(context) {
  let prompt = PROMPT_BASE;

  // Agregar base de conocimiento si está disponible
  if (KNOWLEDGE_DOC) {
    prompt += `\n\n---\n\n${KNOWLEDGE_DOC}`;
  }

  // Agregar FAQs aprendidas dinámicamente (desde Redis)
  const learnedFaqs = await learning.getLearnedFaqsPrompt();
  if (learnedFaqs) {
    prompt += learnedFaqs;
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
