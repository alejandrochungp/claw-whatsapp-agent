/**
 * Extracción inteligente de datos usando IA (DeepSeek primario, Claude fallback)
 *
 * Orden de prioridad:
 *   1. DeepSeek V4 Pro (DEEPSEEK_API_KEY) — ~10x más barato
 *   2. Claude Haiku    (CLAUDE_API_KEY)   — fallback si DeepSeek falla
 *
 * Nota: usa axios directo (no core/ai.js) porque core/ai.ask() está diseñado
 * para conversaciones completas con historial de tenant — no para prompts
 * de extracción one-shot.
 */

const axios = require('axios');
const logger = require('../../core/logger');

// ── Credenciales ─────────────────────────────────────────────────────────────
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const CLAUDE_API_KEY   = process.env.CLAUDE_API_KEY;
const DEEPSEEK_MODEL   = 'deepseek-chat';
const CLAUDE_MODEL     = 'claude-3-5-haiku-20241022';

/**
 * Extraer datos estructurados de una conversación
 * @param {Array} conversationHistory - Historial de mensajes [{ from, message }] o [{ role, text }]
 * @returns {Object} Datos extraídos estructurados
 */
async function extractFromConversation(conversationHistory) {
  if (!DEEPSEEK_API_KEY && !CLAUDE_API_KEY) {
    logger.log('⚠️ [extraction] Ninguna API key configurada, extracción desactivada');
    return {};
  }

  try {
    // Construir transcript de la conversación
    const transcript = conversationHistory
      .slice(-6)
      .map(msg => {
        const isUser = msg.from === 'user' || msg.role === 'user';
        const text   = msg.message || msg.text || '';
        return `${isUser ? 'Cliente' : 'Bot'}: ${text}`;
      })
      .join('\n');

    const extractionPrompt = `Analiza esta conversación y extrae SOLO los datos que el cliente haya compartido explícitamente.

Conversación:
${transcript}

Extrae los siguientes campos SI Y SOLO SI el cliente los mencionó:
- dogName: Nombre del perro (string)
- weight: Peso en kg (string como "25 kg" o "25")
- breed: Raza (string, puede ser "Mestizo" o "Quiltro" si no tiene raza definida)
- sex: Sexo ("Macho" o "Hembra")
- ageYears: Edad en años (number)
- ageMonths: Edad en meses adicionales (number, 0-11)
- birthDate: Fecha de nacimiento si la dio exacta (formato YYYY-MM-DD)
- activityLevel: Nivel de actividad ("Bajo", "Medio", "Alto")
- allergies: Alergias alimentarias (string) - "Sin alergias" si dice "no"/"ninguna"
- proteinPreference: Preferencia de proteína (string) - "Sin preferencia" si dice "me da lo mismo"

Responde SOLO con JSON válido. Si un campo no fue mencionado, NO lo incluyas.

Ejemplo:
Cliente: "Mi perro se llama Max, pesa 25 kilos y tiene 4 años"
Bot: "Perfecto! Y es muy activo?"
Cliente: "Sí, sale a correr conmigo todos los días"

Respuesta:
{
  "dogName": "Max",
  "weight": "25 kg",
  "ageYears": 4,
  "activityLevel": "Alto"
}

IMPORTANTE:
- NO inventes datos
- NO asumas información que no dijeron
- Si mencionaron meses de edad, calcula ageYears y ageMonths
- Si mencionaron fecha de nacimiento, usa birthDate (YYYY-MM-DD)
- Para actividad: "activo/sale a correr/juega mucho" = "Alto", "tranquilo/sedentario" = "Bajo", resto = "Medio"

Responde SOLO con el JSON, sin explicaciones ni markdown.`;

    // ── 1. DeepSeek (primario) ────────────────────────────────────────────
    if (DEEPSEEK_API_KEY) {
      try {
        const response = await axios.post(
          'https://api.deepseek.com/v1/chat/completions',
          {
            model: DEEPSEEK_MODEL,
            max_tokens: 500,
            messages: [
              { role: 'user', content: extractionPrompt }
            ]
          },
          {
            headers: {
              'Authorization': 'Bearer ' + DEEPSEEK_API_KEY,
              'Content-Type': 'application/json'
            },
            timeout: 10000
          }
        );

        const content = response.data.choices[0]?.message?.content?.trim() || '';
        const jsonText = content.replace(/```json\n?/g, '').replace(/```\n?/g, '');
        const extracted = JSON.parse(jsonText);

        logger.log(`[extraction] DeepSeek: ${Object.keys(extracted).length} campos extraídos`);
        return extracted;

      } catch (dsError) {
        logger.log(`[extraction] DeepSeek falló: ${dsError.message}, intentando Claude...`);
        // Cae al fallback Claude
      }
    }

    // ── 2. Claude (fallback) ──────────────────────────────────────────────
    if (CLAUDE_API_KEY) {
      const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: CLAUDE_MODEL,
          max_tokens: 500,
          messages: [
            { role: 'user', content: extractionPrompt }
          ]
        },
        {
          headers: {
            'x-api-key': CLAUDE_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
          },
          timeout: 10000
        }
      );

      const content = response.data.content[0].text.trim();
      const jsonText = content.replace(/```json\n?/g, '').replace(/```\n?/g, '');
      const extracted = JSON.parse(jsonText);

      logger.log(`[extraction] Claude: ${Object.keys(extracted).length} campos extraídos`);
      return extracted;
    }

    logger.log('⚠️ [extraction] Sin API key disponible');
    return {};

  } catch (error) {
    logger.log(`❌ [extraction] Error en extracción IA: ${error.message}`);
    return {};
  }
}

