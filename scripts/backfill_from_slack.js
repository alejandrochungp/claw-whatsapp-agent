/**
 * scripts/backfill_from_slack.js — FASE 2 (autocontenido, pensado para Railway)
 *
 * Hace TODO dentro del contenedor: baja los hilos de Slack, resume cada sesión
 * y escribe/fusiona el documento `yeppo:mem:<teléfono>` en Redis.
 *
 * ⚠️ SEGURO POR DEFECTO: sin `--apply` corre en DRY-RUN (no escribe en Redis,
 *    usa un cliente Redis nulo y un espejo de disco temporal). Recién con
 *    `--apply` escribe de verdad.
 *
 * Por qué autocontenido: Redis vive en la red privada de Railway
 * (redis.railway.internal), así que no se puede correr desde la PC. Además así
 * NO hay que mover el dump con PII de clientes al contenedor.
 *
 * Requiere en el entorno (ya están en el servicio): SLACK_BOT_TOKEN, REDIS_URL,
 * TENANT, DEEPSEEK_API_KEY y/o CLAUDE_API_KEY.
 *
 * Uso dentro del contenedor:
 *   node scripts/backfill_from_slack.js                       # dry-run, todo
 *   node scripts/backfill_from_slack.js --limit 20            # dry-run, 20 tel
 *   node scripts/backfill_from_slack.js --apply --limit 20    # escribe 20
 *   node scripts/backfill_from_slack.js --apply               # escribe todo
 *   # extras: --channel <id> --since YYYY-MM-DD --min-msgs N --no-llm
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return (v && !v.startsWith('--')) ? v : true;
}

const APPLY    = !!arg('apply', false);
const NO_LLM   = !!arg('no-llm', false);
const LIMIT    = Number(arg('limit', 0)) || 0;
const MIN_MSGS = Number(arg('min-msgs', 3));
const SINCE    = arg('since', null);
const TENANT   = process.env.TENANT || 'yeppo';
const CHANNEL  = arg('channel', process.env.SLACK_CHANNEL_ID || 'C05FES87S9J');
const AUTH     = process.env.SLACK_BOT_TOKEN || process.env.SLACK_USER_TOKEN;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rawApi(method, params) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params || {}).toString();
    https.get({ hostname: 'slack.com', path: `/api/${method}?${qs}`,
      headers: { Authorization: `Bearer ${AUTH}` } }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch {}
        resolve({ status: res.statusCode, retryAfter: Number(res.headers['retry-after'] || 0), json: j }); });
    }).on('error', reject);
  });
}

async function api(method, params) {
  let attempt = 0;
  for (;;) {
    const r = await rawApi(method, params);
    const err = (r.json && r.json.error) || `http_${r.status}`;
    if (r.json && r.json.ok) return r.json;
    if (err === 'ratelimited' || r.status === 429) {
      await sleep((r.retryAfter || 20) * 1000 + 1000); attempt++; continue;
    }
    if (attempt < 3) { attempt++; await sleep(1500 * attempt); continue; }
    return { ok: false, error: err };
  }
}

// ── Parsers (mismo formato que usó la FASE 1) ────────────────────────────────
const PHONE_RE  = /\*\+(\d{8,15})\*/;
const STATUS_RE = /\*Estado:\*\s*(.+?)(?:\s{2,}Comandos:|\n|$)/;
const CMD_RE    = /^(tomar|soltar|listo|urgente)\s*$/i;
const ROLE_MAP  = { cliente: 'user', bot: 'bot', agente: 'human' };

function parseHeader(text) {
  const t = String(text || '');
  const phone = (t.match(PHONE_RE) || [])[1] || null;
  const sm = t.match(STATUS_RE);
  return { phone, status: sm ? sm[1].trim() : null };
}

function parseMessage(text, isBotMsg) {
  const t = String(text || '');
  const take = t.match(/^:bust_in_silhouette: \*([^*]+)\* tomó el control\./);
  if (take) return [];
  const resolved = t.match(/^:white_check_mark: Resuelto por \*[^*]+\*\./);
  if (resolved) return [];
  const cli = t.match(/^:bust_in_silhouette: \*Cliente:\*\s*([\s\S]*?)(?=\n:robot_face:|$)/);
  const bot = t.match(/\n?:robot_face: \*Bot:\*\s*([\s\S]*?)$/);
  const fwd = t.match(/^:speech_balloon: \*Cliente:\*\s*([\s\S]*)$/);
  if (cli || bot || fwd) {
    const out = [];
    if (cli && cli[1].trim()) out.push({ role: 'cliente', text: cli[1].trim() });
    if (fwd && fwd[1].trim()) out.push({ role: 'cliente', text: fwd[1].trim() });
    if (bot && bot[1].trim() && bot[1].trim() !== 'null') out.push({ role: 'bot', text: bot[1].trim() });
    return out;
  }
  if (CMD_RE.test(t) || !t.trim()) return [];
  return [{ role: isBotMsg ? 'sistema' : 'agente', text: t.trim() }];
}

