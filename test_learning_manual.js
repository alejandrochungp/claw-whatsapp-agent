/**
 * test_learning_manual.js
 * Prueba el sistema de aprendizaje con las convs de Slack, limpiando el formato.
 */

const axios = require('axios');
const fs    = require('fs');

const CLAUDE_KEY = fs.readFileSync('C:\\Users\\achun\\.openclaw\\workspace\\.secrets\\claude_yeppo_key.txt', 'utf8').trim();

// Limpiar texto de formato Slack
function cleanSlack(text) {
  return text
    .replace(/:[\w_]+:/g, '')           // :emoji:
    .replace(/\*([^*]+)\*/g, '$1')      // *negrita*
    .replace(/<[^>]+>/g, '')            // <links>
    .replace(/`[^`]+`/g, '')            // `código`
    .replace(/\n{3,}/g, '\n\n')
    .replace(/Comandos.*$/gm, '')
    .trim();
}

// Parsear diálogo de Slack en mensajes limpios
function parseDialogue(dialogue) {
  const lines = dialogue.split('\n');
  const messages = [];
  
  for (const line of lines) {
    const trimmed = cleanSlack(line.trim());
    if (!trimmed || trimmed.length < 5) continue;
    
    if (line.startsWith('human_operator:')) {
      const text = trimmed.replace(/^human_operator:\s*/, '');
      if (text.length > 3) messages.push({ role: 'Operador', text });
    } else if (line.includes('*Bot:*') || line.includes('*Bot:')) {
      const match = line.match(/\*Bot:\*?\s*(.+)/);
      if (match) messages.push({ role: 'Bot', text: cleanSlack(match[1]) });
    } else if (line.includes('*Cliente:*')) {
      const match = line.match(/\*Cliente:\*?\s*(.+)/);
      if (match) messages.push({ role: 'Cliente', text: cleanSlack(match[1]) });
    }
  }
  
  return messages.filter(m => m.text.length > 3);
}

async function main() {
  const rawConvs = JSON.parse(fs.readFileSync('./slack_conversations_ayer.json', 'utf8'));
  
  const convTexts = rawConvs.map((c, i) => {
    const msgs = parseDialogue(c.dialogue);
    if (!msgs.length) return null;
    const formatted = msgs.map(m => `${m.role}: ${m.text}`).join('\n');
    return `=== Conversación ${i+1} ===\n${formatted}`;
  }).filter(Boolean);

  console.log(`Procesando ${convTexts.length} conversaciones...`);
  convTexts.forEach((c, i) => {
    console.log(`\n--- Conv ${i+1} preview ---`);
    console.log(c.substring(0, 300));
  });

  const prompt = `Analiza estas ${convTexts.length} conversaciones reales de Yeppo (tienda cosméticos coreanos en Santiago).

Para cada caso donde el operador humano dio una respuesta que el bot debería aprender:
1. Identifica la pregunta/situación del cliente
2. Cómo respondió el bot (si respondió)
3. Cómo respondió el operador humano
4. Una versión mejorada para que el bot aprenda

${convTexts.join('\n\n')}

Responde en JSON:
{
  "suggestions": [
    {
      "question": "situación del cliente",
      "bot_failed": "qué dijo el bot o vacío",
      "human_answer": "respuesta del operador",
      "suggested_answer": "respuesta sugerida para el bot (tono natural Yeppo)",
      "category": "reclamos|despacho|productos|horarios|otro",
      "confidence": "alta|media|baja"
    }
  ],
  "summary": "resumen de 2 líneas"
}

Solo incluir confidence alta o media.`;

  const r = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }]
  }, {
    headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
    timeout: 60000
  });

  const text = r.data.content[0].text;
  console.log('\n=== RESULTADO CLAUDE ===\n');
  console.log(text);

  // Parsear y mostrar sugerencias
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    const result = JSON.parse(jsonMatch[0]);
    console.log(`\n✅ ${result.suggestions?.length || 0} sugerencias`);
    console.log('Resumen:', result.summary);
  }
}

main().catch(e => console.error('Error:', e.response?.data || e.message));
