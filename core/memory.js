/**
 * core/memory.js — Memoria de conversaciones con Redis persistente
 *
 * Si REDIS_URL está disponible → usa Redis (datos sobreviven reinicios)
 * Si no → fallback a RAM (comportamiento anterior)
 */

const MAX_HISTORY = 20;
const TTL_SECS    = 7 * 24 * 60 * 60; // 7 días en Redis (era 24h — aumentado para asesorías multiparte)
const TTL_MS      = 30 * 60 * 1000;   // 30 min en RAM (fallback)

// ─── Intento de conexión a Redis ────────────────────────────────────────────
let redisClient = null;
let useRedis    = false;

async function initRedis() {
  const url = process.env.REDIS_URL;
  if (!url) {
    console.log('[memory] REDIS_URL no configurado, usando memoria RAM');
    return;
  }
  try {
    const { createClient } = require('redis');
    redisClient = createClient({ url });
    redisClient.on('error', (err) => console.error('[memory] Redis error:', err));
    await redisClient.connect();
    useRedis = true;
    console.log('[memory] Redis conectado ✅');
  } catch (err) {
    console.error('[memory] No se pudo conectar a Redis, usando RAM:', err.message);
    redisClient = null;
    useRedis = false;
  }
}

// Inicializar al cargar el módulo
initRedis().catch(() => {});

// ─── Helpers Redis ───────────────────────────────────────────────────────────
const TENANT_PREFIX = process.env.TENANT ? `${process.env.TENANT}:` : '';
const key = (phone) => `${TENANT_PREFIX}conv:${phone}`;

async function redisGet(phone) {
  try {
    const raw = await redisClient.get(key(phone));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function redisSet(phone, data) {
  try {
    await redisClient.setEx(key(phone), TTL_SECS, JSON.stringify(data));
  } catch { /* silencioso */ }
}

// ─── Fallback RAM ────────────────────────────────────────────────────────────
const ramStore = new Map();

function ramGetOrCreate(phone) {
  if (!ramStore.has(phone)) {
    ramStore.set(phone, { history: [], context: {}, updatedAt: Date.now() });
  }
  const conv = ramStore.get(phone);
  conv.updatedAt = Date.now();
  return conv;
}

setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [phone, conv] of ramStore) {
    if (conv.updatedAt < cutoff) ramStore.delete(phone);
  }
}, 10 * 60 * 1000);

// ─── API pública ─────────────────────────────────────────────────────────────

async function addMessage(phone, text, role) {
  if (useRedis) {
    const conv = (await redisGet(phone)) || { history: [], context: {} };
    conv.history.push({ role, text, ts: Date.now() });
    if (conv.history.length > MAX_HISTORY) conv.history.shift();
    await redisSet(phone, conv);
  } else {
    const conv = ramGetOrCreate(phone);
    conv.history.push({ role, text, ts: Date.now() });
    if (conv.history.length > MAX_HISTORY) conv.history.shift();
  }
}

async function getHistory(phone, limit = 10) {
  if (useRedis) {
    const conv = await redisGet(phone);
    if (!conv) return [];
    return conv.history.slice(-limit);
  } else {
    const conv = ramStore.get(phone);
    if (!conv) return [];
    return conv.history.slice(-limit);
  }
}

async function getContext(phone) {
  if (useRedis) {
    const conv = await redisGet(phone);
    return conv?.context || {};
  } else {
    return ramStore.get(phone)?.context || {};
  }
}

async function updateContext(phone, data) {
  if (useRedis) {
    const conv = (await redisGet(phone)) || { history: [], context: {} };
    conv.context = { ...conv.context, ...data };
    await redisSet(phone, conv);
  } else {
    const conv = ramGetOrCreate(phone);
    conv.context = { ...conv.context, ...data };
  }
}

async function isReturning(phone) {
  if (useRedis) {
    const conv = await redisGet(phone);
    return conv && conv.history.length > 1;
  } else {
    const conv = ramStore.get(phone);
    return conv && conv.history.length > 1;
  }
}

// ─── Contexto de campaña ─────────────────────────────────────────────────────
// TTL más largo para campañas (7 días) — el cliente puede responder días después
const CAMPAIGN_TTL_SECS = 7 * 24 * 60 * 60;
const campaignKey = (phone) => `campaign:${phone}`;

