/**
 * core/github-issues.js
 *
 * Crea issues automáticos en el repo claw-platform-backlog
 * cuando AMAC detecta feature requests o mejoras operacionales.
 */

'use strict';

const axios = require('axios');

const BACKLOG_REPO = process.env.GITHUB_BACKLOG_REPO || 'Programaemprender/claw-platform-backlog';

/**
 * Crea un issue en el backlog para una feature request detectada por AMAC.
 *
 * @param {string} tenant
 * @param {Object} featureRequest - { accion_manual, api_disponible, frecuencia, impacto }
 * @param {string} weekLabel - ej: "semana 2026-05-02"
 * @returns {Object|null} issue creado
 */
async function createFeatureIssue(tenant, featureRequest, weekLabel) {
  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) return null;

  const impactoLabel = featureRequest.impacto === 'alto'  ? 'priority:high'
                     : featureRequest.impacto === 'medio' ? 'priority:medium'
                     :                                      'priority:low';

  const apiText = featureRequest.api_disponible
    ? '\n\n## API Disponible\n' + featureRequest.api_disponible
    : '';

  const body = `## Detectado por AMAC — ${weekLabel}

## Problema Operacional
${featureRequest.accion_manual}

## Frecuencia
~${featureRequest.frecuencia} veces esta semana (intervenciones manuales del agente)

## Impacto Estimado
${featureRequest.impacto === 'alto' ? '🔴 Alto — automatizar reduciría significativamente la carga del equipo' :
  featureRequest.impacto === 'medio' ? '🟡 Medio' : '🟢 Bajo'}${apiText}

## Label
Detectado automáticamente por el sistema AMAC (Agente de Mejora Continua)`;

  const title = '[Bot][' + tenant + '] ' + featureRequest.accion_manual.slice(0, 70);

  try {
    const res = await axios.post(
      'https://api.github.com/repos/' + BACKLOG_REPO + '/issues',
      {
        title,
        body,
        labels: ['tenant:' + tenant, 'layer:bot', 'type:feature', impactoLabel, 'amac:auto-detected', 'status:ready']
      },
      {
        headers: {
          Authorization: 'Bearer ' + githubToken,
          'User-Agent': 'amac-bot',
          'Content-Type': 'application/json'
        }
      }
    );
    return res.data;
  } catch (e) {
    console.error('[github-issues] Error creando issue:', e.response?.data?.message || e.message);
    return null;
  }
}

/**
 * Busca si ya existe un issue similar para evitar duplicados.
 * Compara título fuzzy.
 */
async function issueExists(title) {
  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) return false;

  try {
    const res = await axios.get(
      'https://api.github.com/repos/' + BACKLOG_REPO + '/issues',
      {
        params: { state: 'open', labels: 'amac:auto-detected', per_page: 50 },
        headers: { Authorization: 'Bearer ' + githubToken, 'User-Agent': 'amac-bot' }
      }
    );
    const titleLower = title.toLowerCase().slice(0, 50);
    return res.data.some(issue => issue.title.toLowerCase().includes(titleLower));
  } catch { return false; }
}

/**
 * Procesa todos los feature requests de un ciclo AMAC y crea issues nuevos.
 *
 * @param {string} tenant
 * @param {Array}  featureRequests
 * @param {string} weekLabel
 * @returns {Array} issues creados
 */
async function processFeatureRequests(tenant, featureRequests, weekLabel) {
  const created = [];

  for (const fr of featureRequests) {
    if (!fr.automatizable) continue;

    const title = '[Bot][' + tenant + '] ' + fr.accion_manual.slice(0, 70);
    const exists = await issueExists(title.slice(0, 50));

    if (exists) {
      console.log('[github-issues] Issue ya existe, skip: ' + title.slice(0, 60));
      continue;
    }

    const issue = await createFeatureIssue(tenant, fr, weekLabel);
    if (issue) {
      created.push({ number: issue.number, title: issue.title, url: issue.html_url });
      console.log('[github-issues] Issue #' + issue.number + ' creado: ' + issue.title.slice(0, 60));
    }

    await new Promise(r => setTimeout(r, 500));
  }

  return created;
}

module.exports = { createFeatureIssue, processFeatureRequests, issueExists };
