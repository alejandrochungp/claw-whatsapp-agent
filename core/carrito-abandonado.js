/**
 * carrito-abandonado.js
 * Módulo automático de recuperación de carritos abandonados
 * 
 * Se integra al bot existente (server.js) y corre internamente cada 60 minutos.
 * Usa Redis para deduplicación persistente (no reenvía al mismo cliente).
 * 
 * Configuración (variables de entorno Railway):
 *   SHOPIFY_TOKEN       — token admin de Shopify
 *   SHOPIFY_STORE       — ej: 59c6fd-2.myshopify.com
 *   WA_TOKEN            — token de WhatsApp Business API
 *   PHONE_NUMBER_ID     — ID del número WhatsApp (217563878110256)
 *   REDIS_URL           — URL de Redis (opcional, fallback a Set en RAM)
 *   CARRITO_ENABLED     — "true" para activar (default: false, seguro por defecto)
 *   CARRITO_MIN_MINUTOS — minutos mínimos desde abandono (default: 45)
 *   CARRITO_MAX_DIAS    — días máximo hacia atrás (default: 7)
 *   CARRITO_HORA_INICIO — hora inicio envíos (default: 10)
 *   CARRITO_HORA_FIN    — hora fin envíos (default: 22)
 */

const https = require('https');

// ─── Configuración ────────────────────────────────────────────────────────────

const CONFIG = {
  enabled: process.env.CARRITO_ENABLED === 'true',
  shopifyToken: process.env.SHOPIFY_TOKEN,
  shopifyStore: process.env.SHOPIFY_STORE || '59c6fd-2.myshopify.com',
  waToken: process.env.WA_TOKEN,
  phoneId: process.env.PHONE_NUMBER_ID || '217563878110256',
  templateName: 'carrito_abandonado_recuperar',
  templateLang: 'es_CL',
  utmCampaign: 'carrito_auto',          // ← distinto de campañas manuales
  minMinutos: parseInt(process.env.CARRITO_MIN_MINUTOS || '45'),
  maxDias: parseInt(process.env.CARRITO_MAX_DIAS || '7'),
  horaInicio: parseInt(process.env.CARRITO_HORA_INICIO || '10'),
  horaFin: parseInt(process.env.CARRITO_HORA_FIN || '22'),
  intervaloMs: 60 * 60 * 1000,          // cada 60 minutos
  delayEntreEnviosMs: 1200,             // pausa entre mensajes (evitar rate limit)
};

// ─── Deduplicación ────────────────────────────────────────────────────────────

// Fallback en RAM si no hay Redis
const sentSetFallback = new Set();

// Intentar usar Redis si está disponible (módulo memory.js del bot)
let redisClient = null;
const REDIS_KEY = 'carrito:enviados';

async function initRedis() {
  try {
    if (process.env.REDIS_URL) {
      const { createClient } = require('redis');
      redisClient = createClient({ url: process.env.REDIS_URL });
      await redisClient.connect();
      console.log('[carrito] Redis conectado');
    }
  } catch (e) {
    console.warn('[carrito] Redis no disponible, usando RAM:', e.message);
    redisClient = null;
  }
}

async function yaEnviado(phone) {
  if (redisClient) {
    return await redisClient.sIsMember(REDIS_KEY, phone);
  }
  return sentSetFallback.has(phone);
}

async function marcarEnviado(phone) {
  if (redisClient) {
    await redisClient.sAdd(REDIS_KEY, phone);
    // TTL de 30 días para limpiar automáticamente
    await redisClient.expire(REDIS_KEY, 30 * 24 * 60 * 60);
  } else {
    sentSetFallback.add(phone);
  }
}

// ─── Shopify ──────────────────────────────────────────────────────────────────

function shopifyRequest(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: CONFIG.shopifyStore,
      path: '/admin/api/2024-01' + path,
      method: 'GET',
      headers: { 'X-Shopify-Access-Token': CONFIG.shopifyToken }
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function normalizePhone(raw) {
  if (!raw) return null;
  let p = raw.replace(/[^0-9]/g, '');
  if (p.startsWith('56') && p.length === 11) return p;
  if (p.startsWith('9') && p.length === 9) return '56' + p;
  if (p.length === 8) return '569' + p;
  return null;
}

// ─── WhatsApp ─────────────────────────────────────────────────────────────────

function sendTemplate(phone, nombre, checkoutUrl) {
  // Extraer path relativo + agregar UTM
  const urlPath = checkoutUrl.replace('https://yeppo.cl/', '') +
    `&utm_source=whatsapp&utm_medium=carrito_abandonado&utm_campaign=${CONFIG.utmCampaign}`;

  const body = JSON.stringify({
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: CONFIG.templateName,
      language: { code: CONFIG.templateLang },
      components: [
        {
          type: 'body',
          parameters: [{ type: 'text', text: nombre }]
        },
        {
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [{ type: 'text', text: urlPath }]
        }
      ]
    }
  });

  return new Promise((resolve) => {
    const options = {
      hostname: 'graph.facebook.com',
      path: `/v18.0/${CONFIG.phoneId}/messages`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CONFIG.waToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve(null); }
      });
    });
    req.on('error', e => resolve({ error: e.message }));
    req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Lógica principal ─────────────────────────────────────────────────────────

