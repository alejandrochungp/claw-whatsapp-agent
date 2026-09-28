/**
 * core/client-memory.js — Memoria durable por cliente (multi-tenant)
 *
 * Problema que resuelve: el historial de conversación (core/memory.js) vive en
 * Redis con TTL de 7 días y, sin Redis, en RAM (30 min). Cuando el TTL expira o
 * el bot se reinicia sin Redis, el bot "olvida" al cliente y vuelve a preguntar
 * lo mismo.
 *
 * Este módulo guarda un DOCUMENTO DE MEMORIA por cliente:
 *   - Redis, clave nueva `${TENANT}:mem:<telefono>` con TTL largo (default 730 días,
 *     configurable con MEM_TTL_DAYS; MEM_NO_TTL=1 lo hace sin expiración).
 *   - Espejo en disco (JSON) bajo MEMORY_DIR (default /data/bot-memory en Railway),
 *     best-effort: si el disco falla, Redis sigue siendo la fuente primaria.
 *
 * El documento se genera al CERRAR la sesión (inactividad, handoff a humano o
 * cierre de flujo): se resume la sesión con el modelo ya integrado (DeepSeek
 * primario, Claude fallback) y se FUSIONA con el documento previo (actualiza
 * campos, nunca sobrescribe ni pierde historial).
 *
 * Al construir el system prompt, el tenant inyecta una sección acotada
 * (~1.8 KB por defecto) con los campos ordenados por prioridad.
 */

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

// ── Configuración ────────────────────────────────────────────────────────────
const TENANT = process.env.TENANT || 'yeppo';

// TTL del documento de memoria en Redis (días). Default 730 (~2 años).
const MEM_TTL_DAYS = parseInt(process.env.MEM_TTL_DAYS || '730', 10);
const MEM_TTL_SECS = MEM_TTL_DAYS * 24 * 3600;
// MEM_NO_TTL=1 → guardar SIN expiración (memoria permanente).
const MEM_NO_TTL   = process.env.MEM_NO_TTL === '1';

// Directorio del espejo en disco. En Railway el volumen (si existe) se monta en /data.
let MEMORY_DIR = process.env.MEMORY_DIR || process.env.DATA_DIR || path.join('/data', 'bot-memory');

// Límite del bloque inyectado en el system prompt (bytes UTF-8).
const PROMPT_MAX_BYTES = parseInt(process.env.MEM_PROMPT_MAX_BYTES || '1800', 10);

// Mínimo de mensajes nuevos (no resumidos aún) para generar resumen al cerrar sesión.
const MIN_MSGS_TO_SUMMARIZE = parseInt(process.env.MEM_MIN_MSGS || '3', 10);

// Máximo de items por campo de lista (se conservan los más recientes).
const MAX_LIST_ITEMS = parseInt(process.env.MEM_MAX_ITEMS || '12', 10);

// Máximo de entradas del log de sesiones resumidas.
const MAX_LOG_ENTRIES = 20;

// Minutos de inactividad para cerrar sesión (default; el tenant puede override).
const DEFAULT_IDLE_MINUTES = parseInt(process.env.MEM_IDLE_MINUTES || '30', 10);

const MEM_VERSION = 1;

// ── Inyección de dependencias (tests) ────────────────────────────────────────
let injectedRedis   = null; // cliente Redis falso/real inyectado
let redisProvider   = null; // función que devuelve el cliente Redis
let llmOverride     = null; // función async (prompt) => texto
let memoryProvider  = null; // { getHistory, getContext } falso/real

function _setRedisClient(client)   { injectedRedis = client || null; }
function _setRedisProvider(fn)     { redisProvider = fn || null; }
function _setLLM(fn)               { llmOverride = fn || null; }
function _setMemoryProvider(p)     { memoryProvider = p || null; }

function _setMemoryDir(dir) {
  MEMORY_DIR = dir;
  diskLoaded = false;
  diskCache = {};
}

function getRedis() {
  if (injectedRedis) return injectedRedis;
  if (redisProvider) {
    try { return redisProvider(); } catch { return null; }
  }
  try {
    const m = require('./memory');
    if (typeof m.getRedisClient === 'function') return m.getRedisClient();
    return m.redis || null;
  } catch { return null; }
}

