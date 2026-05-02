/**
 * generate_knowledge_final.js
 * Lee el analisis intermedio (knowledge_batch_analysis.txt) y genera el doc final.
 * Usar cuando generate_knowledge_v4.js fue interrumpido en la sintesis.
 */

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

const DEEPSEEK_KEY_PATH = path.join(__dirname, '../../../../../.secrets/deepseek_key.txt');
const DEEPSEEK_API_KEY  = fs.readFileSync(DEEPSEEK_KEY_PATH, 'utf8').trim();
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';

const OUT_DIR       = path.join(__dirname, '..', 'knowledge');
const INTERMEDIO    = path.join(OUT_DIR, 'knowledge_batch_analysis.txt');
const DOC_PATH      = path.join(OUT_DIR, 'knowledge_doc.md');
const STATS_PATH    = path.join(OUT_DIR, 'knowledge_stats.json');

if (!fs.existsSync(INTERMEDIO)) {
  console.error('ERROR: No existe ' + INTERMEDIO + '. Corre primero generate_knowledge_v4.js');
  process.exit(1);
}

const combinedAnalysis = fs.readFileSync(INTERMEDIO, 'utf8');
console.log('Analisis intermedio cargado: ' + combinedAnalysis.length + ' chars');
console.log('Generando documento final con DeepSeek V4 Pro...\n');

async function main() {
  const res = await axios.post(
    DEEPSEEK_BASE_URL + '/chat/completions',
    {
      model: 'deepseek-v4-pro',
      max_tokens: 8192,
      messages: [
        {
          role: 'system',
          content: 'Eres un experto en atencion al cliente de Yeppo, tienda de cosmeticos coreanos en Santiago de Chile. Generas documentos de conocimiento para agentes de IA. El documento debe ser en texto plano sin markdown.'
        },
        {
          role: 'user',
          content: 'Tienes el analisis de 570 conversaciones reales de atencion al cliente de Yeppo (cosmeticos coreanos, Patronato, Santiago). Estas incluyen conversaciones historicas de Crisp y conversaciones recientes del bot de WhatsApp.\n\n' +
            'ANALISIS DE TODOS LOS BATCHES:\n' + combinedAnalysis + '\n\n' +
            'Genera el DOCUMENTO FINAL DE CONOCIMIENTO para un agente de IA de WhatsApp.\n\n' +
            'REGLAS CRITICAS:\n' +
            '- Texto plano sin markdown (sin **, sin ##, sin bullets con -)\n' +
            '- Titulos de seccion en MAYUSCULAS\n' +
            '- Tono informal del equipo (sin formalidades, sin signos de exclamacion al inicio)\n' +
            '- Respuestas de ejemplo basadas en lo que realmente decia el equipo\n\n' +
            'ESTRUCTURA OBLIGATORIA (incluir TODAS las secciones completas):\n\n' +
            'QUIENES SOMOS\n' +
            'PRODUCTOS Y SERVICIOS MAS CONSULTADOS\n' +
            'PREGUNTAS FRECUENTES Y COMO RESPONDERLAS (minimo 25 preguntas con respuesta en tono del equipo)\n' +
            'POLITICAS OPERATIVAS\n' +
            'TONO Y ESTILO DEL EQUIPO\n' +
            'MANEJO DE RECLAMOS\n' +
            'CUANDO DERIVAR A HUMANO\n\n' +
            'SORTEO BTS ARIRANG MAYO 2026\n\n' +
            'Durante mayo 2026, todos los clientes que compren $20.000 CLP o mas en cosmeticos (online o en tienda) participan automaticamente en el sorteo de entradas al concierto BTS World Tour ARIRANG.\n\n' +
            'Premio: Entrada Cancha Andes al concierto BTS World Tour ARIRANG (17 octubre 2026, Estadio Nacional) mas Set Jumiso completo (Niacinamide 20 Serum + Blackhead Set + Cream).\n\n' +
            'Mecanica: Monto minimo $20.000 CLP en una o varias compras durante mayo. Sorteo el 29 de mayo 2026. Inscripcion en https://docs.google.com/forms/d/e/1FAIpQLSfXxYN6PY9Z2iaEua46BImqAzuVrmoJSjkhxM_yZh5WfeDd8A/viewform\n\n' +
            'Si el cliente pregunta por BTS, el sorteo o la promocion de mayo, explicar y entregar el link de inscripcion. Si el cliente acaba de comprar mas de $20.000, mencionarlo proactivamente.'
        }
      ]
    },
    {
      headers: {
        'Authorization': 'Bearer ' + DEEPSEEK_API_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 300000
    }
  );

  const finalDoc = res.data.choices[0].message.content;
  fs.writeFileSync(DOC_PATH, finalDoc, 'utf8');

  const stats = JSON.parse(fs.existsSync(STATS_PATH) ? fs.readFileSync(STATS_PATH, 'utf8') : '{}');
  stats.finalGeneratedAt = new Date().toISOString();
  stats.docLength = finalDoc.length;
  stats.model = 'deepseek-v4-pro';
  fs.writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2), 'utf8');

  console.log('Documento guardado: ' + DOC_PATH);
  console.log('Tamano: ' + finalDoc.length + ' chars');
  console.log('BTS incluido:', finalDoc.includes('BTS'));
}

main().catch(e => {
  console.error('ERROR:', e.response?.data || e.message);
  process.exit(1);
});
