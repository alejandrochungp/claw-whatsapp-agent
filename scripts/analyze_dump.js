const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, '..', 'out', 'slack_conversaciones_2026-09-28');
const dump = JSON.parse(fs.readFileSync(path.join(OUT, 'conversaciones.json'), 'utf8'));
const convos = dump.conversaciones;

const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const byDay = {};
for (const c of convos) { if (!c.firstTs) continue; const d = day(c.firstTs); byDay[d] = (byDay[d] || 0) + 1; }
const days = Object.keys(byDay).sort();
const first = days[0], last = days[days.length - 1];

// gaps
const gaps = [];
let d = new Date(first + 'T00:00:00Z');
const end = new Date(last + 'T00:00:00Z');
while (d <= end) {
  const k = d.toISOString().slice(0, 10);
  if (!byDay[k]) gaps.push(k);
  d = new Date(d.getTime() + 86400000);
}

// por teléfono
const byPhone = {};
for (const c of convos) { if (c.phone) (byPhone[c.phone] = byPhone[c.phone] || []).push(c); }
const phones = Object.keys(byPhone);
const msgCounts = phones.map((p) => byPhone[p].reduce((a, c) => a + c.mensajes.length, 0)).sort((a, b) => a - b);
const with3 = phones.filter((p) => byPhone[p].reduce((a, c) => a + c.mensajes.length, 0) >= 3).length;
const multiThread = phones.filter((p) => byPhone[p].length > 1).length;

// mensajes con texto vacío / bot=null
let botNull = 0, clienteVacio = 0;
for (const c of convos) for (const m of c.mensajes) {
  if (m.role === 'bot' && (!m.text || m.text === 'null')) botNull++;
  if (m.role === 'cliente' && !m.text) clienteVacio++;
}

// conversaciones sin teléfono: qué son
const noPhone = convos.filter((c) => !c.phone);
const noPhoneHeaders = {};
for (const c of noPhone) {
  const k = (c.header_text || '').slice(0, 60);
  noPhoneHeaders[k] = (noPhoneHeaders[k] || 0) + 1;
}

// horas del día
const byHour = {};
for (const c of convos) { if (!c.firstTs) continue; const h = new Date(c.firstTs).getUTCHours(); byHour[h] = (byHour[h] || 0) + 1; }

const median = msgCounts.length ? msgCounts[Math.floor(msgCounts.length / 2)] : 0;

console.log(JSON.stringify({
  rango: { first, last, span_dias: days.length },
  dias_con_actividad: days.length,
  dias_sin_actividad: gaps.length,
  huecos: gaps.length <= 40 ? gaps : gaps.slice(0, 40).concat(['...']),
  telefonos: { total: phones.length, con_3_o_mas_msgs: with3, con_multiples_hilos: multiThread,
    msgs_mediana: median, msgs_max: msgCounts[msgCounts.length - 1], msgs_min: msgCounts[0] },
  sin_telefono: { total: noPhone.length, ejemplos_header: Object.entries(noPhoneHeaders).sort((a,b)=>b[1]-a[1]).slice(0,5) },
  calidad: { bot_texto_null: botNull, cliente_sin_texto: clienteVacio },
  por_dia_top: Object.entries(byDay).sort((a,b)=>b[1]-a[1]).slice(0,5),
  por_dia_bottom: Object.entries(byDay).sort((a,b)=>a[1]-b[1]).slice(0,5),
  primera_semana: days.slice(0,7).map(k => k + ':' + byDay[k]),
  ultima_semana: days.slice(-7).map(k => k + ':' + byDay[k]),
}, null, 2));
