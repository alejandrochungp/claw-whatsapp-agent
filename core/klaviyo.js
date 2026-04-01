/**
 * core/klaviyo.js — Integración Klaviyo para Yeppo
 *
 * Funciones:
 * 1. markCartContactedByWA(email, phone) — marca al cliente como contactado
 *    por WhatsApp para que Klaviyo suprima el email de carrito abandonado
 * 2. updateSkinProfile(email, phone, profile) — guarda perfil de piel en Klaviyo
 *    (tipo de piel, preocupaciones, edad, etc.) para segmentación y flujos
 * 3. findProfileByPhone(phone) — busca perfil Klaviyo por número de teléfono
 */

const https = require('https');

const KLAVIYO_KEY = process.env.KLAVIYO_API_KEY;
const REVISION    = '2024-02-15';

// ─── Helper HTTP ──────────────────────────────────────────────────────────────

function klaviyoRequest(method, path, body = null) {
  return new Promise((resolve) => {
    if (!KLAVIYO_KEY) {
      console.log('[klaviyo] Sin API key — operación omitida');
      return resolve(null);
    }

    const payload = body ? JSON.stringify(body) : null;

    const options = {
      hostname: 'a.klaviyo.com',
      path,
      method,
      headers: {
        'Authorization':  `Klaviyo-API-Key ${KLAVIYO_KEY}`,
        'revision':       REVISION,
        'Accept':         'application/json',
        'Content-Type':   'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : { status: res.statusCode });
        } catch {
          resolve({ status: res.statusCode, raw: data.slice(0, 200) });
        }
      });
    });

    req.on('error', (e) => {
      console.error('[klaviyo] Request error:', e.message);
      resolve(null);
    });
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });

    if (payload) req.write(payload);
    req.end();
  });
}

// ─── Buscar perfil por teléfono ───────────────────────────────────────────────
// Klaviyo puede tener múltiples perfiles con el mismo teléfono (duplicados de testing).
// Retornamos el más relevante: el que tiene email activo + más pedidos Shopify.

async function findProfileByPhone(phone) {
  if (!KLAVIYO_KEY) return null;

  // Normalizar a +56XXXXXXXXX
  const digits = phone.replace(/\D/g, '');
  const normalized = digits.startsWith('56') ? `+${digits}` : `+56${digits}`;

  const encoded = encodeURIComponent(JSON.stringify([normalized]));
  const r = await klaviyoRequest('GET',
    `/api/profiles/?filter=any(phone_number,[${encodeURIComponent(`"${normalized}"`)}])&fields[profile]=email,phone_number,first_name,properties&page[size]=10`
  );

  if (!r?.data?.length) return null;

  // Priorizar: tiene shopify_orders_count > 0, luego el más reciente
  const profiles = r.data.filter(p =>
    p.attributes?.email &&
    !p.attributes.email.includes('+test') &&
    !p.attributes.email.includes('+integromat')
  );

  if (!profiles.length) return r.data[0]; // fallback al primero si todos son tests

  // Ordenar por más pedidos Shopify
  profiles.sort((a, b) => {
    const aOrders = a.attributes?.properties?.shopify_orders_count || 0;
    const bOrders = b.attributes?.properties?.shopify_orders_count || 0;
    return bOrders - aOrders;
  });

  return profiles[0];
}

// ─── Buscar perfil por email ──────────────────────────────────────────────────

async function findProfileByEmail(email) {
  if (!KLAVIYO_KEY || !email) return null;

  const r = await klaviyoRequest('GET',
    `/api/profiles/?filter=equals(email,"${encodeURIComponent(email)}")&fields[profile]=id,email,phone_number,properties&page[size]=1`
  );

  return r?.data?.[0] || null;
}

// ─── Actualizar propiedades de un perfil ──────────────────────────────────────

async function updateProfileProperties(profileId, properties) {
  if (!KLAVIYO_KEY || !profileId) return null;

  const r = await klaviyoRequest('PATCH', `/api/profiles/${profileId}/`, {
    data: {
      type: 'profile',
      id: profileId,
      attributes: { properties }
    }
  });

  return r;
}

// ─── 1. Marcar carrito como contactado por WA ────────────────────────────────
// Se llama desde carrito-abandonado.js después de enviar el WA.
// Agrega `wa_carrito_enviado_at` al perfil → Klaviyo puede usarlo en el flujo
// para suprimir emails si ya recibió el WA en las últimas X horas.