/**
 * Guarda el contexto de campaña para un teléfono.
 * @param {string} phone
 * @param {object} data  — { name, description, sentAt, ... }
 */
async function setCampaignContext(phone, data) {
  const payload = { ...data, sentAt: data.sentAt || Date.now() };
  if (useRedis) {
    try {
      await redisClient.setEx(campaignKey(phone), CAMPAIGN_TTL_SECS, JSON.stringify(payload));
    } catch (e) { console.error('[memory] setCampaignContext error:', e.message); }
  } else {
    // Fallback RAM: guardar en context del contacto
    const conv = ramGetOrCreate(phone);
    conv.context = { ...conv.context, campaignContext: payload };
  }
}

/**
 * Lee el contexto de campaña para un teléfono.
 * Devuelve null si no existe.
 */
async function getCampaignContext(phone) {
  if (useRedis) {
    try {
      const raw = await redisClient.get(campaignKey(phone));
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  } else {
    return ramStore.get(phone)?.context?.campaignContext || null;
  }
}

// ─── Upsell pendiente — clave separada para evitar race conditions ────────────
// TTL 30 min: si el cliente no responde en 30 min, se cancela
const UPSELL_TTL_SECS = 4 * 60 * 60; // 4 horas (el despacho puede demorar)
const upsellKey = (phone) => `upsell:${phone}`;

async function setUpsellPending(phone, data) {
  const payload = { ...data, setAt: Date.now() };
  if (useRedis) {
    try {
      await redisClient.setEx(upsellKey(phone), UPSELL_TTL_SECS, JSON.stringify(payload));
    } catch (e) { console.error('[memory] setUpsellPending error:', e.message); }
  } else {
    const conv = ramGetOrCreate(phone);
    conv.context = { ...conv.context, _upsell: payload };
  }
}

async function getUpsellPending(phone) {
  if (useRedis) {
    try {
      const raw = await redisClient.get(upsellKey(phone));
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  } else {
    return ramStore.get(phone)?.context?._upsell || null;
  }
}

async function clearUpsellPending(phone) {
  if (useRedis) {
    try { await redisClient.del(upsellKey(phone)); } catch {}
  } else {
    const conv = ramStore.get(phone);
    if (conv) delete conv.context._upsell;
  }
}

// Esperar a que Redis conecte, con timeout
function waitForRedis(timeoutMs = 5000) {
  if (useRedis) return Promise.resolve(); // ya conectado
  return new Promise(resolve => {
    const start = Date.now();
    const check = setInterval(() => {
      if (useRedis || Date.now() - start > timeoutMs) {
        clearInterval(check);
        if (!useRedis) console.log('[memory] Redis no disponible tras espera, arrancando con RAM');
        resolve();
      }
    }, 100);
  });
}

// ─── Contador de repetición de preguntas ─────────────────────────────────────
// Detecta cuando el bot pregunta lo mismo N veces sin avance útil del cliente
// Almacenado en el contexto del usuario bajo _repeatCount

async function incrementRepeatCount(phone) {
  const ctx = await getContext(phone);
  const count = (ctx._repeatCount || 0) + 1;
  await updateContext(phone, { _repeatCount: count });
  return count;
}

async function resetRepeatCount(phone) {
  await updateContext(phone, { _repeatCount: 0 });
}

async function getRepeatCount(phone) {
  const ctx = await getContext(phone);
  return ctx._repeatCount || 0;
}

// ─── Contador de mensajes no productivos (spam/bots) ─────────────────────────
async function incrementNonProductiveCount(phone) {
  const ctx = await getContext(phone);
  const count = (ctx._nonProductiveCount || 0) + 1;
  await updateContext(phone, { _nonProductiveCount: count });
  return count;
}

async function resetNonProductiveCount(phone) {
  await updateContext(phone, { _nonProductiveCount: 0 });
}

async function getNonProductiveCount(phone) {
  const ctx = await getContext(phone);
  return ctx._nonProductiveCount || 0;
}

module.exports = {
  addMessage, getHistory, getContext, updateContext, isReturning,
  setCampaignContext, getCampaignContext,
  setUpsellPending, getUpsellPending, clearUpsellPending,
  waitForRedis,
  incrementRepeatCount, resetRepeatCount, getRepeatCount,
  incrementNonProductiveCount, resetNonProductiveCount, getNonProductiveCount,
  get redis() { return redisClient; }
};
