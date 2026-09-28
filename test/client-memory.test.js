/**
 * test/client-memory.test.js — Tests de la memoria durable por cliente
 *
 * Usa el runner nativo de Node (node --test), Redis mockeado in-memory y
 * directorio temporal para el espejo en disco. No toca red ni Redis real.
 */

process.env.TENANT = 'yeppo';

const { test } = require('node:test');
const assert = require('node:assert');
const os   = require('os');
const fs   = require('fs');
const path = require('path');

const cm = require('../core/client-memory');

// ── Helpers ──────────────────────────────────────────────────────────────────
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cmmem-'));
}

function makeRedis() {
  const store = new Map();
  return {
    store,
    lastSetEx: null,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async set(k, v) { store.set(k, v); return 'OK'; },
    async setEx(k, ttl, v) { store.set(k, v); this.lastSetEx = { k, ttl }; return 'OK'; },
    async del(k) { store.delete(k); return 1; }
  };
}

// Deja el módulo en un estado limpio y aislado (sin Redis, disco temporal).
function reset(opts = {}) {
  cm._setRedisClient(opts.redis || null);
  cm._setRedisProvider(() => null); // evita caer a core/memory.js (Redis real)
  cm._setLLM(opts.llm || null);
  cm._setMemoryProvider(opts.memory || null);
  cm._setMemoryDir(opts.dir || tmpDir());
}

// ── 1. Clave Redis nueva ─────────────────────────────────────────────────────
test('usa la clave nueva TENANT:mem:<telefono> en Redis', async () => {
  const redis = makeRedis();
  reset({ redis });

  const doc = cm.emptyDoc('+56911112222');
  await cm.saveMemoryDoc('+56911112222', doc);

  assert.equal(cm.memKey('+56911112222'), 'yeppo:mem:+56911112222');
  assert.ok(redis.store.has('yeppo:mem:+56911112222'), 'debe escribir la clave mem:');

  const back = await cm.getMemoryDoc('+56911112222');
  assert.equal(back.phone, '+56911112222');
  assert.equal(back.tenant, 'yeppo');
});

// ── 2. TTL largo ─────────────────────────────────────────────────────────────
test('aplica TTL largo (730 días por defecto) al documento', async () => {
  const redis = makeRedis();
  reset({ redis });

  await cm.saveMemoryDoc('+5690000', cm.emptyDoc('+5690000'));

  assert.equal(cm.MEM_TTL_SECS, 730 * 24 * 3600);
  assert.ok(redis.lastSetEx, 'debe usar setEx');
  assert.equal(redis.lastSetEx.ttl, 730 * 24 * 3600);
});

// ── 3. Fusión ────────────────────────────────────────────────────────────────
test('la fusión actualiza campos y no pierde historial', () => {
  reset();

  const prev = cm.emptyDoc('+1');
  prev.fields.nombre = 'Camila';
  prev.fields.productos = ['A'];
  prev.sessions = 1;

  const merged = cm.mergeMemoryDoc(prev, {
    nombre: 'Camila',
    productos: ['B', 'A'],
    pendientes: ['confirmar pack'],
    resumenBreve: 'Consulta por limpiador'
  }, { phone: '+1', msgs: 5, lastSummarizedTs: 1000 });

  assert.equal(merged.fields.nombre, 'Camila');
  assert.deepEqual(merged.fields.productos, ['A', 'B']); // unión, sin duplicar
  assert.deepEqual(merged.fields.pendientes, ['confirmar pack']);
  assert.equal(merged.sessions, 2);                       // acumula sesiones
  assert.equal(merged.lastSummarizedTs, 1000);
  assert.equal(merged.resumenBreve, 'Consulta por limpiador');
  assert.equal(merged.log.length, 1);
  assert.equal(merged.createdAt, prev.createdAt);         // conserva el original
});

test('la fusión conserva los items más recientes al topar el máximo', () => {
  reset();
  const prev = cm.emptyDoc('+2');
  prev.fields.productos = Array.from({ length: 12 }, (_, i) => 'P' + i);
  const merged = cm.mergeMemoryDoc(prev, { productos: ['NUEVO'] }, { phone: '+2', msgs: 1 });
  assert.equal(merged.fields.productos.length, 12);
  assert.equal(merged.fields.productos[11], 'NUEVO');     // el más reciente sobrevive
  assert.equal(merged.fields.productos[0], 'P1');         // el más viejo se descarta
});

// ── 4. Generación de resumen ─────────────────────────────────────────────────
test('summarizeSession parsea el JSON del modelo (con fences de markdown)', async () => {
  reset({
    llm: async () => '```json\n' + JSON.stringify({
      nombre: 'Ana',
      preferencias: ['piel seca'],
      productos: ['[x] Serum'],
      temasRecurrentes: [],
      objeciones: ['precio'],
      pendientes: ['enviar link'],
      resumenBreve: 'Pidió serum'
    }) + '\n```'
  });

  const s = await cm.summarizeSession([
    { role: 'user', text: 'hola' },
    { role: 'bot', text: 'hola!' }
  ]);

  assert.equal(s.nombre, 'Ana');
  assert.deepEqual(s.preferencias, ['piel seca']);
  assert.deepEqual(s.objeciones, ['precio']);
  assert.equal(s.resumenBreve, 'Pidió serum');
});

test('parseSummary devuelve null ante respuesta inválida', () => {
  reset();
  assert.equal(cm.parseSummary('no es json'), null);
  assert.equal(cm.parseSummary(''), null);
  assert.equal(cm.parseSummary(null), null);
  assert.equal(cm.parseSummary('[]'), null);
});