async function markCartContactedByWA(phone, email = null) {
  try {
    // Buscar perfil: por email primero (más preciso), luego por teléfono
    let profile = null;
    if (email) {
      profile = await findProfileByEmail(email);
    }
    if (!profile) {
      profile = await findProfileByPhone(phone);
    }

    if (!profile) {
      console.log(`[klaviyo] Sin perfil para ${phone} — no se marcó WA carrito`);
      return false;
    }

    const now = new Date().toISOString();
    await updateProfileProperties(profile.id, {
      wa_carrito_enviado_at: now,
      wa_carrito_phone: `+${phone.replace(/\D/g, '')}`
    });

    console.log(`[klaviyo] ✅ Marcado wa_carrito_enviado_at para ${profile.attributes.email} (${phone})`);
    return true;
  } catch (e) {
    console.error('[klaviyo] markCartContactedByWA error:', e.message);
    return false;
  }
}

// ─── 2. Guardar perfil de piel ────────────────────────────────────────────────
// Llama al bot cuando Claude extrae info de piel durante la conversación.
// Campos soportados (todos opcionales):
//   tipoPiel       → 'Grasa' | 'Seca' | 'Mixta' | 'Normal' | 'Sensible'
//   preocupaciones → ['acne', 'manchas', 'arrugas', ...]  (array o string)
//   edad           → número o string
//   productosActuales → descripción libre
//   alergias       → descripción libre
//   rutina         → 'AM' | 'PM' | 'AM+PM' | 'ninguna'

async function updateSkinProfile(phone, skinData) {
  try {
    const profile = await findProfileByPhone(phone);

    if (!profile) {
      console.log(`[klaviyo] Sin perfil para ${phone} — skin profile no guardado`);
      return false;
    }

    // Mapear campos a propiedades Klaviyo (naming consistente con "Tipo Piel" existente)
    const properties = {};

    if (skinData.tipoPiel)          properties['Tipo Piel']             = skinData.tipoPiel;
    if (skinData.preocupaciones)    properties['Preocupaciones Piel']   = Array.isArray(skinData.preocupaciones)
                                                                            ? skinData.preocupaciones.join(', ')
                                                                            : skinData.preocupaciones;
    if (skinData.edad)              properties['Edad Aprox']            = skinData.edad;
    if (skinData.productosActuales) properties['Productos Actuales']    = skinData.productosActuales;
    if (skinData.alergias)          properties['Alergias']              = skinData.alergias;
    if (skinData.rutina)            properties['Rutina Skincare']       = skinData.rutina;

    // Timestamp de última actualización por el bot
    properties['skin_profile_updated_at'] = new Date().toISOString();
    properties['skin_profile_source']     = 'whatsapp_bot';

    await updateProfileProperties(profile.id, properties);

    console.log(`[klaviyo] ✅ Perfil de piel actualizado para ${profile.attributes.email}: ${JSON.stringify(properties)}`);
    return true;
  } catch (e) {
    console.error('[klaviyo] updateSkinProfile error:', e.message);
    return false;
  }
}

// ─── 3. Obtener perfil de piel (para enriquecer contexto del bot) ─────────────

async function getSkinProfile(phone) {
  try {
    const profile = await findProfileByPhone(phone);
    if (!profile?.attributes?.properties) return null;

    const props = profile.attributes.properties;
    const skin = {};

    if (props['Tipo Piel'])           skin.tipoPiel          = props['Tipo Piel'];
    if (props['Preocupaciones Piel']) skin.preocupaciones    = props['Preocupaciones Piel'];
    if (props['Edad Aprox'])          skin.edad              = props['Edad Aprox'];
    if (props['Productos Actuales'])  skin.productosActuales = props['Productos Actuales'];
    if (props['Alergias'])            skin.alergias          = props['Alergias'];
    if (props['Rutina Skincare'])     skin.rutina            = props['Rutina Skincare'];

    return Object.keys(skin).length ? skin : null;
  } catch (e) {
    console.error('[klaviyo] getSkinProfile error:', e.message);
    return null;
  }
}

module.exports = {
  findProfileByPhone,
  findProfileByEmail,
  markCartContactedByWA,
  updateSkinProfile,
  getSkinProfile
};