function threadToHistory(replies, headerTs) {
  const msgs = [];
  for (const m of replies.slice().sort((a, b) => Number(a.ts) - Number(b.ts))) {
    if (m.ts === headerTs) continue;
    for (const p of parseMessage(m.text, !!m.bot_id)) {
      const role = ROLE_MAP[p.role];
      if (!role || !p.text) continue;
      msgs.push({ role, text: p.text, ts: Math.round(Number(m.ts) * 1000) });
    }
  }
  return msgs;
}

async function main() {
  if (!AUTH) { console.error('Falta SLACK_BOT_TOKEN en el entorno.'); process.exit(1); }
  console.log(`modo: ${APPLY ? 'APPLY (escribe Redis)' : 'DRY-RUN (no escribe nada)'} · tenant=${TENANT} · canal=${CHANNEL}`);

  const mem       = require('../core/memory');
  const clientMem = require('../core/client-memory');

  if (!APPLY) {
    clientMem._setRedisProvider(() => null);
    clientMem._setMemoryDir(path.join(require('os').tmpdir(), 'bf-dryrun'));
  } else {
    await mem.waitForRedis(20000);
    if (!mem.getRedisClient()) { console.error('Redis no conectado — abortando.'); process.exit(2); }
  }

  // 1. history
  let cursor = ''; const threads = [];
  do {
    const r = await api('conversations.history', { channel: CHANNEL, limit: '200', cursor });
    if (!r.ok) { console.error('history:', r.error); process.exit(3); }
    for (const m of r.messages || []) if ((m.reply_count || 0) > 0 || m.thread_ts) threads.push({ ts: m.thread_ts || m.ts });
    cursor = r.response_metadata && r.response_metadata.next_cursor;
  } while (cursor);
  console.log(`headers encontrados: ${threads.length}`);

  // 2. por teléfono
  const byPhone = new Map();
  let i = 0;
  for (const t of threads) {
    i++;
    if (i % 100 === 0) console.log(`  bajando ${i}/${threads.length}...`);
    let cur = ''; const replies = [];
    do {
      const r = await api('conversations.replies', { channel: CHANNEL, ts: t.ts, limit: '200', cursor: cur });
      if (!r.ok) break;
      replies.push(...(r.messages || []));
      cur = r.response_metadata && r.response_metadata.next_cursor;
    } while (cur);
    if (!replies.length) continue;
    const h = parseHeader(replies[0].text);
    if (!h.phone) continue;                     // ignora hilos de Instagram u otros sin teléfono
    const history = threadToHistory(replies, replies[0].ts);
    if (!history.length) continue;
    if (SINCE && history[0].ts < Date.parse(SINCE + 'T00:00:00Z')) continue;
    if (!byPhone.has(h.phone)) byPhone.set(h.phone, []);
    byPhone.get(h.phone).push({ history, lastTs: history[history.length - 1].ts });
  }

  let phones = [...byPhone.keys()];
  if (LIMIT) phones = phones.slice(0, LIMIT);
  console.log(`teléfonos con hilos: ${byPhone.size} · procesando: ${phones.length}`);

  // 3. resumir + fusionar
  const preview = []; let ok = 0, sessions = 0, skipped = 0, llm = 0;
  for (const phone of phones) {
    const ses = byPhone.get(phone).sort((a, b) => a.lastTs - b.lastTs);
    let doc = APPLY ? await clientMem.getMemoryDoc(phone) : null;
    let touched = false;
    for (const s of ses) {
      if (s.history.length < MIN_MSGS) { skipped++; continue; }
      let summary;
      if (NO_LLM) { summary = { nombre: null, preferencias: [], productos: [], temasRecurrentes: [],
        objeciones: [], pendientes: [], resumenBreve: `[no-llm] ${s.history.length} msgs` }; }
      else { llm++; summary = await clientMem.summarizeSession(s.history); }
      if (!summary) { skipped++; continue; }
      doc = clientMem.mergeMemoryDoc(doc, summary, { phone, msgs: s.history.length,
        lastSummarizedTs: s.lastTs, lastInteraction: { at: s.lastTs, channel: 'whatsapp' } });
      touched = true; sessions++;
    }
    if (touched) { ok++; if (APPLY) await clientMem.saveMemoryDoc(phone, doc); else preview.push(doc); }
  }

  if (!APPLY) {
    const p = path.join(require('os').tmpdir(), 'bf-preview.json');
    fs.writeFileSync(p, JSON.stringify(preview, null, 2));
    console.log(`preview (${preview.length}) → ${p}`);
  }

  console.log('\n=== backfill', APPLY ? 'APLICADO' : 'DRY-RUN', '===');
  console.log(JSON.stringify({ telefonos_procesados: phones.length, telefonos_con_doc: ok,
    sesiones_resumidas: sessions, hilos_omitidos: skipped, llamadas_llm: llm }, null, 2));
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
