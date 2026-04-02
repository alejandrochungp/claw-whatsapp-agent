/**
 * tenants/tupibox/config.js
 */

module.exports = {
  name:          'TupiBox Fresh',
  businessPhone: process.env.BUSINESS_PHONE || '+56920633976',
  accessToken:   process.env.WHATSAPP_ACCESS_TOKEN,

  verifyToken:   process.env.WEBHOOK_VERIFY_TOKEN || 'tupibox_fresh_verify_token_2026',
  port:          process.env.PORT || 3000,

  slackChannel:  process.env.SLACK_CHANNEL_ID || process.env.SLACK_CHANNEL_WHATSAPP || '#atencion-al-cliente',

  businessHours: {
    timezone:  'America/Santiago',
    days:      [1, 2, 3, 4, 5],
    startHour: 10,
    endHour:   18
  },

  fallbackMessage:  'disculpa, tuve un problema técnico. escribe "humano" para hablar con el equipo.',
  offHoursMessage:  'Hola! ahora estamos fuera de horario (lun-vie 10:00-18:00).\n\nTe anotamos y te respondemos apenas abramos. Si es urgente, igual escríbenos y te contestamos en cuanto veamos tu mensaje.'
};
