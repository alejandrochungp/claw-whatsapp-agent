/**
 * core/knowledge-updater.js
 *
 * Aplica actualizaciones al knowledge_doc.md de un tenant.
 * - Auto-aprobado (sin intervención humana)
 * - Genera diff legible para reportar al equipo
 * - Pushea a GitHub automáticamente
 *
 * REGLAS CRÍTICAS:
 * - NO añadir recomendaciones de productos específicos para tipos de piel
 * - Solo patrones genéricos: políticas, FAQs, tono, procesos de escalación
 * - Mantener el estilo informal del equipo Yeppo
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const axios = require('axios');

const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';

function getDeepSeekKey() {
  const envKey = process.env.DEEPSEEK_API_KEY;
  if (envKey) return envKey;
  try {
    const keyPath = path.join(__dirname, '..', '..', '..', '..', '.openclaw', 'workspace', '.secrets', 'deepseek_key.txt');
    return fs.readFileSync(keyPath, 'utf8').trim();
  } catch { return null; }
}

async function callAI(messages, maxTokens = 6000) {
  const key = getDeepSeekKey();
  const res = await axios.post(
    DEEPSEEK_BASE + '/chat/completions',
    { model: 'deepseek-v4-pro', max_tokens: maxTokens, messages },
    {
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      timeout: 180000
    }
  );
  return res.data.choices[0].message.content;
}

/**
 * Actualiza el knowledge_doc.md incorporando los gaps detectados por AMAC.
 *
 * @param {string} tenant - nombre del tenant (ej: 'yeppo')
 * @param {Array}  knowledgeGaps - array de gaps detectados por amac.analyzeConversations
 * @returns {Object} { updated: bool, diff: string, newDoc: string }
 */
async function updateKnowledge(tenant, knowledgeGaps) {
  const docPath = path.join(__dirname, '..', 'tenants', tenant, 'knowledge', 'knowledge_doc.md');

  if (!fs.existsSync(docPath)) {
    throw new Error('knowledge_doc.md no encontrado para tenant: ' + tenant);
  }

  const currentDoc = fs.readFileSync(docPath, 'utf8');

  if (!knowledgeGaps || knowledgeGaps.length === 0) {
    return { updated: false, diff: 'Sin cambios — no se detectaron gaps de conocimiento.', newDoc: currentDoc };
  }

  // Filtrar solo gaps con suficiente calidad
  const validGaps = knowledgeGaps.filter(kg =>
    kg.update_sugerido &&
    kg.update_sugerido.length > 20 &&
    // Filtro extra: no incluir recomendaciones de productos específicos para tipos de piel
    !/(piel grasa|piel seca|piel mixta|piel sensible|para tu tipo de piel)/i.test(kg.update_sugerido)
  );

  if (!validGaps.length) {
    return { updated: false, diff: 'Sin cambios — gaps detectados no pasaron filtro de calidad.', newDoc: currentDoc };
  }

  const gapsText = validGaps.map((kg, i) =>
    `${i+1}. TIPO: ${kg.tipo}\n   PREGUNTA: ${kg.pregunta_cliente}\n   ACTUALIZACIÓN: ${kg.update_sugerido}`
  ).join('\n\n');

  const newDoc = await callAI([
    {
      role: 'system',
      content: 'Eres el mantenedor del documento de conocimiento del bot de WhatsApp de Yeppo. Tu trabajo es actualizar el documento incorporando nueva información detectada en conversaciones reales. Responde SOLO con el documento actualizado completo, sin comentarios adicionales, sin markdown extra, en texto plano.'
    },
    {
      role: 'user',
      content: `Tengo el documento de conocimiento actual del bot de Yeppo y una lista de actualizaciones detectadas esta semana en conversaciones reales.

DOCUMENTO ACTUAL:
${currentDoc}

ACTUALIZACIONES A INCORPORAR:
${gapsText}

INSTRUCCIONES:
1. Incorpora las actualizaciones al documento existente de forma coherente
2. Si es una nueva FAQ, agrégala a la sección PREGUNTAS FRECUENTES manteniendo el tono informal ("holi", "dale", etc.)
3. Si es una nueva política, agrégala a POLITICAS OPERATIVAS
4. Si es un nuevo criterio de escalación, agrégalo a CUANDO DERIVAR A HUMANO
5. NO elimines información existente a menos que sea claramente incorrecta
6. NO añadir recomendaciones de productos específicos para ciertos tipos de piel (eso lo maneja el bot dinámicamente)
7. Mantén el mismo formato de texto plano sin markdown
8. Devuelve el documento COMPLETO actualizado`
    }
  ], 8192);

  // Calcular diff simple (líneas nuevas)
  const oldLines = new Set(currentDoc.split('\n').map(l => l.trim()).filter(Boolean));
  const newLines = newDoc.split('\n').map(l => l.trim()).filter(Boolean);
  const addedLines = newLines.filter(l => !oldLines.has(l) && l.length > 10);

  const diff = addedLines.length > 0
    ? `${addedLines.length} líneas nuevas agregadas:\n` + addedLines.slice(0, 10).map(l => '+ ' + l).join('\n')
    : 'Documento reorganizado sin contenido nuevo significativo.';

  // Guardar el nuevo documento
  fs.writeFileSync(docPath, newDoc, 'utf8');

  // Actualizar stats
  const statsPath = path.join(__dirname, '..', 'tenants', tenant, 'knowledge', 'knowledge_stats.json');
  const stats = fs.existsSync(statsPath) ? JSON.parse(fs.readFileSync(statsPath, 'utf8')) : {};
  stats.lastAmacUpdate = new Date().toISOString();
  stats.amacUpdatesTotal = (stats.amacUpdatesTotal || 0) + 1;
  stats.docLength = newDoc.length;
  fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2), 'utf8');

  return { updated: true, diff, newDoc };
}

/**
 * Pushea los cambios del knowledge al repo GitHub via API.
 */
async function pushToGitHub(tenant, newDoc, summary) {
  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) {
    console.log('[knowledge-updater] GITHUB_TOKEN no configurado — skip push');
    return false;
  }

  const repo     = process.env.GITHUB_REPO || 'alejandrochungp/claw-whatsapp-agent';
  const filePath = 'tenants/' + tenant + '/knowledge/knowledge_doc.md';

  try {
    // Obtener SHA actual
    const fileRes = await axios.get(
      'https://api.github.com/repos/' + repo + '/contents/' + filePath,
      { headers: { Authorization: 'Bearer ' + githubToken, 'User-Agent': 'amac-bot' } }
    );

    const content = Buffer.from(newDoc, 'utf8').toString('base64');
    await axios.put(
      'https://api.github.com/repos/' + repo + '/contents/' + filePath,
      {
        message: 'amac: knowledge update - ' + summary.slice(0, 80),
        content,
        sha: fileRes.data.sha
      },
      { headers: { Authorization: 'Bearer ' + githubToken, 'User-Agent': 'amac-bot', 'Content-Type': 'application/json' } }
    );

    console.log('[knowledge-updater] ✅ Pusheado a GitHub');
    return true;
  } catch (e) {
    console.error('[knowledge-updater] Error push GitHub:', e.response?.data?.message || e.message);
    return false;
  }
}

module.exports = { updateKnowledge, pushToGitHub };