// ── 5. closeSession: watermark + persistencia ─────────────────────────────────
test('closeSession resume, fusiona y respeta el watermark', async () => {
  const redis = makeRedis();
  reset({
    redis,
    llm: async () => JSON.stringify({
      nombre: 'Pedro', preferencias: [], productos: ['Pack'],
      temasRecurrentes: [], objeciones: [], pendientes: ['pagar'],
      resumenBreve: 'Quiere pack'
    })
  });
  cm._setMemoryProvider({
    getHistory: async () => [
      { role: 'user', text: 'hola', ts: 1000 },
      { role: 'bot', text: 'hola', ts: 1001 },
      { role: 'user', text: 'quiero el pack', ts: 1002 }
    ],
    getContext: async () => ({})
  });

  const doc1 = await cm.closeSession('+5700', { memoryEnabled: true });
  assert.ok(doc1, 'debe generar documento');
  assert.equal(doc1.fields.nombre, 'Pedro');
  assert.equal(doc1.sessions, 1);
  assert.equal(doc1.lastSummarizedTs, 1002);
  assert.ok(redis.store.has('yeppo:mem:+5700'));

  // Sin mensajes nuevos → nada que resumir
  const doc2 = await cm.closeSession('+5700', { memoryEnabled: true });
  assert.equal(doc2, null);
});

test('closeSession no resume si hay menos del mínimo de mensajes nuevos', async () => {
  reset({ llm: async () => '{"nombre":"x"}' });
  cm._setMemoryProvider({
    getHistory: async () => [{ role: 'user', text: 'hola', ts: 1 }],
    getContext: async () => ({})
  });
  const doc = await cm.closeSession('+5701', { memoryEnabled: true });
  assert.equal(doc, null);
});

// ── 6. Fallback sin Redis ────────────────────────────────────────────────────
test('sin Redis usa el espejo en disco', async () => {
  const dir = tmpDir();
  reset({ dir, redis: null });

  const doc = cm.emptyDoc('+5800');
  doc.fields.nombre = 'SinRedis';
  await cm.saveMemoryDoc('+5800', doc);

  const back = await cm.getMemoryDoc('+5800');
  assert.equal(back.fields.nombre, 'SinRedis');
  assert.ok(fs.existsSync(path.join(dir, 'mem-yeppo.json')), 'debe escribir el archivo JSON');
});

test('si Redis falla, cae al disco', async () => {
  const dir = tmpDir();
  const brokenRedis = {
    async get() { throw new Error('redis caído'); },
    async set() { throw new Error('redis caído'); },
    async setEx() { throw new Error('redis caído'); }
  };
  reset({ dir, redis: brokenRedis });

  const doc = cm.emptyDoc('+5900');
  doc.fields.nombre = 'Fallback';
  await cm.saveMemoryDoc('+5900', doc); // setEx falla, pero igual persiste en disco

  const back = await cm.getMemoryDoc('+5900');
  assert.equal(back.fields.nombre, 'Fallback');
});

// ── 7. Límite de tamaño y prioridad en el prompt ─────────────────────────────
test('formatDocSection prioriza campos y respeta el límite', () => {
  reset();
  const doc = cm.emptyDoc('+1');
  doc.fields.nombre = 'Ana';
  doc.fields.pendientes = ['p1', 'p2'];
  doc.fields.productos = ['X'.repeat(500), 'Y'.repeat(500), 'Z'.repeat(500)];
  doc.resumenBreve = 'resumen final';

  const out = cm.formatDocSection(doc, 120);
  assert.match(out, /Nombre: Ana/);
  assert.match(out, /Pendiente: p1/);
  assert.match(out, /Resumen: resumen final/);
  assert.doesNotMatch(out, /Producto:/); // los campos de baja prioridad se cortan
});

test('formatDocSection devuelve todo si cabe y "" si no hay doc', () => {
  reset();
  const doc = cm.emptyDoc('+1');
  doc.fields.nombre = 'Ana';
  doc.fields.productos = ['Serum'];
  const out = cm.formatDocSection(doc, 5000);
  assert.match(out, /Nombre: Ana/);
  assert.match(out, /Producto: Serum/);
  assert.equal(cm.formatDocSection(null, 5000), '');
});

// ── 8. Sanitización de datos sensibles ───────────────────────────────────────
test('redacta datos de pago y credenciales', () => {
  reset();
  assert.equal(cm.redactSensitive('tarjeta 4111 1111 1111 1111 listo').includes('4111'), false);
  assert.match(cm.redactSensitive('cvv: 123'), /\[omitido\]/);
  assert.match(cm.redactSensitive('password: hunter2'), /\[omitido\]/);
  // no toca textos normales
  assert.equal(cm.redactSensitive('quiero 2 unidades'), 'quiero 2 unidades');
});

// ── 9. Interruptor de tenant ─────────────────────────────────────────────────
test('memoryEnabled=false desactiva la memoria', async () => {
  reset({ redis: makeRedis(), llm: async () => '{"nombre":"x"}' });
  cm._setMemoryProvider({
    getHistory: async () => [{ role: 'user', text: 'x', ts: 1 }, { role: 'bot', text: 'y', ts: 2 }, { role: 'user', text: 'z', ts: 3 }],
    getContext: async () => ({})
  });

  const before = cm._idleTimers.size;
  cm.touch('+5999', { memoryEnabled: false });
  assert.equal(cm._idleTimers.size, before, 'no debe programar timer si está desactivado');

  const doc = await cm.closeSession('+5999', { memoryEnabled: false });
  assert.equal(doc, null);
});
