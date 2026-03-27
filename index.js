/**
 * claw-whatsapp-agent — Multi-tenant entry point
 *
 * Carga el tenant indicado por la variable TENANT (ej: TENANT=yeppo)
 * y arranca el servidor con su configuración y lógica de negocio.
 */

require('dotenv').config();

const TENANT = process.env.TENANT;

if (!TENANT) {
  console.error('❌ Variable TENANT no definida. Usa: TENANT=yeppo node index.js');
  process.exit(1);
}

// Cargar config y business logic del tenant
let tenantConfig, tenantBusiness;
try {
  tenantConfig   = require(`./tenants/${TENANT}/config`);
  tenantBusiness = require(`./tenants/${TENANT}/business`);
} catch (e) {
  console.error(`❌ Tenant "${TENANT}" no encontrado en tenants/${TENANT}/`);
  console.error(e.message);
  process.exit(1);
}

console.log(`🚀 claw-whatsapp-agent arrancando con tenant: ${TENANT}`);
console.log(`📱 Número: ${tenantConfig.businessPhone}`);
console.log(`💬 Slack: ${tenantConfig.slackChannel}`);

// Esperar Redis antes de arrancar (evita perder historial al reiniciar)
const memory = require('./core/memory');
const server = require('./core/server');

memory.waitForRedis(5000).then(() => {
  server.start(tenantConfig, tenantBusiness);
});
