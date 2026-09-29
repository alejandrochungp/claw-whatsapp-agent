/**
 * scripts/dump_slack_convos.js — FASE 1 (read-only)
 * Baja el historial del canal de Slack del bot Yeppo y lo guarda localmente.
 *
 * Uso:
 *   node scripts/dump_slack_convos.js [--channel C05FES87S9J] [--out out/slack_conversaciones_<fecha>]
 *
 * NO escribe en Redis. NO publica nada. Solo lee Slack y escribe archivos locales.
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');

// El .secrets vive en el workspace raíz. Ojo: workspace\projects es un junction
// a D:\openclaw-offload, así que la ruta relativa se realpath-ea y no sirve.
// Usamos ruta absoluta (o SLACK_TOKEN_FILE).
function readToken() {
  const candidates = [
    process.env.SLACK_TOKEN_FILE,
    'C:\\Users\\achun\\.openclaw\\workspace\\.secrets\\slack_yeppo_user_token.txt',
    path.join(__dirname, '..', '..', '..', '.secrets', 'slack_yeppo_user_token.txt'),
    path.join(__dirname, '..', '.secrets', 'slack_yeppo_user_token.txt'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return fs.readFileSync(c, 'utf8').trim();
  }
  throw new Error('No encontré .secrets/slack_yeppo_user_token.txt');
}

const AUTH = readToken();

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const CHANNELS = [
  arg('channel', null) || 'C05FES87S9J',
];
const EXTRA    = ['C0ANJQGF2JU'];
const OUT_DIR  = arg('out', path.join(__dirname, '..', 'out', 'slack_conversaciones_' + new Date().toISOString().slice(0, 10)));

function api(method, params) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params || {}).toString();
    const opts = {
      hostname: 'slack.com',
      path: `/api/${method}${qs ? '?' + qs : ''}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${AUTH}` },
    };
    https.get(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Bad JSON from Slack: ' + data.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('Auth test...');
  const auth = await api('auth.test', {});
  console.log('auth.test =>', JSON.stringify({ ok: auth.ok, user: auth.user, team: auth.team, error: auth.error }));

  let chosen = null;
  let history = [];
  let usedChannel = null;

  for (const ch of [].concat(CHANNELS, EXTRA)) {
    if (chosen) break;
    let cursor = '';
    const all = [];
    let pageErr = null;
    do {
      const r = await api('conversations.history', { channel: ch, limit: '200', cursor });
      if (!r.ok) { pageErr = r.error; break; }
      all.push(...(r.messages || []));
      cursor = r.response_metadata && r.response_metadata.next_cursor;
      if (!cursor) break;
    } while (true);
    if (pageErr) {
      console.log(`  channel ${ch}: error ${pageErr}`);
      continue;
    }
    console.log(`  channel ${ch}: ${all.length} mensajes top-level`);
    if (all.length > 0) { chosen = ch; history = all; usedChannel = ch; }
  }

  if (!usedChannel) {
    console.log('Ningún canal accesible con mensajes.');
    return;
  }

  // Threads = mensajes con reply_count > 0 (el header) + replies donde haya.
  const threads = [];
  for (const m of history) {
    if (m.reply_count && m.reply_count > 0) {
      // paginar replies
      let cursor = '';
      const replies = [];
      do {
        const r = await api('conversations.replies', { channel: usedChannel, ts: m.ts, limit: '200', cursor });
        if (!r.ok) { console.log(`  replies ${m.ts}: ${r.error}`); break; }
        replies.push(...(r.messages || []));
        cursor = r.response_metadata && r.response_metadata.next_cursor;
        if (!cursor) break;
      } while (true);
      threads.push({ header: m, replies });
    } else {
      threads.push({ header: m, replies: [] });
    }
  }

  // ── Parseo de conversaciones ────────────────────────────────────────────────
  // Header:  "🟡 📱 *+56912345678*\n*Estado:* En curso — bot respondiendo\n\nComandos: ..."
  // Mensajes: "👤 *Cliente:* ...\n🤖 *Bot:* ..."  o  "💬 *Cliente:* ..."  o texto crudo del operador.
  const PHONE_RE = /\*\+(\d{8,15})\*/;

  function parseHeader(text) {
    const t = String(text || '');
    const phone = (t.match(PHONE_RE) || [])[1] || null;
    let e = null, status = null;
    const em = t.match(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic})/u);
    if (em) e = em[0];
    const sm = t.match(/\*Estado:\*\s*(.+)/);
    if (sm) status = sm[1].trim();
    return { phone, emoji: e, status };
  }

  function parseMsg(text, ts) {
    const t = String(text || '');
    const out = [];
    // formato con cliente+bot
    const cli = t.match(/👤\s*\*?Cliente:?\*?\s*([\s\S]*?)(?=\n?🤖|$)/);
    const bot = t.match(/🤖\s*\*?Bot:?\*?\s*([\s\S]*?)$/);
    const hop = t.match(/💬\s*\*?Cliente:?\*?\s*([\s\S]*)$/);
    if (cli && cli[1].trim()) out.push({ role: 'cliente', text: cli[1].trim() });
    if (bot && bot[1].trim()) out.push({ role: 'bot',     text: bot[1].trim() });
    if (hop && hop[1].trim()) out.push({ role: 'cliente', text: hop[1].trim() });
    if (!out.length) {
      const alert = t.match(/🚨\s*\*([^*]+)\*/);
      if (alert) out.push({ role: 'sistema', text: t.trim() });
      else out.push({ role: 'agente', text: t.trim() });
    }
    return out.map((x) => ({ ...x, ts: Number(ts) }));
  }

  const convos = threads.map(({ header, replies }) => {
    const h = parseHeader(header.text);
    const msgs = [];
    for (const r of replies) {
      if (r.ts === header.ts) continue; // el header mismo
      msgs.push(...parseMsg(r.text, r.ts));
    }
    const userMsgs = replies.filter((r) => r.ts !== header.ts && r.user);
    const firstTs = Math.min(Number(header.ts), ...replies.map((r) => Number(r.ts)));
    const lastTs  = Math.max(Number(header.ts), ...replies.map((r) => Number(r.ts)));
    return {
      phone: h.phone,
      slack_channel: usedChannel,
      header_ts: header.ts,
      header_text: header.text,
      estado: h.status,
      emoji: h.emoji,
      reply_count: header.reply_count || 0,
      agentes_slack: [...new Set(userMsgs.map((u) => u.user))],
      firstTs, lastTs,
      mensajes: msgs,
    };
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'conversaciones.json'), JSON.stringify({
    generated_at: new Date().toISOString(),
    channel: usedChannel,
    total_threads: convos.length,
    conversaciones: convos,
  }, null, 2), 'utf8');

  // ── Markdown legible ─────────────────────────────────────────────────────────
  const fmt = (ts) => new Date(Number(ts) * 1000).toISOString();
  const md = [];
  md.push(`# Conversaciones bot WhatsApp Yeppo — dump ${new Date().toISOString().slice(0, 10)}`);
  md.push(`\nCanal Slack: \`${usedChannel}\` — ${convos.length} conversaciones\n`);
  for (const c of convos) {
    md.push(`\n---\n\n## ${c.phone ? '+' + c.phone : '(sin teléfono)'} — ${c.estado || ''}`);
    md.push(`- Primer mensaje: ${fmt(c.firstTs)}`);
    md.push(`- Último mensaje: ${fmt(c.lastTs)}`);
    md.push(`- Mensajes parseados: ${c.mensajes.length} · Replies Slack: ${c.reply_count}`);
    md.push('');
    for (const m of c.mensajes) {
      md.push(`- **${m.role}** [${fmt(m.ts)}]: ${m.text.replace(/\n/g, ' ')}`);
    }
  }
  fs.writeFileSync(path.join(OUT_DIR, 'conversaciones.md'), md.join('\n'), 'utf8');

  // ── Resumen (sin PII) ────────────────────────────────────────────────────────
  const withPhone = convos.filter((c) => c.phone).length;
  const totalMsgs = convos.reduce((a, c) => a + c.mensajes.length, 0);
  const tsAll = convos.flatMap((c) => [c.firstTs, c.lastTs]).filter(Boolean);
  const summary = {
    generated_at: new Date().toISOString(),
    channel: usedChannel,
    total_conversaciones: convos.length,
    con_telefono_identificable: withPhone,
    sin_telefono: convos.length - withPhone,
    total_mensajes: totalMsgs,
    primera: tsAll.length ? fmt(Math.min(...tsAll)) : null,
    ultima: tsAll.length ? fmt(Math.max(...tsAll)) : null,
    telefonos_unicos: new Set(convos.map((c) => c.phone).filter(Boolean)).size,
    por_estado: convos.reduce((a, c) => { const k = c.estado || '(sin estado)'; a[k] = (a[k] || 0) + 1; return a; }, {}),
    threads_con_replies: convos.filter((c) => c.reply_count > 0).length,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'resumen.json'), JSON.stringify(summary, null, 2), 'utf8');

  console.log('\n=== RESUMEN (fase 1) ===');
  console.log(JSON.stringify(summary, null, 2));
  console.log('\nDump en:', OUT_DIR);
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