function getMemoryProvider() {
  if (memoryProvider) return memoryProvider;
  return require('./memory');
}

// ── Claves ───────────────────────────────────────────────────────────────────
function memKey(phone) { return `${TENANT}:mem:${phone}`; }

// ── Espejo en disco (JSON por tenant) ────────────────────────────────────────
let diskCache     = {};   // { [phone]: doc }
let diskLoaded    = false;
let diskWriteChain = Promise.resolve();

function diskFile() { return path.join(MEMORY_DIR, `mem-${TENANT}.json`); }

function loadDisk() {
  if (diskLoaded) return diskCache;
  diskLoaded = true;
  diskCache = {};
  try {
    const f = diskFile();
    if (fs.existsSync(f)) {
      const raw = fs.readFileSync(f, 'utf8');
      diskCache = raw ? JSON.parse(raw) : {};
    }
  } catch (e) {
    console.error('[client-memory] disco ilegible, arrancando vacío:', e.message);
    diskCache = {};
  }
  return diskCache;
}

// Escritura atómica (tmp + rename) serializada para no perder datos por concurrencia.
function persistDisk() {
  const dir = MEMORY_DIR;
  const f = diskFile();
  const data = JSON.stringify(loadDisk());
  diskWriteChain = diskWriteChain.then(() => new Promise((resolve) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, data, 'utf8');
      fs.renameSync(tmp, f);
    } catch (e) {
      // El espejo en disco es best-effort: Redis sigue siendo la fuente primaria.
      console.error('[client-memory] espejo en disco falló:', e.message);
    }
    resolve();
  }));
  return diskWriteChain;
}

// ── Sanitización de datos sensibles ──────────────────────────────────────────
const SENSITIVE = /\b(contrase[nñ]a|password|token|api[_-]?key|secret)\s*[:=]\s*\S+/gi;
const CVV       = /\b(cvv|cvc|c[oó]digo de seguridad)\s*:?\s*\d{3,4}\b/gi;
const CARD      = /\b(?:\d[ -]?){13,19}\b/g; // tarjetas 13-19 dígitos

function redactSensitive(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(SENSITIVE, '$1: [omitido]')
    .replace(CVV, '$1: [omitido]')
    .replace(CARD, '[dato-pago-omitido]');
}

// ── Documento de memoria ─────────────────────────────────────────────────────
function emptyDoc(phone) {
  return {
    phone: String(phone || ''),
    tenant: TENANT,
    version: MEM_VERSION,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sessions: 0,
    lastSummarizedTs: 0,
    lastInteraction: null,
    fields: {
      nombre: null,
      preferencias: [],
      productos: [],
      temasRecurrentes: [],
      objeciones: [],
      pendientes: []
    },
    resumenBreve: '',
    log: []
  };
}

function asList(v, cap = MAX_LIST_ITEMS) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x)).filter(Boolean).slice(-cap);
}

function normalizeDoc(doc, phone) {
  const base = emptyDoc(phone || (doc && doc.phone));
  if (!doc || typeof doc !== 'object') return base;
  base.createdAt = doc.createdAt || base.createdAt;
  base.updatedAt = doc.updatedAt || base.updatedAt;
  base.sessions  = Number(doc.sessions) || 0;
  base.lastSummarizedTs = Number(doc.lastSummarizedTs) || 0;
  base.lastInteraction  = doc.lastInteraction || null;
  base.resumenBreve     = typeof doc.resumenBreve === 'string' ? doc.resumenBreve : '';
  base.log = Array.isArray(doc.log) ? doc.log.slice(-MAX_LOG_ENTRIES) : [];
  const f = doc.fields || {};
  base.fields = {
    nombre: f.nombre ? String(f.nombre) : null,
    preferencias:    asList(f.preferencias),
    productos:       asList(f.productos),
    temasRecurrentes: asList(f.temasRecurrentes),
    objeciones:      asList(f.objeciones),
    pendientes:      asList(f.pendientes)
  };
  return base;
}

