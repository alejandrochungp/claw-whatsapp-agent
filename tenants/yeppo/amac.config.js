/**
 * tenants/yeppo/amac.config.js
 *
 * Configuración del AMAC específica para Yeppo.
 * Cada tenant puede tener su propio canal, umbrales y reglas.
 */

module.exports = {
  // Tenant
  tenant: 'yeppo',

  // Canal Slack donde llegar el reporte semanal
  // #agente-aprendizaje en Yeppo
  reportChannel: process.env.SLACK_LEARNING_CHANNEL || 'C0APVLMV98Q',

  // Canal Slack de conversaciones a analizar
  // #team-servicio-al-cliente
  conversationsChannel: process.env.SLACK_CHANNEL_ID || 'C05FES87S9J',

  // Horario del cron: viernes 18:00 Santiago
  cronSchedule: '0 18 * * 5',
  cronTimezone: 'America/Santiago',

  // Auto-aprobar cambios al knowledge sin intervención humana
  autoApproveKnowledge: true,

  // Notificar por WhatsApp al owner tras cada ciclo
  notifyOwnerWhatsapp: process.env.OWNER_PHONE || '+56966283141',

  // GitHub backlog
  githubBacklogRepo: 'Programaemprender/claw-platform-backlog',

  // Umbrales para alertas
  thresholds: {
    // Si bot resuelve menos del 70%, alertar
    minBotResolutionRate: 70,
    // Tiempo máximo de respuesta humana sin alertar (minutos)
    maxHumanResponseMin: 60,
    // Casos ignorados máximos antes de alertar
    maxIgnoredCases: 2
  }
};
