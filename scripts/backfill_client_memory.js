/**
 * scripts/backfill_client_memory.js — FASE 2 (backfill memoria durable)
 *
 * Lee el dump de conversaciones de Slack (FASE 1) y, por cada teléfono, resume
 * cada hilo (sesión) y FUSIONA el resultado con el documento de memoria durable
 * `yeppo:mem:<teléfono>` usando core/client-memory.js.
 *
 * ⚠️ POR DEFECTO CORRE EN DRY-RUN: no escribe en Redis ni en disco. Para
 *    escribir de verdad hay que pasar --apply.
 *
 * Requisitos:
 *   - Correr DENTRO de Railway (necesita REDIS_URL y las API keys del servicio;
 *     redis.railway.internal NO es resoluble desde fuera).
 *
 * Uso:
 *   node scripts/backfill_client_memory.js --input out/slack_conversaciones_2026-09-28/conversaciones.json
 *   node scripts/backfill_client_memory.js --input ... --apply
 *   # opciones: --limit N  --since YYYY-MM-DD  --min-msgs N  --no-llm  --tenant yeppo
 */

const fs   = require('fs');
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return (v && !v.startsWith('--')) ? v : true;
}
const APPLY     = !!arg('apply', false);
const NO_LLM    = !!arg('no-llm', false);
const LIMIT     = Number(arg('limit', 0)) || 0;
const MIN_MSGS  = Number(arg('min-msgs', 3));
const SINCE     = arg('since', null);   // 'YYYY-MM-DD'
const TENANT    = arg('tenant', process.env.TENANT || 'yeppo');
const INPUT     = arg('input', path.join(__dirname, '..', 'out',
  'slack_conversaciones_' + new Date().toISOString().slice(0, 10), 'conversaciones.json'));

process.env.TENANT = TENANT;

const mem      = require('../core/memory');          // Redis (REDIS_URL)
const clientMem = require('../core/client-memory');  // memoria durable

const ROLE_MAP = { cliente: 'user', bot: 'bot', agente: 'human', sistema: 'system' };

function buildHistory(thread) {
  return thread.mensajes
    .filter((m) => ROLE_MAP[m.role] && ROLE_MAP[m.role] !== 'system' && m.text && m.text.trim())
    .map((m) => ({ role: ROLE_MAP[m.role], text: m.text, ts: m.ts }))
    .sort((a, b) => a.ts - b.ts);
}

async function main() {
  console.log(`modo: ${APPLY ? 'APPLY (escribe Redis)' : 'DRY-RUN (no escribe nada)'} · tenant=${TENANT}`);
  if (!fs.existsSync(INPUT)) { console.error('No existe input:', INPUT); process.exit(1); }
  const dump = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
  let convos = dump.conversaciones.filter((c) => c.phone && c.mensajes && c.mensajes.length);
  if (SINCE) {
    const sinceMs = new Date(SINCE + 'T00:00:00Z').getTime();
    convos = convos.filter((c) => (c.firstTs || 0) >= sinceMs);
  }
  console.log(`conversaciones con teléfono: ${convos.length}`);

  if (!APPLY) {
    // Aislamiento total: sin Redis y con espejo en disco temporal.
    clientMem._setRedisProvider(() => null);
    clientMem._setMemoryDir(path.join(__dirname, '..', 'out', '_dryrun_memdir'));
  } else {
    await mem.waitForRedis(15000);
    const r = mem.getRedisClient();
    console.log('redis:', r ? 'conectado ✅' : 'NO conectado ❌ (abortar)');
    if (!r) process.exit(2);
  }

  // Agrupar por teléfono, threads ordenados cronológicamente
  const byPhone = new Map();
  for (const c of convos) {
    if (!byPhone.has(c.phone)) byPhone.set(c.phone, []);
    byPhone.get(c.phone).push(c);
  }
  let phones = [...byPhone.keys()];
  if (LIMIT) phones = phones.slice(0, LIMIT);

  const preview = [];
  let okPhones = 0, skipped = 0, sessions = 0, llmCalls = 0;

  for (const phone of phones) {
    const threads = byPhone.get(phone).sort((a, b) => (a.firstTs || 0) - (b.firstTs || 0));
    let doc = APPLY ? await clientMem.getMemoryDoc(phone) : null;
    let touched = false;

    for (const t of threads) {
      const history = buildHistory(t);
      if (history.length < MIN_MSGS) { skipped++; continue; }

      let summary = null;
      if (NO_LLM) {
        summary = { nombre: null, preferencias: [], productos: [], temasRecurrentes: [],
          objeciones: [], pendientes: [], resumenBreve: `[no-llm] ${history.length} msgs` };
      } else {
        llmCalls++;
        summary = await clientMem.summarizeSession(history);
      }
      if (!summary) { skipped++; continue; }

      doc = clientMem.mergeMemoryDoc(doc, summary, {
        phone,
        msgs: history.length,
        lastSummarizedTs: t.lastTs || Date.now(),
        lastInteraction: { at: t.lastTs || Date.now(), channel: 'whatsapp' },
      });
      touched = true;
      sessions++;
    }

    if (touched) {
      okPhones++;
      if (APPLY) await clientMem.saveMemoryDoc(phone, doc);
      else preview.push(doc);
    }
  }

  if (!APPLY) {
    const outPreview = path.join(path.dirname(INPUT), 'memoria_preview.json');
    fs.writeFileSync(outPreview, JSON.stringify(preview, null, 2), 'utf8');
    console.log(`\npreview (${preview.length} docs) → ${outPreview}`);
    const sample = preview[0];
    if (sample) {
      const mask = (s) => String(s).replace(/\d{4,}/g, '****');
      console.log('ejemplo (teléfono enmascarado):');
      console.log(JSON.stringify({
        phone: mask(sample.phone), sessions: sample.sessions,
        fields: sample.fields, resumenBreve: sample.resumenBreve,
      }, null, 2).slice(0, 900));
    }
    // Validación de claves
    console.log('clave de ejemplo:', clientMem.memKey('56900000000'));
  }

  console.log('\n=== backfill', APPLY ? 'APLICADO' : 'DRY-RUN', '===');
  console.log(JSON.stringify({ telefonos: phones.length, telefonos_con_doc: okPhones,
    sesiones_resumidas: sessions, hilos_omitidos: skipped, llamadas_llm: llmCalls }, null, 2));
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