async function getMemoryDoc(phone) {
  const redis = getRedis();
  if (redis) {
    try {
      const raw = await redis.get(memKey(phone));
      if (raw) return normalizeDoc(JSON.parse(raw), phone);
    } catch (e) {
      console.error('[client-memory] Redis get falló, uso disco:', e.message);
    }
  }
  const disk = loadDisk();
  if (disk[phone]) return normalizeDoc(disk[phone], phone);
  return null;
}

async function saveMemoryDoc(phone, doc) {
  const clean = normalizeDoc(doc, phone);
  clean.phone = String(phone);
  clean.tenant = TENANT;
  clean.version = MEM_VERSION;
  clean.updatedAt = Date.now();
  const payload = JSON.stringify(clean);

  const redis = getRedis();
  if (redis) {
    try {
      if (MEM_NO_TTL) await redis.set(memKey(phone), payload);
      else            await redis.setEx(memKey(phone), MEM_TTL_SECS, payload);
    } catch (e) {
      console.error('[client-memory] Redis set falló:', e.message);
    }
  }

  loadDisk()[phone] = clean;
  await persistDisk();
  return clean;
}

// ── Fusión (nunca pierde historial) ──────────────────────────────────────────
function mergeList(prevList, newList) {
  const out = [];
  const seen = new Set();
  for (const item of [].concat(prevList || [], newList || [])) {
    const s = String(item == null ? '' : item).trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out.length > MAX_LIST_ITEMS ? out.slice(out.length - MAX_LIST_ITEMS) : out;
}

/**
 * Fusiona un update (resumen de sesión) con el documento previo.
 * @param {object|null} prev  documento anterior
 * @param {object} update     { nombre, preferencias, productos, temasRecurrentes, objeciones, pendientes, resumenBreve } o { fields: {...}, resumenBreve }
 * @param {object} meta       { phone, msgs, lastSummarizedTs, lastInteraction }
 */
function mergeMemoryDoc(prev, update, meta) {
  meta = meta || {};
  const base = prev ? normalizeDoc(prev, prev.phone || meta.phone) : emptyDoc(meta.phone);
  const upd = update || {};
  const uf = upd.fields || upd;

  if (uf.nombre) base.fields.nombre = redactSensitive(String(uf.nombre)).slice(0, 120);
  if (uf.preferencias)     base.fields.preferencias     = mergeList(base.fields.preferencias, uf.preferencias);
  if (uf.productos)        base.fields.productos        = mergeList(base.fields.productos, uf.productos);
  if (uf.temasRecurrentes) base.fields.temasRecurrentes = mergeList(base.fields.temasRecurrentes, uf.temasRecurrentes);
  if (uf.objeciones)       base.fields.objeciones       = mergeList(base.fields.objeciones, uf.objeciones);
  if (uf.pendientes)       base.fields.pendientes       = mergeList(base.fields.pendientes, uf.pendientes);

  if (upd.resumenBreve) base.resumenBreve = redactSensitive(String(upd.resumenBreve)).slice(0, 400);

  base.updatedAt = Date.now();
  base.sessions  = (base.sessions || 0) + 1;

  if (meta.lastInteraction) base.lastInteraction = meta.lastInteraction;
  if (meta.lastSummarizedTs) {
    base.lastSummarizedTs = Math.max(base.lastSummarizedTs || 0, meta.lastSummarizedTs);
  }
  if (meta.msgs != null) {
    base.log = (base.log || [])
      .concat([{ at: Date.now(), resumen: base.resumenBreve || '', msgs: meta.msgs }])
      .slice(-MAX_LOG_ENTRIES);
  }
  return base;
}

// ── Resumen de sesión con el modelo ya integrado ─────────────────────────────
const SUMMARY_SCHEMA_HINT =
  '{ "nombre": string|null, "preferencias": [string], "productos": [string], ' +
  '"temasRecurrentes": [string], "objeciones": [string], "pendientes": [string], "resumenBreve": string }';

function toList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  return [String(v)];
}

