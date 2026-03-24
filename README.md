# claw-whatsapp-agent

Agente WhatsApp multi-tenant con IA (Claude). Un solo repo, múltiples negocios.

## Arquitectura

```
index.js          ← entry point, carga tenant via TENANT=xxx
core/
  server.js       ← webhook Express genérico
  ai.js           ← Claude API
  slack.js        ← supervisión + handoff humano
  memory.js       ← historial de conversaciones
  meta.js         ← envío de mensajes WhatsApp
  logger.js       ← logging
tenants/
  yeppo/
    config.js     ← número, tokens, canales
    prompt.md     ← personalidad del bot
    business.js   ← reglas rápidas + systemPrompt
  tupibox/
    config.js
    prompt.md
    business.js
```

## Agregar un nuevo negocio

1. Crear carpeta `tenants/mi-negocio/`
2. Copiar los 3 archivos de cualquier tenant como base
3. Editar `config.js`, `prompt.md` y `business.js`
4. En Railway: crear nuevo service con `TENANT=mi-negocio`

## Deploy en Railway

Cada tenant es un **service separado** en el mismo repo:

| Service        | Variable         | Webhook URL                                    |
|----------------|------------------|------------------------------------------------|
| yeppo          | `TENANT=yeppo`   | `https://yeppo-agent.railway.app/webhook`      |
| tupibox        | `TENANT=tupibox` | `https://tupibox-agent.railway.app/webhook`    |

### Variables de entorno por service

Copiar `.env.example` y completar con los valores del negocio correspondiente.

## Variables requeridas

| Variable | Descripción |
|---|---|
| `TENANT` | Nombre del tenant (carpeta en `tenants/`) |
| `WHATSAPP_ACCESS_TOKEN` | Token de Meta Cloud API |
| `PHONE_NUMBER_ID` | ID del número en Meta |
| `WEBHOOK_VERIFY_TOKEN` | Token de verificación del webhook |
| `CLAUDE_API_KEY` | API key de Anthropic |
| `SLACK_BOT_TOKEN` | Token del bot de Slack |
| `SLACK_CHANNEL_ID` | ID del canal de supervisión |

## Desarrollo local

```bash
npm install
cp .env.example .env
# Editar .env con tus valores
TENANT=yeppo node index.js
```

## Health check

```
GET /status
```

Retorna `{ ok: true, tenant: "yeppo", phone: "+56...", uptime: 123 }`
