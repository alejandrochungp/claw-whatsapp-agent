# AMAC — Agente de Mejora Continua de Atención al Cliente

**Versión:** 1.0  
**Fecha:** Mayo 2026  
**Tenant:** Yeppo (extensible a todos los tenants)  
**Repositorio:** `github.com/alejandrochungp/claw-whatsapp-agent`  
**Backlog:** `github.com/Programaemprender/claw-platform-backlog`

---

## 1. Propósito

El AMAC es un agente autónomo que analiza semanalmente las conversaciones reales de atención al cliente para:

1. **Mejorar el conocimiento del bot** — actualiza automáticamente el `knowledge_doc.md` sin intervención humana
2. **Detectar oportunidades de automatización** — identifica tareas manuales repetitivas y las convierte en issues de ingeniería
3. **Medir la calidad del equipo** — tiempos de respuesta, casos ignorados, tasa de resolución bot vs humano
4. **Detectar malas escalaciones** — casos que debieron ir a humano o que no debieron ir

**Principio rector:** Entregar valor excepcional al cliente a través de excelente atención al cliente.

---

## 2. Arquitectura

```
Canal Slack #team-servicio-al-cliente
            ↓
    [AMAC Runner] (cron viernes 18:00)
            ↓
    ┌───────────────────────────────────┐
    │  core/amac.js                     │
    │  - Fetch conversaciones Slack     │
    │  - Análisis IA (DeepSeek V4 Pro)  │
    │  - Cálculo KPIs de agentes        │
    └───────────────────────────────────┘
            ↓
    ┌──────────────────┬────────────────────────┬──────────────────────┐
    │                  │                        │                      │
    ▼                  ▼                        ▼                      ▼
knowledge-         github-issues.js      amac-reporter.js      (futuro)
updater.js         Crea issues en        Publica reporte       Notion sync
Actualiza          claw-platform-        en #agente-
knowledge_doc.md   backlog               aprendizaje
Push a GitHub
```

---

## 3. Archivos del sistema

| Archivo | Descripción |
|---------|-------------|
| `core/amac.js` | Lógica principal: fetch Slack, análisis IA, KPIs |
| `core/amac-runner.js` | Orquestador: coordina todos los módulos + cron |
| `core/amac-reporter.js` | Genera y publica reporte en Slack |
| `core/knowledge-updater.js` | Actualiza knowledge_doc.md y pushea a GitHub |
| `core/github-issues.js` | Crea issues en el repo de backlog |
| `tenants/yeppo/amac.config.js` | Configuración específica del tenant Yeppo |

---

## 4. Configuración por tenant

Cada tenant tiene su propio `amac.config.js`:

```js
module.exports = {
  tenant: 'yeppo',

  // Canal donde llega el reporte semanal
  reportChannel: 'C0APVLMV98Q',  // #agente-aprendizaje

  // Canal de conversaciones a analizar
  conversationsChannel: 'C05FES87S9J',  // #team-servicio-al-cliente

  // Cron: viernes 18:00 Santiago
  cronSchedule: '0 18 * * 5',
  cronTimezone: 'America/Santiago',

  // Auto-aprobar cambios al knowledge sin intervención humana
  autoApproveKnowledge: true,

  // Umbrales para alertas
  thresholds: {
    minBotResolutionRate: 70,    // % mínimo de resolución del bot
    maxHumanResponseMin: 60,     // minutos máximos de respuesta humana
    maxIgnoredCases: 2           // casos ignorados máximos aceptables
  }
};
```

---

## 5. Variables de entorno requeridas

Configurar en Railway para cada tenant que use AMAC:

| Variable | Descripción | Obligatoria |
|----------|-------------|-------------|
| `DEEPSEEK_API_KEY` | API key de DeepSeek para análisis IA | ✅ |
| `SLACK_BOT_TOKEN` | Token del bot de Slack | ✅ |
| `SLACK_LEARNING_CHANNEL` | ID del canal #agente-aprendizaje | ✅ |
| `GITHUB_TOKEN` | Token GitHub para push knowledge + crear issues | ✅ |
| `GITHUB_REPO` | Repo del bot (default: `alejandrochungp/claw-whatsapp-agent`) | ❌ |
| `GITHUB_BACKLOG_REPO` | Repo de backlog (default: `Programaemprender/claw-platform-backlog`) | ❌ |

---

## 6. Cómo funciona cada ciclo

### 6.1 Fetch de conversaciones
Lee todas las conversaciones del canal Slack de la última semana (7 días). Por cada thread extrae:
- Mensajes del bot vs mensajes del agente humano
- Timestamps para calcular tiempos de respuesta
- Si hubo intervención humana o no

### 6.2 Cálculo de KPIs
- **Tasa de resolución bot:** % de conversaciones resueltas sin agente humano
- **Tiempo promedio de respuesta humana:** desde el primer mensaje del cliente hasta la primera respuesta del agente
- **Casos potencialmente ignorados:** conversaciones donde el bot no pudo resolver y no hubo respuesta humana en más de 2 horas

### 6.3 Análisis IA (DeepSeek V4 Pro)
Analiza las conversaciones en batches de 30 y detecta:

**Knowledge gaps:** Preguntas que el bot no supo responder o respondió mal. Se extraen como actualizaciones genéricas para el knowledge_doc.md.

> ⚠️ Regla crítica: NO se añaden recomendaciones de productos específicos para tipos de piel. Solo patrones genéricos (políticas, FAQs, procesos). Esto evita que el bot quede sesgado recomendando siempre lo mismo.

**Feature requests:** Acciones manuales repetitivas del agente que podrían automatizarse.

**Malas escalaciones:** Conversaciones que debieron ir a humano antes, o que no debieron ir.