function buildSummaryPrompt(history) {
  const conv = (history || []).map((m) => {
    const who = m.role === 'user' ? 'Cliente' : m.role === 'bot' ? 'Bot' : 'Operador';
    const txt = redactSensitive(String(m.text || '')).slice(0, 400);
    return `${who}: ${txt}`;
  }).filter((l) => l.split(': ')[1] && l.split(': ')[1].length > 1).join('\n');

  return `Eres un extractor de memoria de clientes para un negocio de atencion por WhatsApp.
A partir de la conversacion, extrae SOLO informacion util para futuras interacciones.

Reglas:
- NO incluyas datos de pago, tarjetas, claves ni datos sensibles.
- NO incluyas saludos, despedidas ni charla trivial.
- Escribe en espanol, conciso.
- Si un campo no tiene informacion, usa null (escalares) o [] (listas).
- No inventes informacion que no este en la conversacion.

Campos:
- nombre: nombre del cliente si lo dio.
- preferencias: gustos, preferencias o caracteristicas (ej "piel sensible").
- productos: productos consultados o comprados (incluye el codigo [handle] si aparece).
- temasRecurrentes: temas que el cliente consulta repetidamente.
- objeciones: dudas, quejas u objeciones.
- pendientes: cosas que quedaron pendientes.
- resumenBreve: 1-2 frases con lo mas importante.

Conversacion:
${conv || '(sin contenido)'}

Responde SOLO JSON valido con esta forma exacta:
${SUMMARY_SCHEMA_HINT}`;
}

async function defaultLLM(prompt) {
  const dsKey = process.env.DEEPSEEK_API_KEY;
  const clKey = process.env.CLAUDE_API_KEY;

  // 1. DeepSeek (barato) — mismo patrón que core/nightly-summary.js
  if (dsKey) {
    try {
      const r = await axios.post('https://api.deepseek.com/v1/chat/completions', {
        model: 'deepseek-chat',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }]
      }, {
        headers: { Authorization: 'Bearer ' + dsKey, 'Content-Type': 'application/json' },
        timeout: 30000
      });
      const t = r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message
        ? r.data.choices[0].message.content : null;
      if (t) return t;
    } catch (e) {
      console.log('[client-memory] DeepSeek falló, probando Claude: ' + e.message.slice(0, 80));
    }
  }

  // 2. Claude (fallback)
  if (clKey) {
    try {
      const r = await axios.post('https://api.anthropic.com/v1/messages', {
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }]
      }, {
        headers: { 'x-api-key': clKey, 'anthropic-version': '2023-06-01' },
        timeout: 30000
      });
      const t = r.data && r.data.content && r.data.content[0] ? r.data.content[0].text : null;
      if (t) return t;
    } catch (e) {
      console.log('[client-memory] Claude falló: ' + e.message.slice(0, 80));
    }
  }
  return null;
}

function parseSummary(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start !== -1 && end > start) t = t.slice(start, end + 1);
  try {
    const obj = JSON.parse(t);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    return {
      nombre: obj.nombre ? String(obj.nombre) : null,
      preferencias: toList(obj.preferencias),
      productos: toList(obj.productos),
      temasRecurrentes: toList(obj.temasRecurrentes),
      objeciones: toList(obj.objeciones),
      pendientes: toList(obj.pendientes),
      resumenBreve: obj.resumenBreve ? String(obj.resumenBreve) : ''
    };
  } catch {
    return null;
  }
}

async function summarizeSession(history) {
  const llm = llmOverride || defaultLLM;
  const raw = await llm(buildSummaryPrompt(history));
  return parseSummary(raw);
}

// ── Cierre de sesión ─────────────────────────────────────────────────────────
/**
 * Genera el resumen de la sesión y lo fusiona con el documento previo.
 * Solo resume los mensajes posteriores al watermark (lastSummarizedTs),
 * así no re-resume ni duplica.
 */
