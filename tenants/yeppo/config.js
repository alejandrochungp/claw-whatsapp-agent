/**
 * tenants/yeppo/config.js
 *
 * Toda la configuración específica de Yeppo.
 * Los valores sensibles vienen de variables de entorno (Railway).
 */

module.exports = {
  // Identificación
  name:          'Yeppo',
  businessPhone: process.env.BUSINESS_PHONE || '+56961450273',

  // Webhook
  verifyToken:   process.env.WEBHOOK_VERIFY_TOKEN || 'yeppo_whatsapp_verify_2026',
  port:          process.env.PORT || 3001,

  // Slack — C05FES87S9J es el canal whatsapp de Yeppo (hardcoded como fallback seguro)
  slackChannel:  process.env.SLACK_CHANNEL_ID || process.env.SLACK_CHANNEL_WHATSAPP || 'C05FES87S9J',

  // Horario de atención (Santiago, Chile)
  businessHours: {
    timezone: 'America/Santiago',
    days:     [1, 2, 3, 4, 5], // Lun–Vie
    startHour: 10,
    endHour:   18
  },

  // Mensaje de fallback cuando IA falla o presupuesto agotado
  fallbackMessage: 'Disculpa, tuve un problema técnico. Escribe "humano" para hablar con el equipo.',

  // Mensaje fuera de horario
  offHoursMessage: 'Gracias por escribir a Yeppo!\n\nAhora estamos fuera de horario (lun–vie 10:00–18:00).\n\nTe respondemos apenas abramos. Si es urgente, igual te anotamos y te contactamos pronto.'
};
