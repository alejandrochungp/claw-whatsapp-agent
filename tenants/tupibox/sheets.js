/**
 * Google Sheets Integration for TupiBox WhatsApp Bot
 *
 * Funciones:
 * - Leer datos de clientes/pedidos
 * - Capturar leads nuevos automáticamente
 * - Actualizar info de conversaciones
 *
 * Configuración requerida (variables Railway prefijadas con TUPIBOX_):
 * - TUPIBOX_SHEETS_CLIENT_EMAIL
 * - TUPIBOX_SHEETS_PRIVATE_KEY
 * - TUPIBOX_SHEETS_ID
 */

const { google } = require('googleapis');
const logger = require('../../core/logger');

// Configuración de autenticación con Service Account
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

let auth, sheets;

/**
 * Inicializa la conexión con Google Sheets
 */
function initialize() {
  try {
    // Service Account credentials con prefijo TUPIBOX_ para no conflictuar con Yeppo
    const credentials = {
      client_email: process.env.TUPIBOX_SHEETS_CLIENT_EMAIL,
      private_key: process.env.TUPIBOX_SHEETS_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    };

    auth = new google.auth.JWT(
      credentials.client_email,
      null,
      credentials.private_key,
      SCOPES
    );

    sheets = google.sheets({ version: 'v4', auth });

    logger.log('✅ [sheets] Google Sheets conectado');
  } catch (error) {
    logger.log(`❌ [sheets] Error inicializando Google Sheets: ${error.message}`);
  }
}

/**
 * Busca un cliente por número de teléfono
 * @param {string} phoneNumber - Número en formato E.164 (+56912345678)
 * @returns {Object|null} Datos del cliente o null si no existe
 */
async function getCustomer(phoneNumber) {
  if (!sheets) {
    logger.log('⚠️ [sheets] Google Sheets no inicializado');
    return null;
  }

  try {
    const spreadsheetId = process.env.TUPIBOX_SHEETS_ID;
    const range = 'Fresh - Subscribers!A:Z'; // Hoja de suscriptores activos

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) {
      return null;
    }

    // Busca por número de teléfono (columna depende de estructura)
    // Primero verificamos headers para encontrar la columna de teléfono
    const headers = rows[0];
    const phoneColIndex = headers.findIndex(h =>
      h && (h.toLowerCase().includes('teléfono') || h.toLowerCase().includes('telefono') || h.toLowerCase().includes('phone'))
    );

    if (phoneColIndex === -1) {
      logger.log('⚠️ [sheets] No se encontró columna de teléfono en Fresh - Subscribers');
      return null;
    }

    // Busca el cliente (empezando desde fila 2, después de headers)
    const customerRow = rows.slice(1).find(row => row[phoneColIndex] === phoneNumber);

    if (!customerRow) {
      return null;
    }

    // Buscar índices de columnas de forma dinámica
    const nameIdx        = headers.findIndex(h => h && (h.toLowerCase().includes('nombre') && !h.toLowerCase().includes('perro')));
    const emailIdx       = headers.findIndex(h => h && h.toLowerCase().includes('email'));
    const planIdx        = headers.findIndex(h => h && h.toLowerCase().includes('plan'));
    const dogNameIdx     = headers.findIndex(h => h && h.toLowerCase().includes('nombre') && h.toLowerCase().includes('perro'));
    const dogWeightIdx   = headers.findIndex(h => h && h.toLowerCase().includes('peso'));
    const dogBreedIdx    = headers.findIndex(h => h && h.toLowerCase().includes('raza'));
    const deliveryFreqIdx = headers.findIndex(h => h && h.toLowerCase().includes('frecuencia'));

    // Estructura de retorno enriquecida
    return {
      phone: customerRow[phoneColIndex],
      name: customerRow[nameIdx] || '',
      email: customerRow[emailIdx] || '',
      plan: customerRow[planIdx] || '',
      dogName: customerRow[dogNameIdx] || '',
      weight: customerRow[dogWeightIdx] || '',
      breed: customerRow[dogBreedIdx] || '',
      deliveryFrequency: customerRow[deliveryFreqIdx] || '',
      status: 'Activo', // Asumimos activo si está en Subscribers
      rowIndex: rows.indexOf(customerRow) + 1,
      rawData: customerRow, // Data completa para referencia
    };
  } catch (error) {
    logger.log(`❌ [sheets] Error buscando cliente: ${error.message}`);
    return null;
  }
}

/**
 * Captura un lead nuevo en la hoja de cálculo
 * @param {Object} leadData - Datos del lead
 * @returns {boolean} true si se guardó exitosamente
 */
