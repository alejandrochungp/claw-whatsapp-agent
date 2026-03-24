/**
 * core/memory.js — Memoria de conversaciones (en proceso)
 *
 * Guarda historial y contexto por número de teléfono.
 * Simple y sin dependencias externas.
 */

const conversations = new Map(); // phone → { history: [], context: {}, updatedAt }
const MAX_HISTORY   = 20;
const TTL_MS        = 30 * 60 * 1000; // 30 minutos

function getOrCreate(phone) {
  if (!conversations.has(phone)) {
    conversations.set(phone, { history: [], context: {}, updatedAt: Date.now() });
  }
  const conv = conversations.get(phone);
  conv.updatedAt = Date.now();
  return conv;
}

function addMessage(phone, text, role) {
  const conv = getOrCreate(phone);
  conv.history.push({ role, text, ts: Date.now() });
  if (conv.history.length > MAX_HISTORY) conv.history.shift();
}

function getHistory(phone, limit = 10) {
  const conv = conversations.get(phone);
  if (!conv) return [];
  return conv.history.slice(-limit);
}

function getContext(phone) {
  return conversations.get(phone)?.context || {};
}

function updateContext(phone, data) {
  const conv = getOrCreate(phone);
  conv.context = { ...conv.context, ...data };
}

function isReturning(phone) {
  const conv = conversations.get(phone);
  return conv && conv.history.length > 1;
}

// Limpiar conversaciones antiguas cada 10 min
setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [phone, conv] of conversations) {
    if (conv.updatedAt < cutoff) conversations.delete(phone);
  }
}, 10 * 60 * 1000);

module.exports = { addMessage, getHistory, getContext, updateContext, isReturning };
