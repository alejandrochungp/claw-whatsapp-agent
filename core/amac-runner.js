/**
 * core/amac-runner.js
 *
 * Orquestador principal del AMAC.
 * Coordina: fetch Slack → análisis → update knowledge → GitHub issues → reporte Slack
 *
 * Uso:
 *   const runner = require('./amac-runner');
 *   runner.run('yeppo');              // un ciclo manual
 *   runner.startCron(config, tenant); // cron semanal automático
 */

'use strict';

const { CronJob }      = require('cron');
const amac             = require('./amac');
const knowledgeUpdater = require('./knowledge-updater');
const githubIssues     = require('./github-issues');
const reporter         = require('./amac-reporter');

// ── Helpers ───────────────────────────────────────────────────────────────────

function getWeekLabel() {
  const now  = new Date();
  const from = new Date(now); from.setDate(now.getDate() - 7);
  const fmt  = d => d.toLocaleDateString('es-CL', { day: 'numeric', month: 'short' });
  return fmt(from) + ' – ' + fmt(now) + ' ' + now.getFullYear();
}

function getSinceTs() {
  // 7 días atrás en Unix timestamp
  return String(Math.floor(Date.now() / 1000) - 7 * 24 * 3600);
}

// ── Runner principal ──────────────────────────────────────────────────────────

async function run(tenant, amacConfig) {
  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken) {
    console.error('[amac-runner] SLACK_BOT_TOKEN no configurado');
    return;
  }

  const cfg = amacConfig || (() => {
    try { return require('../tenants/' + tenant + '/amac.config'); } catch { return {}; }
  })();

  const weekLabel  = getWeekLabel();
  const sinceTs    = getSinceTs();
  const convChan   = cfg.conversationsChannel || process.env.SLACK_CHANNEL_ID;
  const reportChan = cfg.reportChannel        || process.env.SLACK_LEARNING_CHANNEL || convChan;

  console.log('[amac-runner] Iniciando ciclo AMAC — ' + weekLabel);
  console.log('[amac-runner] Tenant: ' + tenant + ' | Canal conversaciones: ' + convChan);

  // ── 1. Fetch conversaciones de la semana ──────────────────────────────────
  console.log('[amac-runner] Obteniendo conversaciones de Slack...');
  let conversations = [];
  try {
    conversations = await amac.fetchSlackConversations(slackToken, convChan, sinceTs);
    console.log('[amac-runner] ' + conversations.length + ' conversaciones obtenidas');
  } catch (e) {
    console.error('[amac-runner] Error fetch Slack:', e.message);
    return;
  }

  if (!conversations.length) {
    console.log('[amac-runner] Sin conversaciones nuevas — ciclo terminado');
    return;
  }

  // ── 2. KPIs ───────────────────────────────────────────────────────────────
  const kpis = amac.computeAgentKPIs(conversations);
  console.log('[amac-runner] KPIs:', JSON.stringify(kpis));

  // ── 3. Análisis IA ────────────────────────────────────────────────────────
  console.log('[amac-runner] Analizando conversaciones con DeepSeek...');
  let analysis = null;
  try {
    analysis = await amac.analyzeConversations(conversations, tenant);
    if (analysis) {
      console.log('[amac-runner] Gaps: ' + analysis.knowledge_gaps.length +
        ' | Features: ' + analysis.feature_requests.length +
        ' | Escalaciones: ' + analysis.malas_escalaciones.length);
    }
  } catch (e) {
    console.error('[amac-runner] Error análisis:', e.message);
  }

  // ── 4. Update knowledge ───────────────────────────────────────────────────
  let knowledgeResult = { updated: false, diff: 'Sin análisis disponible' };
  if (analysis?.knowledge_gaps?.length > 0 && cfg.autoApproveKnowledge !== false) {
    console.log('[amac-runner] Actualizando knowledge_doc.md...');
    try {
      knowledgeResult = await knowledgeUpdater.updateKnowledge(tenant, analysis.knowledge_gaps);
      if (knowledgeResult.updated) {
        console.log('[amac-runner] Knowledge actualizado:', knowledgeResult.diff.slice(0, 100));
        // Push a GitHub
        await knowledgeUpdater.pushToGitHub(tenant, knowledgeResult.newDoc, weekLabel);
      }
    } catch (e) {
      console.error('[amac-runner] Error update knowledge:', e.message);
    }
  }

  // ── 5. GitHub Issues ──────────────────────────────────────────────────────
  let issuesCreated = [];
  if (analysis?.feature_requests?.length > 0) {
    console.log('[amac-runner] Creando GitHub issues...');
    try {
      issuesCreated = await githubIssues.processFeatureRequests(
        tenant,
        analysis.feature_requests,
        weekLabel
      );
      console.log('[amac-runner] ' + issuesCreated.length + ' issues creados');
    } catch (e) {
      console.error('[amac-runner] Error GitHub issues:', e.message);
    }
  }

  // ── 6. Reporte Slack ──────────────────────────────────────────────────────
  console.log('[amac-runner] Publicando reporte en Slack canal ' + reportChan + '...');
  try {
    await reporter.publishWeeklyReport({
      slackToken,
      channel:         reportChan,
      tenant,
      weekLabel,
      kpis,
      analysis,
      knowledgeResult,
      issuesCreated
    });
  } catch (e) {
    console.error('[amac-runner] Error reporte Slack:', e.message);
  }

  console.log('[amac-runner] ✅ Ciclo AMAC completado — ' + weekLabel);
}

// ── Cron semanal ──────────────────────────────────────────────────────────────

function startCron(amacConfig, tenant) {
  const schedule = amacConfig?.cronSchedule || '0 18 * * 5'; // Viernes 18:00
  const tz       = amacConfig?.cronTimezone  || 'America/Santiago';

  console.log('[amac-runner] Cron AMAC programado: ' + schedule + ' (' + tz + ')');

  const job = new CronJob(schedule, async () => {
    console.log('[amac-runner] Cron disparado —', new Date().toISOString());
    try {
      await run(tenant, amacConfig);
    } catch (e) {
      console.error('[amac-runner] Error en ciclo cron:', e.message);
    }
  }, null, true, tz);

  job.start();
}

module.exports = { run, startCron };
