/**
 * core/amac-reporter.js
 *
 * Genera y publica el reporte semanal AMAC en el canal #agente-aprendizaje de Slack.
 * Incluye:
 *   - Resumen ejecutivo de conversaciones
 *   - Cambios aplicados al knowledge
 *   - Features detectadas para ingeniería
 *   - KPIs de calidad y tiempos de respuesta de agentes
 */

'use strict';

const axios = require('axios');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function postToSlack(token, channel, payload) {
  return axios.post('https://slack.com/api/chat.postMessage',
    { channel, ...payload },
    { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, timeout: 10000 }
  );
}

/**
 * Publica el reporte semanal completo en Slack.
 *
 * @param {Object} opts
 * @param {string} opts.slackToken
 * @param {string} opts.channel         - ID del canal #agente-aprendizaje
 * @param {string} opts.tenant
 * @param {string} opts.weekLabel        - ej: "28 abr – 2 may 2026"
 * @param {Object} opts.kpis             - output de computeAgentKPIs()
 * @param {Object} opts.analysis         - output de analyzeConversations()
 * @param {Object} opts.knowledgeResult  - output de updateKnowledge()
 * @param {Array}  opts.issuesCreated    - issues creados en GitHub
 */
async function publishWeeklyReport({
  slackToken, channel, tenant, weekLabel,
  kpis, analysis, knowledgeResult, issuesCreated
}) {
  if (!slackToken || !channel) {
    console.log('[amac-reporter] Sin token o canal Slack — skip reporte');
    return;
  }

  // ── 1. Header del reporte ─────────────────────────────────────────────────
  const botPct = kpis.botResolutionRate || 0;
  const botEmoji = botPct >= 85 ? '🟢' : botPct >= 70 ? '🟡' : '🔴';

  const headerText =
    `📊 *Reporte AMAC — ${weekLabel}* | Tenant: *${tenant}*\n\n` +
    `${botEmoji} *${kpis.total} conversaciones* | Bot: ${botPct}% | Humano: ${100 - botPct}%\n` +
    (kpis.potentiallyIgnored > 0
      ? `⚠️ *${kpis.potentiallyIgnored} posibles casos ignorados* (>2h sin respuesta)\n`
      : `✅ Sin casos ignorados esta semana\n`) +
    (kpis.avgHumanResponseMin
      ? `⏱ Tiempo promedio de respuesta humana: *${kpis.avgHumanResponseMin} min*\n`
      : '');

  await postToSlack(slackToken, channel, { text: headerText });
  await sleep(600);

  // ── 2. Knowledge actualizado ──────────────────────────────────────────────
  if (knowledgeResult?.updated) {
    await postToSlack(slackToken, channel, {
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `📚 *Knowledge Base Actualizada*\n\n${knowledgeResult.diff}`
          }
        }
      ]
    });
    await sleep(600);
  }

  // ── 3. Features para ingeniería ───────────────────────────────────────────
  const features = analysis?.feature_requests?.slice(0, 5) || [];
  if (features.length > 0) {
    const featureLines = features.map((fr, i) =>
      `${i+1}. *${fr.accion_manual.slice(0, 70)}* — ${fr.frecuencia}x esta semana (${fr.impacto})`
    ).join('\n');

    const issueLinks = issuesCreated?.length > 0
      ? '\n\n🔗 Issues creados: ' + issuesCreated.map(i => `<${i.url}|#${i.number}>`).join(', ')
      : '';

    await postToSlack(slackToken, channel, {
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `🔧 *Features para Ingeniería* (${features.length} detectadas)\n\n${featureLines}${issueLinks}`
          }
        }
      ]
    });
    await sleep(600);
  }

  // ── 4. Casos potencialmente ignorados ─────────────────────────────────────
  if (kpis.potentiallyIgnored > 0 && kpis.ignoredSamples?.length > 0) {
    const samples = kpis.ignoredSamples.map(s =>
      `• ${s.date} — thread ts: ${s.threadTs}`
    ).join('\n');

    await postToSlack(slackToken, channel, {
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `⚠️ *Casos posiblemente ignorados (>2h sin respuesta humana)*\n\n${samples}\n\n_Revisar si requieren seguimiento._`
          }
        }
      ]
    });
    await sleep(600);
  }

  // ── 5. Malas escalaciones ─────────────────────────────────────────────────
  const escalations = analysis?.malas_escalaciones?.slice(0, 3) || [];
  if (escalations.length > 0) {
    const escLines = escalations.map((e, i) =>
      `${i+1}. ${e.descripcion.slice(0, 100)}\n   → _${e.nuevo_criterio?.slice(0, 80) || 'Sin criterio sugerido'}_`
    ).join('\n\n');

    await postToSlack(slackToken, channel, {
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `🎯 *Criterios de Escalación a Revisar*\n\n${escLines}`
          }
        }
      ]
    });
    await sleep(600);
  }

  // ── 6. Footer ─────────────────────────────────────────────────────────────
  await postToSlack(slackToken, channel, {
    text: '_Reporte generado automáticamente por AMAC. Próximo reporte: viernes ' +
          getNextFriday() + '._'
  });

  console.log('[amac-reporter] ✅ Reporte publicado en Slack canal', channel);
}

function getNextFriday() {
  const d = new Date();
  const day = d.getDay(); // 0=Dom, 5=Vie
  const daysUntilFriday = (5 - day + 7) % 7 || 7;
  d.setDate(d.getDate() + daysUntilFriday);
  return d.toLocaleDateString('es-CL', { day: 'numeric', month: 'short' });
}

module.exports = { publishWeeklyReport };
