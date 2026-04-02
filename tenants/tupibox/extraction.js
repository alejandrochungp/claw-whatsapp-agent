/**
 * Extracción inteligente de datos usando Claude AI
 * Pide a la IA que estructure datos después de capturarlos conversacionalmente.
 *
 * Nota: usa axios directo (no core/ai.js) porque core/ai.ask() está diseñado
 * para conversaciones completas con historial de tenant — no para prompts
 * de extracción one-shot. Se reutiliza la misma CLAUDE_API_KEY del entorno.
 */

const axios = require('axios');
const logger = require('../../core/logger');

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const CLAUDE_MODEL = 'claude-3-5-haiku-20241022'; // Modelo rápido y económico para extracción

/**
 * Extraer datos estructurados de una conversación
 * @param {Array} conversationHistory - Historial de mensajes [{ from, message }] o [{ role, text }]
 * @returns {Object} Datos extraídos estructurados
 */
async function extractFromConversation(conversationHistory) {
  if (!CLAUDE_API_KEY) {
    logger.log('⚠️ [extraction] CLAUDE_API_KEY no configurada, extracción desactivada');
    return {};
  }

  try {
    // Construir transcript de la conversación
    // Soporta tanto { from, message } (formato tupibox-fresh) como { role, text } (formato core)
    const transcript = conversationHistory
      .slice(-6) // Últimos 6 mensajes
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

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: CLAUDE_MODEL,
        max_tokens: 500,
        messages: [
          {
            role: 'user',
            content: extractionPrompt
          }
        ]
      },
      {
        headers: {
          'x-api-key': CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        timeout: 10000 // 10 segundos
      }
    );

    const content = response.data.content[0].text.trim();

    // Limpiar markdown si existe
    const jsonText = content.replace(/```json\n?/g, '').replace(/```\n?/g, '');

    const extracted = JSON.parse(jsonText);

    logger.log(`✅ [extraction] Extracción IA: ${Object.keys(extracted).length} campos`);

    return extracted;

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
    // Normalizar peso a formato "XX kg"
    const weightNum = extracted.weight.toString().replace(/[^\d.]/g, '');
    mapped.weight = `${weightNum} kg`;
  }
  if (extracted.breed) mapped.breed = extracted.breed;
  if (extracted.sex) mapped.sex = extracted.sex;

  // Edad: priorizar birthDate, luego ageYears + ageMonths
  if (extracted.birthDate) {
    mapped.birthDate = extracted.birthDate;
  } else if (extracted.ageYears !== undefined) {
    const years = extracted.ageYears;
    const months = extracted.ageMonths || 0;
    const totalMonths = (years * 12) + months;
    mapped.ageInMonths = totalMonths.toString();

    // Calcular fecha aproximada de nacimiento
    const today = new Date();
    const birthDate = new Date(today);
    birthDate.setMonth(birthDate.getMonth() - totalMonths);
    mapped.birthDate = birthDate.toISOString().split('T')[0];
  }

  if (extracted.activityLevel) mapped.activityLevel = extracted.activityLevel;

  // Alergias - normalizar valores
  if (extracted.allergies) {
    const allergyLower = extracted.allergies.toLowerCase();
    if (allergyLower.includes('no') || allergyLower.includes('ninguna') || allergyLower.includes('sin')) {
      mapped.allergies = 'Sin alergias';
    } else {
      mapped.allergies = extracted.allergies;
    }
  }

  // Preferencia proteína - normalizar valores
  if (extracted.proteinPreference) {
    const prefLower = extracted.proteinPreference.toLowerCase();
    if (prefLower.includes('da lo mismo') || prefLower.includes('sin preferencia') || prefLower.includes('cualquier')) {
      mapped.proteinPreference = 'Sin preferencia';
    } else {
      // Normalizar nombres de proteínas
      const proteinMap = {
        'pollo': 'Pollo',
        'res': 'Res',
        'cerdo': 'Cerdo',
        'pescado': 'Pescado',
        'cordero': 'Cordero',
        'pavo': 'Pavo'
      };

      for (const [key, value] of Object.entries(proteinMap)) {
        if (prefLower.includes(key)) {
          mapped.proteinPreference = value;
          break;
        }
      }

      // Si no encontró match, usar textual
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
