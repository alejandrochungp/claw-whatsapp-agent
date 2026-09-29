/**
 * scripts/fetch_slack_threads.js — FASE 1 (read-only), paso 2
 * Baja conversations.replies para cada thread del canal y cachea a disco (resumible).
 *
 * Uso: node scripts/fetch_slack_threads.js --channel C05FES87S9J --out out/slack_conversaciones_<fecha>
 * NO escribe en Redis. NO publica nada.
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');

function readToken() {
  const candidates = [
    process.env.SLACK_TOKEN_FILE,
    'C:\\Users\\achun\\.openclaw\\workspace\\.secrets\\slack_yeppo_user_token.txt',
    path.join(__dirname, '..', '..', '..', '.secrets', 'slack_yeppo_user_token.txt'),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return fs.readFileSync(c, 'utf8').trim();
  throw new Error('No encontré .secrets/slack_yeppo_user_token.txt');
}
const AUTH = readToken();

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const CHANNEL = arg('channel', 'C05FES87S9J');
const OUT_DIR = arg('out', path.join(__dirname, '..', 'out', 'slack_conversaciones_' + new Date().toISOString().slice(0, 10)));
const THREADS_DIR = path.join(OUT_DIR, 'threads');
fs.mkdirSync(THREADS_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rawApi(method, params) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params || {}).toString();
    https.get({
      hostname: 'slack.com',
      path: `/api/${method}?${qs}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${AUTH}` },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* ignore */ }
        resolve({ status: res.statusCode, retryAfter: Number(res.headers['retry-after'] || 0), json, raw: data });
      });
    }).on('error', reject);
  });
}

let callCount = 0;
async function api(method, params) {
  let attempt = 0;
  for (;;) {
    const r = await rawApi(method, params);
    callCount++;
    if (r.json && r.json.ok) return r.json;
    const err = (r.json && r.json.error) || `http_${r.status}`;
    if (err === 'ratelimited' || r.status === 429) {
      const wait = (r.retryAfter || 20) * 1000 + 1000;
      attempt++;
      if (attempt % 5 === 1) console.log(`  [ratelimit] esperando ${Math.round(wait / 1000)}s (llamadas=${callCount})`);
      await sleep(wait);
      continue;
    }
    if (attempt < 3) { attempt++; await sleep(1500 * attempt); continue; }
    return { ok: false, error: err };
  }
}

async function main() {
  const auth = await api('auth.test', {});
  console.log('auth.test =>', JSON.stringify({ ok: auth.ok, user: auth.user, team: auth.team, error: auth.error }));

  // 1. history paginado
  let cursor = '';
  const history = [];
  do {
    const r = await api('conversations.history', { channel: CHANNEL, limit: '200', cursor });
    if (!r.ok) { console.log('history error:', r.error); break; }
    history.push(...(r.messages || []));
    cursor = r.response_metadata && r.response_metadata.next_cursor;
    if (!cursor) break;
  } while (true);
  console.log(`history: ${history.length} mensajes top-level`);

  const threadHeaders = history.filter((m) => (m.reply_count || 0) > 0);
  console.log(`threads con replies: ${threadHeaders.length} / ${history.length}`);

  // 2. replies por thread (cacheado)
  let done = 0, cached = 0, failed = 0;
  const t0 = Date.now();
  for (const h of threadHeaders) {
    const cacheFile = path.join(THREADS_DIR, `${h.ts}.json`);
    if (fs.existsSync(cacheFile)) { cached++; done++; continue; }
    let cursor2 = '';
    const replies = [];
    let ok = true;
    do {
      const r = await api('conversations.replies', { channel: CHANNEL, ts: h.ts, limit: '200', cursor: cursor2 });
      if (!r.ok) { ok = false; console.log(`  replies ${h.ts}: ${r.error}`); break; }
      replies.push(...(r.messages || []));
      cursor2 = r.response_metadata && r.response_metadata.next_cursor;
      if (!cursor2) break;
    } while (true);
    if (ok) fs.writeFileSync(cacheFile, JSON.stringify(replies), 'utf8');
    else failed++;
    done++;
    if (done % 50 === 0) {
      const mins = ((Date.now() - t0) / 60000).toFixed(1);
      console.log(`  progreso: ${done}/${threadHeaders.length} (cached=${cached}, fallidos=${failed}, ${mins} min, llamadas=${callCount})`);
    }
  }

  fs.writeFileSync(path.join(OUT_DIR, 'history.json'), JSON.stringify(history, null, 2), 'utf8');
  console.log(`\nListo. threads=${threadHeaders.length} cacheados=${cached} fallidos=${failed} llamadas=${callCount}`);
  console.log('OUT_DIR=' + OUT_DIR);
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