### 6.4 Actualización del knowledge
Si se detectan gaps válidos:
1. DeepSeek genera el documento actualizado completo
2. Se guarda en `tenants/yeppo/knowledge/knowledge_doc.md`
3. Se pushea automáticamente a GitHub (Railway auto-despliega)
4. Se registra en `knowledge_stats.json`

### 6.5 Creación de issues en GitHub
Por cada feature request automatizable que no exista ya como issue:
- Se crea en `claw-platform-backlog` con labels apropiados
- Se incluye frecuencia, impacto, API disponible y ejemplo real
- Label `amac:auto-detected` para identificarlos

### 6.6 Reporte en Slack
Se publica en `#agente-aprendizaje` con:
- Resumen ejecutivo (conversaciones, bot%, humano%)
- Alertas de casos ignorados con timestamps
- Lista de features detectadas para ingeniería
- Cambios aplicados al knowledge
- Criterios de escalación a revisar

---

## 7. Reporte semanal — formato

```
📊 Reporte AMAC — 28 abr – 2 may 2026 | Tenant: yeppo

🟢 312 conversaciones | Bot: 85% | Humano: 15%
✅ Sin casos ignorados esta semana
⏱ Tiempo promedio de respuesta humana: 14 min

📚 Knowledge Base Actualizada
+ 3 nuevas FAQs detectadas
+ Política de retiro en tienda actualizada

🔧 Features para Ingeniería (4 detectadas)
1. Seguimiento estado de pedido — 30x esta semana (alto)
2. Verificación stock en tienda — 20x esta semana (alto)
3. Activación manual de cuentas — 12x esta semana (alto)
4. Cambio dirección de despacho — 8x esta semana (alto)
🔗 Issues creados: #15 #16

⚠️ Criterios de Escalación a Revisar
1. Clientes que preguntan por producto descontinuado...

_Reporte generado automáticamente por AMAC. Próximo: viernes 8 may._
```

---

## 8. Endpoints disponibles

Disponibles en el bot de Railway:

| Endpoint | Método | Descripción |
|----------|--------|-------------|
| `/admin/amac-run` | POST | Dispara un ciclo AMAC manualmente |
| `/admin/amac-status` | GET | Diagnóstico: verifica variables configuradas |

**Ejemplo:**
```bash
# Verificar configuración
curl https://yeppo-whatsapp-webhook-production.up.railway.app/admin/amac-status

# Disparar ciclo manual
curl -X POST https://yeppo-whatsapp-webhook-production.up.railway.app/admin/amac-run
```

---

## 9. Backlog de ingeniería

Repo: `github.com/Programaemprender/claw-platform-backlog`

### Sistema de labels
| Label | Descripción |
|-------|-------------|
| `tenant:yeppo` / `tenant:tupibox` / `tenant:all` | A qué tenant aplica |
| `layer:bot` / `layer:amac` / `layer:knowledge` | Componente afectado |
| `type:feature` / `type:bug` / `type:improvement` | Tipo de issue |
| `priority:high` / `priority:medium` / `priority:low` | Prioridad |
| `status:ready` / `status:pending-info` | Estado actual |
| `amac:auto-detected` | Detectado automáticamente por AMAC |

### Issues actuales (mayo 2026)
| # | Feature | Frecuencia | Prioridad | Estado |
|---|---------|-----------|-----------|--------|
| 1 | Consulta estado de pedido / tracking | 30x/sem | Alta | Ready |
| 2 | Consulta stock en tienda específica | 20x/sem | Alta | Ready |
| 3 | Cancelación automática de pedidos | 21x/sem | Media | ⏳ Esperando logística |
| 4 | Recuperar acceso a cuenta | - | Media | Pending info |
| 7 | Activación manual de cuentas | 12x/sem | Alta | Ready |
| 8 | Fusión de cuentas duplicadas | 3x/sem | Media | Ready |
| 9 | Cambio dirección de despacho | 8x/sem | Alta | Ready |
| 10 | Stock en tienda física | 20x/sem | Alta | Ready |
| 11 | Seguimiento estado de pedido | 30x/sem | Alta | Ready |

---

## 10. Extensión a nuevos tenants

Para activar AMAC en un nuevo tenant (ej: TupiBox):

1. Crear `tenants/tupibox/amac.config.js` con los IDs de canal correctos
2. Agregar las variables de entorno en Railway del tenant
3. En `server.js`, agregar condición:
```js
if (process.env.TENANT === 'tupibox') {
  const amacRunner = require('./amac-runner');
  const amacConfig = require('../tenants/tupibox/amac.config');
  amacRunner.startCron(amacConfig, 'tupibox');
}
```

---

## 11. Consideraciones técnicas

### Modelo IA
- **Análisis de conversaciones:** DeepSeek V4 Pro (`deepseek-v4-pro`)
- **Actualización knowledge:** DeepSeek V4 Pro (8.192 tokens de output)
- **Costo estimado:** ~$0.10–0.30 USD por ciclo semanal (1.113 convs)

### Rate limits Slack API
El fetch de conversaciones hace ~1 request/thread con 300ms de pausa. Para canales con >500 threads/semana considerar aumentar el intervalo.

### Timeout
El análisis de 73 conversaciones tarda ~8-12 min en Railway. El ciclo corre en background (no bloquea el webhook del bot).

### Regla crítica de knowledge
El módulo `knowledge-updater.js` filtra automáticamente cualquier sugerencia que contenga recomendaciones de productos específicos para tipos de piel. Esto es intencional para mantener el comportamiento dinámico del bot en asesorías de piel.

---

## 12. Historial de versiones

| Versión | Fecha | Cambios |
|---------|-------|---------|
| 1.0 | 2026-05-02 | Implementación inicial completa |

---

*Sistema diseñado y construido por Alejandro Chung + Claw (OpenClaw AI assistant)*
