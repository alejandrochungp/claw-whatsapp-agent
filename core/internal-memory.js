/**
 * core/internal-memory.js — Memoria de clienta para consumidores internos.
 *
 * Expone, para el kiosko Sami (sami-api), un resumen de la memoria durable por
 * clienta (core/client-memory.js, clave `${TENANT}:mem:<telefono>`) más un
 * recorte del historial de conversación (core/memory.js, `${TENANT}:conv:<telefono>`).
 *
 * Privacidad (criterio de la memoria): sólo se devuelven el resumen destilado y
 * los temas hablados. Nunca datos de pago, credenciales ni información sensible;
 * todo texto pasa por la misma redacción que usa la memoria (`redactSensitive`).
 * No se exponen claves de upsell, campañas ni correos.
 *
 * El acceso se autoriza con la llave interna compartida `SAMI_INTERNAL_API_KEY`
 * (>= 32 bytes) enviada en el header `X-SAMI-Internal-Key`.
 */

const crypto = require('crypto');
const clientMemory = require('./client-memory');

// `./memory` se carga de forma perezosa: abre Redis y programa un setInterval
// de limpieza que impediría salir a los tests cuando se inyecta el proveedor.
let _memory = null;
function getMemoryModule() {
  if (!_memory) _memory = require('./memory');
  return _memory;
}

// Recorte del historial: pocos turnos recientes y acotados en bytes.
const MAX_HISTORY_ITEMS = 12;
const MAX_HISTORY_CHARS = 1200;
const MAX_ITEM_CHARS = 160;
const MAX_SUMMARY_CHARS = 400;
const MAX_NAME_CHARS = 80;
const MAX_LIST_ITEMS = 12;

// ── Inyección de dependencias (tests) ────────────────────────────────────────
let memoryProvider = null; // { getMemoryDoc, getHistory }

function _setMemoryProvider(provider) { memoryProvider = provider || null; }

function getProvider() {
  if (memoryProvider) return memoryProvider;
  return {
    getMemoryDoc: (phone) => clientMemory.getMemoryDoc(phone),
    getHistory: (phone, limit) => getMemoryModule().getHistory(phone, limit)
  };
}

// ── Autorización ─────────────────────────────────────────────────────────────
/**
 * Compara en tiempo constante la llave recibida con la esperada.
 * Si la llave esperada no está configurada (o es muy corta) se deniega: un
 * servicio sin llave no puede quedar abierto.
 */
function internalKeyValid(provided, expected) {
  if (typeof expected !== 'string') return false;
  if (expected.length < 32) return false;
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch (_e) {
    return false;
  }
}

// ── Sanitización ─────────────────────────────────────────────────────────────
function cleanText(value, maxChars) {
  if (value === null || value === undefined) return '';
  const redacted = clientMemory.redactSensitive(String(value));
  return redacted.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function cleanList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const text = cleanText(item, MAX_ITEM_CHARS);
    if (!text) continue;
    out.push(text);
    if (out.length >= MAX_LIST_ITEMS) break;
  }
  return out;
}

function formatDate(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return d.toISOString().slice(0, 10);
  } catch (_e) {
    return null;
  }
}

/** Documento de memoria -> payload acotado (allowlist de campos). */
function buildMemoryPayload(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const f = doc.fields || {};
  const nombre = cleanText(f.nombre, MAX_NAME_CHARS) || null;
  const payload = {
    nombre,
    preferencias: cleanList(f.preferencias),
    productos: cleanList(f.productos),
    temas_recurrentes: cleanList(f.temasRecurrentes),
    objeciones: cleanList(f.objeciones),
    pendientes: cleanList(f.pendientes),
    resumen: cleanText(doc.resumenBreve, MAX_SUMMARY_CHARS),
    ultima_interaccion: doc.lastInteraction ? formatDate(doc.lastInteraction.at) : null
  };
  return payload;
}

/** Historial crudo -> turnos recientes acotados (rol + texto), sin PII extra. */
function buildHistory(history) {
  if (!Array.isArray(history)) return [];
  const items = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0 && items.length < MAX_HISTORY_ITEMS; i -= 1) {
    const msg = history[i];
    if (!msg || typeof msg !== 'object') continue;
    const rol = msg.role === 'user' ? 'cliente' : (msg.role === 'bot' ? 'bot' : 'operador');
    const texto = cleanText(msg.text, MAX_ITEM_CHARS);
    if (!texto || texto.length < 2) continue;
    if (used + texto.length > MAX_HISTORY_CHARS) break;
    items.unshift({ rol, texto });
    used += texto.length;
  }
  return items;
}

/**
 * Combina memoria durable + historial reciente para una clienta.
 * Devuelve el contrato interno estable. Sin teléfono o sin datos -> found:false.
 */
async function getClientMemory(phone) {
  const empty = { found: false, phone: phone ? String(phone) : null, memoria: null, historial: [] };
  if (!phone || typeof phone !== 'string') return empty;

  const provider = getProvider();
  const [doc, history] = await Promise.all([
    Promise.resolve(provider.getMemoryDoc(phone)).catch(() => null),
    Promise.resolve(provider.getHistory(phone, MAX_HISTORY_ITEMS * 2)).catch(() => [])
  ]);

  const memoria = buildMemoryPayload(doc);
  const historial = buildHistory(history);
  const found = Boolean(memoria || historial.length);
  if (!found) return empty;
  return { found: true, phone: String(phone), memoria: memoria || null, historial };
}

module.exports = {
  internalKeyValid,
  getClientMemory,
  buildMemoryPayload,
  buildHistory,
  cleanText,
  cleanList,
  MAX_HISTORY_ITEMS,
  MAX_HISTORY_CHARS,
  // tests
  _setMemoryProvider
};
