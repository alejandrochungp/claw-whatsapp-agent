/**
 * tenants/yeppo/business.js
 *
 * Lógica de negocio de Yeppo.
 *
 * Dos funciones obligatorias que el core espera:
 *   quickReply(userText, context, history) → { text, notifySlack, useAI } | null
 *   buildSystemPrompt(context)             → string
 */

const fs   = require('fs');
const path = require('path');

// Cargar prompt base desde archivo .md
const PROMPT_BASE = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8');

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

  // Personalizar si tenemos datos del cliente
  if (context?.name) {
    prompt += `\n\n## Cliente actual\nNombre: ${context.name}`;
  }

  if (context?.orderNumber) {
    prompt += `\nPedido en seguimiento: #${context.orderNumber}`;
  }

  return prompt;
}

module.exports = { quickReply, buildSystemPrompt };