async function captureLead(leadData) {
  if (!sheets) {
    logger.log('⚠️ [sheets] Google Sheets no inicializado');
    return false;
  }

  try {
    const spreadsheetId = process.env.TUPIBOX_SHEETS_ID;
    const range = 'Fresh - Leads!A:V'; // Hoja de leads (estructura existente)

    const timestamp = new Date().toISOString();

    // Datos a insertar (adaptado a estructura existente de TupiBox)
    // Columnas: Timestamp, Nombre Perro, Sexo, Peso, Raza, Fecha Nacimiento,
    //           Alergias, Nivel Actividad, Preferencia Proteína, Plan Interesado,
    //           Precio, Email, Teléfono, Ciudad, Step Abandonado, Source,
    //           UTM Campaign, Recovery Email Sent, Recovery Email Date, Convertido,
    //           Fecha Conversión, Frecuencia Entrega
    const values = [[
      timestamp,                           // A: Timestamp
      leadData.dogName || '',              // B: Nombre Perro
      '',                                  // C: Sexo
      '',                                  // D: Peso (kg)
      '',                                  // E: Raza
      '',                                  // F: Fecha Nacimiento
      '',                                  // G: Alergias
      '',                                  // H: Nivel Actividad
      '',                                  // I: Preferencia Proteína
      '',                                  // J: Plan Interesado
      '',                                  // K: Precio
      '',                                  // L: Email
      `'${leadData.phone}`,                // M: Teléfono (con ' para forzar texto)
      '',                                  // N: Ciudad
      'Conversación WhatsApp',             // O: Step Abandonado
      leadData.source || 'WhatsApp Bot',   // P: Source
      leadData.intent || '',               // Q: UTM Campaign (usamos intent)
      '',                                  // R: Recovery Email Sent
      '',                                  // S: Recovery Email Date
      '',                                  // T: Convertido
      '',                                  // U: Fecha Conversión
      '',                                  // V: Frecuencia Entrega
    ]];

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      resource: { values },
    });

    logger.log(`✅ [sheets] Lead capturado: ${leadData.phone}`);
    return true;
  } catch (error) {
    logger.log(`❌ [sheets] Error capturando lead: ${error.message}`);
    return false;
  }
}

/**
 * Actualiza los datos de un cliente existente
 * @param {string} phoneNumber - Número del cliente
 * @param {Object} updates - Campos a actualizar
 * @returns {boolean} true si se actualizó
 */
async function updateCustomer(phoneNumber, updates) {
  if (!sheets) {
    logger.log('⚠️ [sheets] Google Sheets no inicializado');
    return false;
  }

  try {
    // Primero busca el cliente para obtener el rowIndex
    const customer = await getCustomer(phoneNumber);
    if (!customer) {
      logger.log(`⚠️ [sheets] Cliente no encontrado: ${phoneNumber}`);
      return false;
    }

    const spreadsheetId = process.env.TUPIBOX_SHEETS_ID;

    // Construye el rango específico de la fila
    const range = `Clientes!A${customer.rowIndex}:I${customer.rowIndex}`;

    // Merge datos existentes con updates
    const values = [[
      customer.id,
      customer.phone,
      updates.name || customer.name,
      updates.email || customer.email,
      updates.dogName || customer.dogName,
      updates.plan || customer.plan,
      updates.status || customer.status,
      updates.lastOrder || customer.lastOrder,
      updates.notes || customer.notes,
    ]];

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      resource: { values },
    });

    logger.log(`✅ [sheets] Cliente actualizado: ${phoneNumber}`);
    return true;
  } catch (error) {
    logger.log(`❌ [sheets] Error actualizando cliente: ${error.message}`);
    return false;
  }
}

/**
 * Obtiene pedidos de un cliente
 * @param {string} phoneNumber - Número del cliente
 * @returns {Array} Lista de pedidos
 */
async function getOrders(phoneNumber) {
  if (!sheets) {
    logger.log('⚠️ [sheets] Google Sheets no inicializado');
    return [];
  }

  try {
    const spreadsheetId = process.env.TUPIBOX_SHEETS_ID;
    const range = 'Pedidos!A:H'; // Ajusta según tu estructura

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) {
      return [];
    }

    // Filtra pedidos del cliente (asumiendo columna B tiene el teléfono)
    const orders = rows
      .filter(row => row[1] === phoneNumber)
      .map(row => ({
        orderId: row[0],
        phone: row[1],
        date: row[2],
        plan: row[3],
        amount: row[4],
        status: row[5],
        deliveryDate: row[6],
        notes: row[7],
      }));

    return orders;
  } catch (error) {
    logger.log(`❌ [sheets] Error obteniendo pedidos: ${error.message}`);
    return [];
  }
}

/**
 * Registra una conversación en el historial
 * @param {Object} conversationData - Datos de la conversación
 */
