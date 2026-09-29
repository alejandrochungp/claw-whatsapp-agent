/**
 * scripts/build_dump_from_cache.js — FASE 1 (read-only), paso 3
 * Lee el cache de threads (out/<dir>/threads/*.json) y produce:
 *   - conversaciones.json  (estructura por conversación)
 *   - conversaciones.md    (legible)
 *   - resumen.json         (conteos, SIN PII)
 *
 * NO escribe en Redis. NO publica nada.
 */

const fs   = require('fs');
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const OUT_DIR     = arg('out', path.join(__dirname, '..', 'out', 'slack_conversaciones_' + new Date().toISOString().slice(0, 10)));
const THREADS_DIR = path.join(OUT_DIR, 'threads');
const CHANNEL     = arg('channel', 'C05FES87S9J');

const PHONE_RE = /\*\+(\d{8,15})\*/;
// El header pierde los "\n" al llegar por API (quedan como espacios dobles),
// así que cortamos en "Comandos:" o en doble espacio o salto de línea.
const STATUS_RE = /\*Estado:\*\s*(.+?)(?:\s{2,}Comandos:|\n|$)/;

const EMOJI_MAP = {
  ':large_yellow_circle:': '🟡', ':red_circle:': '🔴', ':large_green_circle:': '🟢',
  ':white_check_mark:': '✅', ':rotating_light:': '🚨',
};

function toTs(s) { return Math.round(Number(s) * 1000); }

// Aplana shortcodes de Slack a texto legible (para el markdown)
function flatten(text) {
  return String(text || '')
    .replace(/:iphone:/g, '📱').replace(/:bust_in_silhouette:/g, '👤')
    .replace(/:robot_face:/g, '🤖').replace(/:speech_balloon:/g, '💬')
    .replace(/:rotating_light:/g, '🚨').replace(/:white_check_mark:/g, '✅')
    .replace(/:large_yellow_circle:/g, '🟡').replace(/:red_circle:/g, '🔴')
    .replace(/:large_green_circle:/g, '🟢').replace(/:customer:/g, '🧾')
    .replace(/<mailto:([^|>]+)(\|[^>]+)?>/g, '$1')
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2 ($1)');
}

function parseHeader(text) {
  const t = String(text || '');
  const phone = (t.match(PHONE_RE) || [])[1] || null;
  const sm = t.match(STATUS_RE);
  const status = sm ? sm[1].trim() : null;
  let emoji = null;
  for (const [k, v] of Object.entries(EMOJI_MAP)) if (t.startsWith(k)) { emoji = v; break; }
  const shopify = t.match(/\*Cliente Shopify identificado:\*\s*(.+)/);
  const channel = /\[IG instagram\]/.test(t) ? 'instagram' : null;
  return { phone, emoji, status, shopify: shopify ? shopify[1].trim() : null, source: channel };
}

const CMD_RE = /^(tomar|soltar|listo|urgente)\s*$/i;

// Devuelve lista de {role, text}
function parseMessage(text, isBotMsg) {
  const t = String(text || '');
  const out = [];

  // "X tomó el control" / "Resuelto por X" → evento de sistema
  const take = t.match(/^:bust_in_silhouette: \*([^*]+)\* tomó el control\./);
  if (take) return [{ role: 'sistema', text: `${take[1]} tomó el control` }];
  const resolved = t.match(/^:white_check_mark: Resuelto por \*([^*]+)\*\./);
  if (resolved) return [{ role: 'sistema', text: `Resuelto por ${resolved[1]}` }];

  const cli = t.match(/^:bust_in_silhouette: \*Cliente:\*\s*([\s\S]*?)(?=\n:robot_face:|$)/);
  const bot = t.match(/\n?:robot_face: \*Bot:\*\s*([\s\S]*?)$/);
  const fwd = t.match(/^:speech_balloon: \*Cliente:\*\s*([\s\S]*)$/);

  if (cli || bot || fwd) {
    if (cli && cli[1].trim()) out.push({ role: 'cliente', text: cli[1].trim() });
    if (fwd && fwd[1].trim()) out.push({ role: 'cliente', text: fwd[1].trim() });
    if (bot && bot[1].trim() && bot[1].trim() !== 'null') out.push({ role: 'bot', text: bot[1].trim() });
    if (out.length) return out;
  }

  if (CMD_RE.test(t)) return []; // comando de operador, no es conversación
  if (!t.trim()) return [];

  // Texto crudo: si es del bot → sistema; si es humano → agente
  return [{ role: isBotMsg ? 'sistema' : 'agente', text: t.trim() }];
}

