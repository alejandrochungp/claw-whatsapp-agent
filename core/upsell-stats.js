/**
 * core/upsell-stats.js — Dashboard estadísticas de upsell
 */
const logger = require('./logger');
const COMERCIAL_CHANNEL = 'C08DXMRJ6CD';

async function trackEvent(type, phone, data = {}) {
  const memory = require('./memory');
  if (!memory.redis) return;
  try {
    const event = { type, phone, data, ts: Date.now() };
    const key = `upsell_event:${Date.now()}:${phone}`;
    await memory.redis.setEx(key, 30 * 24 * 60 * 60, JSON.stringify(event));
  } catch (e) { logger.log(`[upsell-stats] trackEvent error: ${e.message}`); }
}

async function getEvents(sinceDays = 7) {
  const memory = require('./memory');
  if (!memory.redis) return [];
  try {
    const since = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
    const keys = await memory.redis.keys('upsell_event:*');
    const events = [];
    for (const key of keys) {
      const raw = await memory.redis.get(key);
      if (!raw) continue;
      const ev = JSON.parse(raw);
      if (ev.ts >= since) events.push(ev);
    }
    return events.sort((a, b) => a.ts - b.ts);
  } catch (e) { logger.log(`[upsell-stats] getEvents error: ${e.message}`); return []; }
}

async function postDashboard(sinceDays = 7) {
  const axios = require('axios');
  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken) return;

  const events = await getEvents(sinceDays);

  const sent     = events.filter(e => e.type === 'sent').length;
  const accepted = events.filter(e => e.type === 'accepted').length;
  const paid     = events.filter(e => e.type === 'paid').length;
  const rejected = events.filter(e => e.type === 'rejected').length;
  const reverted = events.filter(e => e.type === 'reverted').length;

  const acceptRate = sent > 0 ? ((accepted / sent) * 100).toFixed(1) : '0';
  const payRate    = accepted > 0 ? ((paid / accepted) * 100).toFixed(1) : '0';
  const convRate   = sent > 0 ? ((paid / sent) * 100).toFixed(1) : '0';

  const totalRevenue = events.filter(e => e.type === 'paid')
    .reduce((sum, e) => sum + (e.data?.precio || 0), 0);

  const complementoCount = {};
  events.filter(e => e.type === 'accepted').forEach(e => {
    const c = e.data?.complemento || 'desconocido';
    complementoCount[c] = (complementoCount[c] || 0) + 1;
  });
  const topComplementos = Object.entries(complementoCount)
    .sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([c, n]) => `  • ${c}: ${n}`).join('\n');

  const periodo = sinceDays === 1 ? 'hoy' : `ultimos ${sinceDays} dias`;
  const msg = `:bar_chart: *Estadisticas Upsell — ${periodo}*

*Enviados:* ${sent}
*Aceptados:* ${accepted} (${acceptRate}% tasa aceptacion)
*Pagados:* ${paid} (${payRate}% de aceptados pagan)
*Conversion total:* ${convRate}% (enviados → pagados)
*Rechazados:* ${rejected}
*Revertidos por no pago:* ${reverted}

*Ingresos generados:* $${Math.round(totalRevenue).toLocaleString('es-CL')} CLP
${topComplementos ? `\n*Top complementos aceptados:*\n${topComplementos}` : ''}`;

  await axios.post('https://slack.com/api/chat.postMessage', {
    channel: COMERCIAL_CHANNEL,
    text: msg
  }, { headers: { Authorization: `Bearer ${slackToken}`, 'Content-Type': 'application/json' } })
  .catch(e => logger.log(`[upsell-stats] Slack error: ${e.message}`));

  logger.log(`[upsell-stats] Dashboard posteado en #team-comercial`);
}

module.exports = { trackEvent, getEvents, postDashboard };