async function logConversation(conversationData) {
  if (!sheets) {
    return;
  }

  try {
    const spreadsheetId = process.env.TUPIBOX_SHEETS_ID;
    const range = 'Conversaciones!A:F';

    const timestamp = new Date().toISOString();

    const values = [[
      timestamp,
      conversationData.phone,
      conversationData.customerName || '',
      conversationData.intent || '',
      conversationData.handoffToHuman ? 'Sí' : 'No',
      conversationData.summary || '',
    ]];

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      resource: { values },
    });

    logger.log(`📝 [sheets] Conversación registrada: ${conversationData.phone}`);
  } catch (error) {
    logger.log(`❌ [sheets] Error registrando conversación: ${error.message}`);
  }
}

/**
 * Verifica si es un cliente nuevo (no está en Sheets)
 * @param {string} phoneNumber - Número a verificar
 * @returns {boolean} true si es nuevo
 */
async function isNewLead(phoneNumber) {
  // Buscar en ambas hojas: Subscribers y Leads
  const customer = await getCustomer(phoneNumber);
  const lead = await getLead(phoneNumber);

  return customer === null && lead === null;
}

/**
 * Busca un lead en Fresh - Leads por número de teléfono
 * @param {string} phoneNumber - Número en formato E.164
 * @returns {Object|null} Lead encontrado o null
 */
async function getLead(phoneNumber) {
  if (!sheets) {
    logger.log('⚠️ [sheets] Google Sheets no inicializado');
    return null;
  }

  try {
    const spreadsheetId = process.env.TUPIBOX_SHEETS_ID;
    const range = 'Fresh - Leads!A:V';

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) {
      return null;
    }

    // Buscar por teléfono (columna M, índice 12)
    const leadRow = rows.slice(1).find(row => row[12] === `'${phoneNumber}` || row[12] === phoneNumber);

    if (!leadRow) {
      return null;
    }

    // Intentar extraer nombre del email si existe
    let customerName = '';
    if (leadRow[11]) { // Email en columna L
      const emailParts = leadRow[11].split('@')[0];
      // Convertir "maria.gonzalez" → "Maria Gonzalez"
      customerName = emailParts
        .split(/[._-]/)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
        .join(' ');
    }

    return {
      timestamp: leadRow[0],
      dogName: leadRow[1],
      name: customerName, // ✨ Agregado: nombre estimado desde email
      sex: leadRow[2],
      weight: leadRow[3],
      breed: leadRow[4],
      birthDate: leadRow[5],
      allergies: leadRow[6],
      activityLevel: leadRow[7],
      proteinPreference: leadRow[8],
      planInterested: leadRow[9],
      price: leadRow[10],
      email: leadRow[11],
      phone: leadRow[12],
      city: leadRow[13],
      stepAbandoned: leadRow[14],
      source: leadRow[15],
      utmCampaign: leadRow[16],
      rowIndex: rows.indexOf(leadRow) + 1,
    };
  } catch (error) {
    logger.log(`❌ [sheets] Error buscando lead: ${error.message}`);
    return null;
  }
}

/**
 * Actualiza un lead existente en Fresh - Leads
 * @param {string} phoneNumber - Número del lead
 * @param {Object} updates - Campos a actualizar
 * @returns {boolean} true si se actualizó
 */
async function updateLead(phoneNumber, updates) {
  if (!sheets) {
    logger.log('⚠️ [sheets] Google Sheets no inicializado');
    return false;
  }

  try {
    const lead = await getLead(phoneNumber);
    if (!lead) {
      logger.log(`⚠️ [sheets] Lead no encontrado: ${phoneNumber}`);
      return false;
    }

    const spreadsheetId = process.env.TUPIBOX_SHEETS_ID;
    const range = `Fresh - Leads!A${lead.rowIndex}:V${lead.rowIndex}`;

    // Merge datos existentes con updates
    const values = [[
      lead.timestamp,                                       // A: Timestamp
      updates.dogName || lead.dogName || '',                // B: Nombre Perro
      updates.sex || lead.sex || '',                        // C: Sexo
      updates.weight || lead.weight || '',                  // D: Peso
      updates.breed || lead.breed || '',                    // E: Raza
      updates.birthDate || lead.birthDate || '',            // F: Fecha Nacimiento
      updates.allergies || lead.allergies || '',            // G: Alergias
      updates.activityLevel || lead.activityLevel || '',    // H: Nivel Actividad
      updates.proteinPreference || lead.proteinPreference || '', // I: Preferencia Proteína
      updates.planInterested || lead.planInterested || '',  // J: Plan Interesado
      updates.price || lead.price || '',                    // K: Precio
      updates.email || lead.email || '',                    // L: Email
      lead.phone,                                           // M: Teléfono (no cambia)
      updates.city || lead.city || '',                      // N: Ciudad
      updates.stepAbandoned || lead.stepAbandoned || '',    // O: Step Abandonado
      lead.source,                                          // P: Source (no cambia)
      updates.utmCampaign || lead.utmCampaign || '',        // Q: UTM Campaign
      lead.recoveryEmailSent || '',                         // R: Recovery Email Sent
      lead.recoveryEmailDate || '',                         // S: Recovery Email Date
      updates.converted || lead.converted || '',            // T: Convertido
      updates.conversionDate || lead.conversionDate || '',  // U: Fecha Conversión
      updates.deliveryFrequency || lead.deliveryFrequency || '', // V: Frecuencia Entrega
    ]];

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      resource: { values },
    });

    logger.log(`✅ [sheets] Lead actualizado: ${phoneNumber}`);
    return true;
  } catch (error) {
    logger.log(`❌ [sheets] Error actualizando lead: ${error.message}`);
    return false;
  }
}