async function run() {
  if (!CONFIG.enabled) {
    console.log('[carrito] Desactivado (CARRITO_ENABLED != true)');
    return;
  }

  // Verificar ventana horaria (hora Santiago)
  const ahora = new Date();
  const horaChile = new Date(ahora.toLocaleString('en-US', { timeZone: 'America/Santiago' }));
  const hora = horaChile.getHours();

  if (hora < CONFIG.horaInicio || hora >= CONFIG.horaFin) {
    console.log(`[carrito] Fuera de horario (${hora}:xx) — esperando`);
    return;
  }

  // Obtener carritos abandonados de Shopify
  const since = new Date(Date.now() - CONFIG.maxDias * 24 * 60 * 60 * 1000).toISOString();
  const r = await shopifyRequest(`/checkouts.json?status=open&updated_at_min=${since}&limit=250`);
  const checkouts = r?.checkouts || [];

  if (checkouts.length === 0) {
    console.log('[carrito] Sin carritos abiertos');
    return;
  }

  // Filtrar y deduplicar por teléfono
  const ahoraMs = Date.now();
  const porTelefono = new Map();

  for (const c of checkouts) {
    // Ignorar pedidos internos
    if (c.email === 'marketing@yeppo.cl') continue;

    // Solo carritos con suficiente antigüedad
    const minutosDesde = (ahoraMs - new Date(c.updated_at).getTime()) / 60000;
    if (minutosDesde < CONFIG.minMinutos) continue;

    // Normalizar teléfonos
    const phones = [c.phone, c.billing_address?.phone, c.shipping_address?.phone]
      .map(normalizePhone).filter(Boolean);

    for (const phone of phones) {
      // Saltar si ya fue contactado (Redis/RAM)
      if (await yaEnviado(phone)) continue;

      const total = parseFloat(c.total_price || 0);
      const existing = porTelefono.get(phone);

      // Si hay múltiples carritos del mismo número, quedarse con el de mayor valor
      if (!existing || total > existing.total) {
        const nombre = c.billing_address?.first_name ||
                       c.shipping_address?.first_name || 'ahí';
        porTelefono.set(phone, {
          phone, nombre, total,
          checkoutUrl: c.abandoned_checkout_url,
          email: c.email
        });
      }
    }
  }

  const candidatos = [...porTelefono.values()];
  console.log(`[carrito] ${candidatos.length} candidatos nuevos de ${checkouts.length} checkouts`);

  if (candidatos.length === 0) return;

  // Enviar
  let ok = 0, fail = 0;

  for (const { phone, nombre, total, checkoutUrl } of candidatos) {
    const result = await sendTemplate(phone, nombre, checkoutUrl);

    if (result?.messages?.[0]?.id) {
      console.log(`[carrito] ✅ ${phone} (${nombre}) $${total}`);
      await marcarEnviado(phone);
      ok++;
    } else {
      const errMsg = result?.error?.message || JSON.stringify(result);
      console.log(`[carrito] ❌ ${phone} (${nombre}) — ${errMsg}`);
      fail++;
    }

    await sleep(CONFIG.delayEntreEnviosMs);
  }

  console.log(`[carrito] Ciclo completo: ${ok} enviados, ${fail} fallidos`);
}

// ─── Inicialización ───────────────────────────────────────────────────────────

let _interval = null;

async function start() {
  await initRedis();

  if (!CONFIG.enabled) {
    console.log('[carrito] Módulo inactivo. Activar con CARRITO_ENABLED=true en Railway.');
    return;
  }

  console.log(`[carrito] Iniciando — revisión cada ${CONFIG.intervaloMs / 60000} min`);
  console.log(`[carrito] Horario: ${CONFIG.horaInicio}:00 - ${CONFIG.horaFin}:00 (Santiago)`);
  console.log(`[carrito] Mínimo abandono: ${CONFIG.minMinutos} min`);

  // Ejecutar inmediatamente al iniciar
  await run().catch(e => console.error('[carrito] Error en run():', e.message));

  // Luego cada hora
  _interval = setInterval(() => {
    run().catch(e => console.error('[carrito] Error en run():', e.message));
  }, CONFIG.intervaloMs);
}

function stop() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
    console.log('[carrito] Detenido');
  }
}

module.exports = { start, stop, run };