/**
 * Mapear campos extraídos a formato de Google Sheets
 */
function mapToSheetFormat(extracted) {
  const mapped = {};

  if (extracted.dogName) mapped.dogName = extracted.dogName;
  if (extracted.weight) {
    const weightNum = extracted.weight.toString().replace(/[^\d.]/g, '');
    mapped.weight = `${weightNum} kg`;
  }
  if (extracted.breed) mapped.breed = extracted.breed;
  if (extracted.sex) mapped.sex = extracted.sex;

  if (extracted.birthDate) {
    mapped.birthDate = extracted.birthDate;
  } else if (extracted.ageYears !== undefined) {
    const years = extracted.ageYears;
    const months = extracted.ageMonths || 0;
    const totalMonths = (years * 12) + months;
    mapped.ageInMonths = totalMonths.toString();

    const today = new Date();
    const birthDate = new Date(today);
    birthDate.setMonth(birthDate.getMonth() - totalMonths);
    mapped.birthDate = birthDate.toISOString().split('T')[0];
  }

  if (extracted.activityLevel) mapped.activityLevel = extracted.activityLevel;

  if (extracted.allergies) {
    const allergyLower = extracted.allergies.toLowerCase();
    if (allergyLower.includes('no') || allergyLower.includes('ninguna') || allergyLower.includes('sin')) {
      mapped.allergies = 'Sin alergias';
    } else {
      mapped.allergies = extracted.allergies;
    }
  }

  if (extracted.proteinPreference) {
    const prefLower = extracted.proteinPreference.toLowerCase();
    if (prefLower.includes('da lo mismo') || prefLower.includes('sin preferencia') || prefLower.includes('cualquier')) {
      mapped.proteinPreference = 'Sin preferencia';
    } else {
      const proteinMap = {
        'pollo': 'Pollo', 'res': 'Res', 'cerdo': 'Cerdo',
        'pescado': 'Pescado', 'cordero': 'Cordero', 'pavo': 'Pavo'
      };
      for (const [key, value] of Object.entries(proteinMap)) {
        if (prefLower.includes(key)) {
          mapped.proteinPreference = value;
          break;
        }
      }
      if (!mapped.proteinPreference) {
        mapped.proteinPreference = extracted.proteinPreference;
      }
    }
  }

  return mapped;
}

module.exports = {
  extractFromConversation,
  mapToSheetFormat
};