async function closeSession(phone, config) {
  try {
    if (config && config.memoryEnabled === false) return null;

    const mem = getMemoryProvider();
    const history = await mem.getHistory(phone, 100);
    if (!history || history.length === 0) return null;

    const prev = await getMemoryDoc(phone);
    const watermark = prev ? prev.lastSummarizedTs : 0;
    const fresh = history.filter((m) => (m.ts || 0) > watermark);
    if (fresh.length < MIN_MSGS_TO_SUMMARIZE) return null;

    const summary = await summarizeSession(fresh);
    if (!summary) return null;

    const maxTs = fresh.reduce((a, m) => Math.max(a, m.ts || 0), watermark);
    const merged = mergeMemoryDoc(prev, summary, {
      phone,
      msgs: fresh.length,
      lastSummarizedTs: maxTs || Date.now(),
      lastInteraction: { at: maxTs || Date.now(), channel: 'whatsapp' }
    });
    const saved = await saveMemoryDoc(phone, merged);
    console.log(`[client-memory] sesión cerrada para ${phone} (${fresh.length} msgs, sesiones=${saved.sessions})`);
    return saved;
  } catch (e) {
    console.error('[client-memory] closeSession error:', e.message);
    return null;
  }
}

// ── Gestor de sesión por inactividad ─────────────────────────────────────────
const idleTimers = new Map();

function touch(phone, config) {
  if (config && config.memoryEnabled === false) return;
  const minutes = (config && config.sessionIdleMinutes) || DEFAULT_IDLE_MINUTES;
  const ms = Math.max(1, minutes) * 60 * 1000;
  const existing = idleTimers.get(phone);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    idleTimers.delete(phone);
    closeSession(phone, config).catch(() => {});
  }, ms);
  if (typeof t.unref === 'function') t.unref();
  idleTimers.set(phone, t);
}

function cancelIdle(phone) {
  const t = idleTimers.get(phone);
  if (t) { clearTimeout(t); idleTimers.delete(phone); }
}

// ── Sección para el system prompt (acotada por bytes, priorizada) ────────────
function formatDocSection(doc, maxBytes) {
  if (!doc) return '';
  const limit = maxBytes || PROMPT_MAX_BYTES;
  const f = doc.fields || {};
  const lines = [];
  let used = 0;

  const push = (label, value) => {
    if (!value) return;
    const line = `${label}: ${value}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    if (used + bytes > limit) return;
    lines.push(line);
    used += bytes;
  };

  // Orden = prioridad de campos (si el límite corta, se pierden los últimos)
  push('Nombre', f.nombre);
  (f.pendientes || []).forEach((x) => push('Pendiente', x));
  (f.preferencias || []).forEach((x) => push('Preferencia', x));
  (f.productos || []).forEach((x) => push('Producto', x));
  (f.temasRecurrentes || []).forEach((x) => push('Tema recurrente', x));
  (f.objeciones || []).forEach((x) => push('Objeción', x));
  push('Resumen', doc.resumenBreve);
  if (doc.lastInteraction && doc.lastInteraction.at) {
    try {
      const d = new Date(doc.lastInteraction.at)
        .toLocaleDateString('es-CL', { timeZone: 'America/Santiago' });
      push('Última interacción', d);
    } catch { /* ignore */ }
  }

  if (!lines.length) return '';

  return '\n\n---\n\n## Memoria del cliente (interacciones anteriores)\n' +
    'Usa esta información para NO volver a preguntar lo que ya sabes. ' +
    'Si contradice lo que el cliente dice ahora, prioriza lo más reciente.\n' +
    lines.join('');
}

async function getMemoryPromptSection(phone, maxBytes) {
  if (!phone) return '';
  try {
    const doc = await getMemoryDoc(phone);
    return formatDocSection(doc, maxBytes);
  } catch (e) {
    return '';
  }
}

module.exports = {
  memKey,
  emptyDoc, normalizeDoc, mergeMemoryDoc, mergeList,
  getMemoryDoc, saveMemoryDoc,
  buildSummaryPrompt, parseSummary, summarizeSession, closeSession,
  touch, cancelIdle,
  formatDocSection, getMemoryPromptSection,
  redactSensitive,
  // inyección para tests
  _setRedisClient, _setRedisProvider, _setLLM, _setMemoryProvider, _setMemoryDir,
  get _idleTimers() { return idleTimers; },
  MEM_TTL_SECS, DEFAULT_IDLE_MINUTES, TENANT
};
