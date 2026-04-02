/**
 * apply_learning.js
 * Lee reacciones del thread de learning en Slack y agrega las ✅ aprobadas al prompt.md
 * 
 * Uso: node apply_learning.js <thread_ts>
 * Ejemplo: node apply_learning.js 1774563580.976759
 */
const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

const SLACK_TOKEN      = fs.readFileSync(path.join(__dirname, '../../.secrets/slack_yeppo_token.txt'), 'utf8').trim();
const LEARNING_CHANNEL = 'C0APVLMV98Q';
const PROMPT_PATH      = path.join(__dirname, 'tenants/yeppo/prompt.md');

const thread_ts = process.argv[2] || '1774563580.976759';

async function main() {
  console.log(`Leyendo thread ${thread_ts}...`);

  // 1. Obtener todos los mensajes del thread
  const r = await axios.get('https://slack.com/api/conversations.replies', {
    params: { channel: LEARNING_CHANNEL, ts: thread_ts, limit: 50 },
    headers: { Authorization: `Bearer ${SLACK_TOKEN}` }
  });

  if (!r.data.ok) {
    console.error('Error Slack:', r.data.error);
    process.exit(1);
  }

  const msgs = r.data.messages || [];
  console.log(`Mensajes en thread: ${msgs.length}`);

  // 2. Filtrar los que tienen reacción ✅ (white_check_mark)
  const approved = msgs.filter(m => 
    m.reactions?.some(rx => rx.name === 'white_check_mark' || rx.name === 'heavy_check_mark')
  );
  const rejected = msgs.filter(m =>
    m.reactions?.some(rx => rx.name === 'x' || rx.name === 'negative_squared_cross_mark')
  );

  console.log(`Aprobadas: ${approved.length} | Rechazadas: ${rejected.length} | Sin reacción: ${msgs.length - approved.length - rejected.length - 1}`);

  if (approved.length === 0) {
    console.log('No hay sugerencias aprobadas aún. Reacciona con ✅ en Slack primero.');
    return;
  }

  // 3. Extraer respuestas sugeridas de los mensajes aprobados
  const newLearnings = [];
  for (const msg of approved) {
    // Parsear el texto del mensaje (formato: "💄 *Sugerencia N/M* — CATEGORIA\n\n*Situación:*...\n\n*Respuesta sugerida:*\n_texto_")
    const situacionMatch = msg.text.match(/\*Situación:\*\s*([^\n]+)/);
    const respuestaMatch = msg.text.match(/\*Respuesta sugerida para el bot:\*\s*\n_(.+?)_/s);
    const categoriaMatch = msg.text.match(/— ([A-Z]+)\n/);

    if (respuestaMatch) {
      newLearnings.push({
        situacion: situacionMatch?.[1]?.trim() || 'Sin descripción',
        respuesta: respuestaMatch[1].trim(),
        categoria: categoriaMatch?.[1]?.toLowerCase() || 'otros'
      });
    }
  }

  if (newLearnings.length === 0) {
    console.log('No se pudieron parsear las respuestas aprobadas.');
    return;
  }

  console.log(`\nAgregando ${newLearnings.length} aprendizajes al prompt...\n`);

  // 4. Leer prompt actual
  let prompt = fs.readFileSync(PROMPT_PATH, 'utf8');

  // 5. Buscar o crear sección de aprendizajes
  const LEARNING_HEADER = '\n\nAPRENDIZAJES DEL EQUIPO\n\nEstas son respuestas reales del equipo aprobadas para situaciones específicas:\n\n';
  const LEARNING_MARKER = 'APRENDIZAJES DEL EQUIPO';

  let learningSection = '';
  newLearnings.forEach((l, i) => {
    learningSection += `Situación: ${l.situacion}\nRespuesta: ${l.respuesta}\n\n`;
    console.log(`  ${i + 1}. [${l.categoria}] ${l.situacion.substring(0, 60)}...`);
  });

  if (prompt.includes(LEARNING_MARKER)) {
    // Agregar a la sección existente (antes del final)
    prompt = prompt.replace(
      /(APRENDIZAJES DEL EQUIPO[\s\S]*?)(\n{2,}[A-Z]+|\s*$)/,
      (match, section, after) => section + learningSection + after
    );
  } else {
    // Crear sección nueva al final
    prompt += LEARNING_HEADER + learningSection;
  }

  // 6. Guardar prompt actualizado
  fs.writeFileSync(PROMPT_PATH, prompt, 'utf8');
  console.log(`\n✅ Prompt actualizado con ${newLearnings.length} aprendizajes`);
  console.log(`   Tamaño: ${prompt.length} chars`);

  // 7. Pushear a GitHub para que Railway lo cargue
  const { execSync } = require('child_process');
  try {
    process.chdir(path.join(__dirname));
    execSync('git add tenants/yeppo/prompt.md', { stdio: 'pipe' });
    execSync(`git commit -m "learning: agregar ${newLearnings.length} respuestas aprobadas del equipo"`, { stdio: 'pipe' });
    execSync('git push', { stdio: 'pipe' });
    console.log('   Pusheado a GitHub ✅ — Railway cargará el nuevo prompt en el próximo reinicio');
  } catch (e) {
    console.log('   Push manual necesario: git add + commit + push');
  }

  // 8. Notificar en el thread de Slack
  await axios.post('https://slack.com/api/chat.postMessage', {
    channel: LEARNING_CHANNEL,
    thread_ts,
    text: `✅ *${newLearnings.length} aprendizaje(s) agregados al bot*\n\nLas respuestas aprobadas ya están en el prompt. El bot las usará como referencia en conversaciones similares.`
  }, { headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' } });
}

main().catch(e => console.error('Error:', e.response?.data || e.message));
