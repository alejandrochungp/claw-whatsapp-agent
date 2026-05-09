# Sistema QA — Bot Yeppo

## Resumen Ejecutivo

Agente autónomo que ejecuta pruebas de calidad sobre issues desplegados en producción. Lee un issue de GitHub, diseña escenarios de prueba, los ejecuta contra el bot real (via WhatsApp API, webhook simulado, asserts lógicos) y reporta resultados en Slack + GitHub.

## Arquitectura

```
┌─────────────────────────────────────────────────────────────┐
│                     GitHub Issue (status:qa)                │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ ## QA Scenarios                                       │   │
│  │ - [ ] msg:Cliente $15.000 → debe recibir upsell BTS   │   │
│  │ - [ ] assert:findBTSComplement(15000) => not null     │   │
│  │ - [ ] template:upsell_bts_sorteo → delivery OK        │   │
│  │ - [ ] sim:order 15000 → BTS match en Redis            │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────┬──────────────────────────────────────┘
                       │ POST /admin/qa-run { issue: 17 }
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    core/qa.js (QA Engine)                   │
│                                                             │
│  1. fetchIssue(17) → parse scenarios                       │
│  2. classifyScenarios() → msg | assert | template | sim    │
│  3. runTests() → ejecuta cada tipo                         │
│  4. reportResults() → Slack + GitHub comment               │
└─────────────────────────────────────────────────────────────┘
         │                  │                │
         ▼                  ▼                ▼
   ┌──────────┐    ┌──────────────┐   ┌──────────────┐
   │ meta.js  │    │  upsel.js    │   │ shopify.js   │
   │ sendText │    │findComplement│   │ createOrder  │
   │sendTmpl  │    │ handleOrder  │   │ getProduct   │
   └──────────┘    └──────────────┘   └──────────────┘
```

## Archivos

| Archivo | Rol |
|---------|-----|
| `core/qa.js` | Motor QA: parse, ejecuta, reporta |
| `tenants/{TENANT}/qa.config.js` | Config por tenant (QA phone, Slack channel) |
| `server.js` | +2 endpoints: `POST /admin/qa-run`, `GET /admin/qa-status` |
| `core/ai.js` | Flag `qa: true` en mensajes entrantes del número QA |

## Tipos de Escenario

### 1. `msg` — Mensaje WhatsApp
Simula un cliente enviando un mensaje y verifica la respuesta del bot.

```yaml
type: msg
input: "Hola, hice un pedido"
expect:
  contains: "Gracias por tu compra"
  maxWaitMs: 15000
```

**Implementación:** El QA Agent envía un mensaje al bot desde el número QA vía Meta API. El bot responde normalmente. El agente lee la respuesta (vía webhook o polling) y verifica.

### 2. `assert` — Aserción Lógica
Llama directamente a funciones internas con datos de prueba.

```yaml
type: assert
call: "findBTSComplement(15000, config)"
expect:
  notNull: true
  productPriceLte: 9990
```

**Implementación:** `require('./upsell')` y llama la función con datos controlados. Sin efectos secundarios. Es el test más rápido y determinista.

### 3. `template` — Envío de Plantilla
Verifica que una plantilla Meta existe, está aprobada y se puede enviar.

```yaml
type: template
template: "upsell_bts_sorteo"
params:
  body: ["$15.000", "Birch Juice Mask", "$5.000"]
expect:
  delivery: OK
```

**Implementación:** Llama `meta.sendTemplate()` al número QA. Verifica status code 200.

### 4. `sim` — Simulación de Webhook
Simula un evento externo (pedido Shopify, webhook de pago) y verifica el estado resultante.

```yaml
type: sim
webhook: "orders/create"
payload:
  total_price: "15000"
  customer: { phone: "+569XXXXXXXX" }
expect:
  redisKey: "upsell:mock-123"
  redisData:
    btsCampaign: true
  slackNotification:
    channel: "qa-tests"
    contains: "BTS"
```

**Implementación:** POST al propio webhook con payload simulado, usando un `order.id` mock. Luego verifica Redis y/o Slack.

## Flujo de Ejecución

```
POST /admin/qa-run { "issue": 17, "scenarios": "auto" }
```

