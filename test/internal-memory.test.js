/**
 * test/internal-memory.test.js — Tests del endpoint interno de memoria
 *
 * Usa el runner nativo (node --test). No toca red ni Redis real: la memoria
 * durable y el historial se inyectan con `_setMemoryProvider`.
 */

process.env.TENANT = 'yeppo';

const { test } = require('node:test');
const assert = require('node:assert');

const im = require('../core/internal-memory');

const KEY = 'k'.repeat(48);

// ── 1. Autorización con la llave interna ─────────────────────────────────────
test('internalKeyValid acepta la llave correcta', () => {
  assert.equal(im.internalKeyValid(KEY, KEY), true);
});

test('internalKeyValid rechaza llave incorrecta, corta o vacía', () => {
  assert.equal(im.internalKeyValid('otra', KEY), false);
  assert.equal(im.internalKeyValid('', KEY), false);
  assert.equal(im.internalKeyValid(null, KEY), false);
  assert.equal(im.internalKeyValid(KEY, 'corta'), false);   // esperada < 32 bytes
  assert.equal(im.internalKeyValid(KEY, ''), false);        // no configurada -> denegar
  assert.equal(im.internalKeyValid(KEY, undefined), false);
});

test('internalKeyValid deniega una llave del mismo largo pero distinta', () => {
  assert.equal(im.internalKeyValid('a'.repeat(48), KEY), false);
});

// ── 2. Payload de memoria ────────────────────────────────────────────────────
test('buildMemoryPayload mapea campos y redacta datos sensibles', () => {
  const doc = {
    fields: {
      nombre: 'Camila',
      preferencias: ['piel sensible'],
      productos: ['[serum] Sérum centella'],
      temasRecurrentes: ['rutina de noche'],
      objeciones: ['precio'],
      pendientes: ['confirmar pack'],
    },
    resumenBreve: 'Consultó por limpiador. Pago con tarjeta 4111 1111 1111 1111.',
    lastInteraction: { at: Date.UTC(2026, 8, 30), channel: 'whatsapp' },
  };

  const payload = im.buildMemoryPayload(doc);
  assert.equal(payload.nombre, 'Camila');
  assert.deepEqual(payload.preferencias, ['piel sensible']);
  assert.deepEqual(payload.temas_recurrentes, ['rutina de noche']);
  assert.deepEqual(payload.pendientes, ['confirmar pack']);
  assert.equal(payload.ultima_interaccion, '2026-09-30');
  assert.equal(payload.resumen.includes('4111'), false, 'no debe filtrar la tarjeta');
  assert.equal(JSON.stringify(payload).includes('4111'), false);
});

test('buildMemoryPayload devuelve null sin documento', () => {
  assert.equal(im.buildMemoryPayload(null), null);
  assert.equal(im.buildMemoryPayload(undefined), null);
});

// ── 3. Historial ─────────────────────────────────────────────────────────────
test('buildHistory mapea roles y conserva el orden cronológico', () => {
  const history = [
    { role: 'user', text: 'hola' },
    { role: 'bot', text: 'hola, ¿en qué te ayudo?' },
    { role: 'user', text: 'busco un protector solar' },
    { role: 'operator', text: 'te derivo' },
  ];
  const out = im.buildHistory(history);
  assert.deepEqual(out.map((x) => x.rol), ['cliente', 'bot', 'cliente', 'operador']);
  assert.equal(out[out.length - 1].texto, 'te derivo');
});

test('buildHistory descarta ruido y redacta datos de pago', () => {
  const out = im.buildHistory([
    { role: 'user', text: 'x' },                    // muy corto -> se descarta
    { role: 'bot', text: '' },                       // vacío
    { role: 'user', text: 'mi cvv: 123 del banco' }, // se redacta
    { role: 'user', text: 'gracias' },
  ]);
  const serialized = JSON.stringify(out);
  assert.equal(serialized.includes('123'), false);
  assert.equal(out.some((x) => x.texto === 'gracias'), true);
});

test('buildHistory acota cantidad y tamaño', () => {
  const big = Array.from({ length: 50 }, (_, i) => ({ role: 'user', text: 'mensaje numero ' + i + ' ' + 'x'.repeat(200) }));
  const out = im.buildHistory(big);
  assert.ok(out.length <= im.MAX_HISTORY_ITEMS);
  const total = out.reduce((acc, x) => acc + x.texto.length, 0);
  assert.ok(total <= im.MAX_HISTORY_CHARS);
});

// ── 4. getClientMemory ───────────────────────────────────────────────────────
test('getClientMemory combina memoria e historial', async () => {
  im._setMemoryProvider({
    getMemoryDoc: async () => ({
      fields: { nombre: 'Ana', preferencias: [], productos: ['Pack'], temasRecurrentes: [], objeciones: [], pendientes: [] },
      resumenBreve: 'Quiere pack',
      lastInteraction: { at: Date.UTC(2026, 8, 29) },
    }),
    getHistory: async () => [{ role: 'user', text: 'quiero el pack' }],
  });

  const payload = await im.getClientMemory('+56911112222');
  assert.equal(payload.found, true);
  assert.equal(payload.phone, '+56911112222');
  assert.equal(payload.memoria.nombre, 'Ana');
  assert.equal(payload.historial.length, 1);
  assert.equal(payload.historial[0].rol, 'cliente');
});

test('getClientMemory devuelve found:false sin datos o sin teléfono', async () => {
  im._setMemoryProvider({ getMemoryDoc: async () => null, getHistory: async () => [] });

  const sinDatos = await im.getClientMemory('+56900000000');
  assert.equal(sinDatos.found, false);
  assert.equal(sinDatos.memoria, null);
  assert.deepEqual(sinDatos.historial, []);

  const sinPhone = await im.getClientMemory('');
  assert.equal(sinPhone.found, false);
  assert.equal(sinPhone.phone, null);
});

test('getClientMemory no propaga errores del proveedor', async () => {
  im._setMemoryProvider({
    getMemoryDoc: async () => { throw new Error('redis caído'); },
    getHistory: async () => { throw new Error('redis caído'); },
  });
  const payload = await im.getClientMemory('+56912345678');
  assert.equal(payload.found, false);
});