function main() {
  if (!fs.existsSync(THREADS_DIR)) { console.error('No existe', THREADS_DIR); process.exit(1); }
  const files = fs.readdirSync(THREADS_DIR).filter((f) => f.endsWith('.json'));
  console.log('threads cache:', files.length);

  const convos = [];
  for (const f of files) {
    let replies;
    try { replies = JSON.parse(fs.readFileSync(path.join(THREADS_DIR, f), 'utf8')); }
    catch { console.log('  skip (json inválido):', f); continue; }
    if (!Array.isArray(replies) || replies.length === 0) continue;

    // El primer elemento de conversations.replies ES el header (parent)
    const header = replies[0];
    const h = parseHeader(header.text);
    const orden = replies.slice().sort((a, b) => Number(a.ts) - Number(b.ts));

    const mensajes = [];
    const agentes = new Set();
    for (const m of orden) {
      if (m.ts === header.ts) continue;
      const parsed = parseMessage(m.text, !!m.bot_id);
      for (const p of parsed) {
        if (p.role === 'agente') agentes.add(String(m.user));
        mensajes.push({ ...p, ts: toTs(m.ts), slack_user: m.user || null });
      }
    }
    const tsAll = orden.map((m) => Number(m.ts)).filter((x) => !isNaN(x));
    convos.push({
      phone: h.phone,
      slack_channel: CHANNEL,
      thread_ts: header.ts,
      header_text: flatten(header.text),
      estado: h.status,
      emoji: h.emoji,
      fuente: h.source,
      shopify: h.shopify,
      agentes_slack: [...agentes],
      firstTs: tsAll.length ? toTs(Math.min(...tsAll)) : null,
      lastTs: tsAll.length ? toTs(Math.max(...tsAll)) : null,
      mensajes,
    });
  }

  convos.sort((a, b) => (a.firstTs || 0) - (b.firstTs || 0));

  fs.writeFileSync(path.join(OUT_DIR, 'conversaciones.json'), JSON.stringify({
    generated_at: new Date().toISOString(),
    channel: CHANNEL,
    total_conversaciones: convos.length,
    conversaciones: convos,
  }, null, 2), 'utf8');

  const fmt = (ms) => (ms ? new Date(ms).toISOString() : null);
  const md = [`# Conversaciones bot WhatsApp Yeppo — dump ${new Date().toISOString().slice(0, 10)}`,
    '', `Canal Slack: \`${CHANNEL}\` — ${convos.length} conversaciones`, ''];
  for (const c of convos) {
    md.push('---', '', `## ${c.phone ? '+' + c.phone : '(sin teléfono)'} — ${c.estado || ''}`);
    if (c.shopify) md.push(`- Shopify: ${c.shopify}`);
    md.push(`- Inicio: ${fmt(c.firstTs)}`);
    md.push(`- Fin: ${fmt(c.lastTs)}`);
    md.push(`- Mensajes: ${c.mensajes.length}`);
    md.push('');
    for (const m of c.mensajes) md.push(`- **${m.role}** [${fmt(m.ts)}]: ${m.text.replace(/\n/g, ' ')}`);
    md.push('');
  }
  fs.writeFileSync(path.join(OUT_DIR, 'conversaciones.md'), md.join('\n'), 'utf8');

  const withPhone = convos.filter((c) => c.phone);
  const tsAll = convos.flatMap((c) => [c.firstTs, c.lastTs]).filter(Boolean);
  const totalMsgs = convos.reduce((a, c) => a + c.mensajes.length, 0);
  const byRole = {};
  for (const c of convos) for (const m of c.mensajes) byRole[m.role] = (byRole[m.role] || 0) + 1;
  const byEstado = {};
  for (const c of convos) { const k = c.estado || '(sin estado)'; byEstado[k] = (byEstado[k] || 0) + 1; }
  const byFuente = {};
  for (const c of convos) { const k = c.fuente || 'whatsapp'; byFuente[k] = (byFuente[k] || 0) + 1; }

  // Distribución por día (para detectar huecos)
  const byDay = {};
  for (const c of convos) {
    if (!c.firstTs) continue;
    const d = new Date(c.firstTs).toISOString().slice(0, 10);
    byDay[d] = (byDay[d] || 0) + 1;
  }

  const summary = {
    generated_at: new Date().toISOString(),
    channel: CHANNEL,
    total_conversaciones: convos.length,
    con_telefono_identificable: withPhone.length,
    telefonos_unicos: new Set(withPhone.map((c) => c.phone)).size,
    total_mensajes: totalMsgs,
    mensajes_por_rol: byRole,
    primera_conversacion: tsAll.length ? fmt(Math.min(...tsAll)) : null,
    ultima_conversacion: tsAll.length ? fmt(Math.max(...tsAll)) : null,
    por_estado: byEstado,
    por_fuente: byFuente,
    conversaciones_por_dia: byDay,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'resumen.json'), JSON.stringify(summary, null, 2), 'utf8');

  const { conversaciones_por_dia, ...rest } = summary;
  console.log('\n=== RESUMEN (fase 1) ===');
  console.log(JSON.stringify(rest, null, 2));
  const days = Object.keys(conversaciones_por_dia).sort();
  console.log('\ndías con actividad:', days.length, '|', days[0], '→', days[days.length - 1]);
  console.log('OUT_DIR=' + OUT_DIR);
}

main();