1. **Fetch** — `GET /repos/{owner}/{repo}/issues/17` 
2. **Parse** — Extrae `## QA Scenarios` del body
3. **Classify** — Cada línea → tipo (msg/assert/template/sim)
4. **Execute** — Corre en secuencia (los `assert` primero, son instantáneos)
5. **Verify** — Compara resultado vs. `expect`
6. **Report** — Slack + GitHub comment

### Si `scenarios: "auto"`:
El QA Agent usa IA (DeepSeek) para generar escenarios automáticamente leyendo el diff del commit + el issue body. Esto es para issues que no tienen `## QA Scenarios` en el body.

## Reporte

### Slack (`#qa-tests`)
```
🧪 QA Issue #17 — upsell-bts-sorteo
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ assert: findBTSComplement(15000) → not null
✅ assert: findBTSComplement(25000) → null (ya supera $20K)
✅ assert: cheapest product selected ($1.990)
✅ template: upsell_bts_sorteo → delivery OK
✅ sim: order $15.000 → BTS match en Redis
✅ sim: order $25.000 → sin BTS (correcto)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Resultado: 6/6 passed ✅
Tiempo: 4.2s
```

### GitHub Comment
El agente postea un comment en el issue con los resultados detallados y actualiza labels:
- Todo OK → `qa:passed`
- Fallos → `qa:failed` + comentario con lo que falló

## Número QA

Configurado en `tenants/yeppo/qa.config.js`:
```js
module.exports = {
  qaPhone: "+569XXXXXXXX",     // Número WhatsApp dedicado a QA
  qaSlackChannel: "qa-tests",  // Canal Slack para reportes
  githubRepo: "Programaemprender/claw-platform-backlog",
  defaultWaitMs: 15000,        // Tiempo máximo espera respuesta WhatsApp
  autoGenerate: true            // Generar escenarios con IA si no hay ## QA Scenarios
};
```

## Marcado QA en el Bot

En `server.js`, el handler de mensajes entrantes verifica:
```js
const isQA = msg.from === qaConfig.qaPhone;
if (isQA) {
  msg.qa = true;
  // No guardar en logs de producción
  // No contar en métricas
  // No enviar a Crisp/Slack de servicio al cliente
}
```

## Endpoints

### `POST /admin/qa-run`
```json
{
  "issue": 17,
  "scenarios": "auto"
}
```
Response:
```json
{
  "ok": true,
  "issue": 17,
  "total": 6,
  "passed": 6,
  "failed": 0,
  "durationMs": 4200,
  "slackPosted": true,
  "githubComment": "https://github.com/.../issues/17#issuecomment-..."
}
```

### `GET /admin/qa-status`
Status del último run + histórico de resultados.

## Seguridad

| Restricción | Detalle |
|---|---|
| Número QA | Solo los mensajes del número configurado como QA se tratan como tests |
| Sin side effects | `assert` no toca APIs externas, solo lógica |
| `sim` usa IDs mock | No contamina Redis de producción (usa prefijo `qa:`) |
| No métricas | Mensajes QA no cuentan en stats, no van a Crisp |
| Rate limit | Máximo 1 QA run cada 60 segundos |

## Ejemplo: QA para Issue #17

### Escenarios (generados automáticamente por IA):
```markdown
## QA Scenarios
- [ ] assert:findBTSComplement(15000) => not null, price ≤ 9990
- [ ] assert:findBTSComplement(25000) => null (ya supera threshold)
- [ ] assert:findBTSComplement(0) => null (sin monto)
- [ ] template:upsell_bts_sorteo => delivery OK
- [ ] sim:order 15000 => BTS match en Redis, btsCampaign:true
- [ ] sim:order 35000 => sin BTS (usa skincare normal si hay match)
- [ ] assert:upsellCampaignConfig loaded => not null, 389 productos
- [ ] msg:"Hola, compré un producto de $12.000" => respuesta contiene upsell BTS
```

## Implementación

### Fase 1 — Core
- `core/qa.js` con los 4 tipos de test
- Endpoints en `server.js`
- QA config por tenant

### Fase 2 — Automatización
- IA genera escenarios desde diff del commit
- GitHub webhook: issue movido a `status:qa` → auto-run
- Historial de QA runs

### Fase 3 — CI/CD
- GitHub Actions que corre QA antes de permitir merge
- Bloqueo de deploy si QA falla