/**
 * Agrega una fila genérica a cualquier hoja
 * @param {string} sheetName - Nombre de la hoja
 * @param {Array} rowData - Array con los valores de la fila
 * @returns {boolean} true si se agregó correctamente
 */
async function appendRow(sheetName, rowData) {
  if (!sheets) {
    logger.log('⚠️ [sheets] Google Sheets no inicializado');
    return false;
  }

  try {
    const spreadsheetId = process.env.TUPIBOX_SHEETS_ID;
    const range = `${sheetName}!A:Z`;

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [rowData] },
    });

    logger.log(`✅ [sheets] Fila agregada en ${sheetName}`);
    return true;
  } catch (error) {
    logger.log(`❌ [sheets] Error agregando fila en ${sheetName}: ${error.message}`);
    return false;
  }
}

/**
 * Busca un cliente en TupiBox Original (cajas temáticas) por teléfono.
 * Sheet ID fijo ya que es distinto al de Fresh.
 */
async function getOriginalCustomer(phoneNumber) {
  if (!sheets) return null;

  try {
    const spreadsheetId = '1OL2NTjFGDJhurOVgwqVLdnL52RQzRBVsQPydW0pD0Cc';
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Pedidos!A:Z',
    });

    const rows = response.data.values;
    if (!rows || rows.length < 2) return null;

    const headers = rows[0];
    const phoneIdx   = headers.findIndex(h => h && h.toLowerCase() === 'phone');
    const emailIdx   = headers.findIndex(h => h && h.toLowerCase() === 'email');
    const nameIdx    = headers.findIndex(h => h && h.toLowerCase() === 'name');
    const dogIdx     = headers.findIndex(h => h && h.toLowerCase().includes('nombre') || h.toLowerCase() === 'petname');
    const breedIdx   = headers.findIndex(h => h && h.toLowerCase() === 'breed');
    const allergyIdx = headers.findIndex(h => h && h.toLowerCase() === 'allergie');
    const planIdx    = headers.findIndex(h => h && h.toLowerCase() === 'plan');
    const cityIdx    = headers.findIndex(h => h && h.toLowerCase() === 'city');

    if (phoneIdx === -1) return null;

    // Normalizar teléfono para buscar (quitar +56, espacios, etc.)
    const normalizePhone = (p) => p ? p.replace(/\D/g, '').replace(/^56/, '') : '';
    const searchPhone = normalizePhone(phoneNumber);

    // Buscar todas las filas del cliente (puede tener múltiples pedidos)
    const customerRows = rows.slice(1).filter(row => {
      const rowPhone = normalizePhone(row[phoneIdx] || '');
      return rowPhone && rowPhone === searchPhone;
    });

    if (customerRows.length === 0) return null;

    // Usar la fila más reciente (última)
    const latest = customerRows[customerRows.length - 1];

    logger.log(`[sheets] Cliente Original encontrado: ${customerRows.length} pedido(s)`);

    return {
      phone: phoneNumber,
      name:     nameIdx  >= 0 ? latest[nameIdx]    || '' : '',
      email:    emailIdx >= 0 ? latest[emailIdx]   || '' : '',
      dogName:  dogIdx   >= 0 ? latest[dogIdx]     || '' : '',
      breed:    breedIdx >= 0 ? latest[breedIdx]   || '' : '',
      allergies: allergyIdx >= 0 ? latest[allergyIdx] || '' : '',
      plan:     planIdx  >= 0 ? latest[planIdx]    || '' : '',
      city:     cityIdx  >= 0 ? latest[cityIdx]    || '' : '',
      totalOrders: customerRows.length,
      source: 'tupibox_original',
    };
  } catch (e) {
    logger.log(`[sheets] getOriginalCustomer error: ${e.message}`);
    return null;
  }
}

module.exports = {
  initialize,
  getCustomer,
  captureLead,
  updateCustomer,
  getOrders,
  logConversation,
  isNewLead,
  getLead,
  updateLead,
  appendRow,
  getOriginalCustomer,
};

// Auto-init al cargar el módulo
initialize();
