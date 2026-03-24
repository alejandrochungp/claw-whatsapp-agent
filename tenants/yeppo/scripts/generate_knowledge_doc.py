"""
generate_knowledge_doc.py
Lee knowledge_base.json y genera un documento de conocimiento
estructurado para el agente usando Claude.

Procesa en batches para no exceder context window.
"""
import json, os, sys, urllib.request, urllib.error, time

CLAUDE_API_KEY = os.environ.get("CLAUDE_API_KEY", "")
if not CLAUDE_API_KEY:
    key_path = os.path.join(os.path.dirname(__file__), "../../../../.secrets/claude_yeppo_key.txt")
    if os.path.exists(key_path):
        with open(key_path) as f:
            CLAUDE_API_KEY = f.read().strip()
CLAUDE_MODEL   = "claude-sonnet-4-6"

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "knowledge")

def claude(prompt, system=""):
    import urllib.request, json
    body = json.dumps({
        "model": CLAUDE_MODEL,
        "max_tokens": 4096,
        "system": system,
        "messages": [{"role": "user", "content": prompt}]
    }).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        headers={
            "x-api-key": CLAUDE_API_KEY,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json"
        }
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())["content"][0]["text"]

def clean_dialogue(text):
    import re
    # Remover artefactos de Slack/Crisp
    text = re.sub(r'_\$\{color\}\[.*?\]\(.*?\)_', '', text)
    text = re.sub(r'---\s*\n', '', text)
    text = re.sub(r'\[link\]', '[enlace]', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()

# Cargar knowledge base
with open(os.path.join(OUT_DIR, "knowledge_base.json"), encoding="utf-8") as f:
    kb = json.load(f)

print(f"Cargadas {len(kb)} conversaciones")

# Limpiar diálogos
for c in kb:
    c["dialogue"] = clean_dialogue(c["dialogue"])

# Filtrar muy cortas (poco valor)
kb = [c for c in kb if len(c["dialogue"]) > 80]
print(f"Después de filtrar cortas: {len(kb)}")

# Agrupar por canal para contexto
by_channel = {}
for c in kb:
    ch = c["channel"].replace("urn:crisp.im:", "").replace(":0", "")
    if ch not in by_channel:
        by_channel[ch] = []
    by_channel[ch].append(c["dialogue"])

# Procesar en 3 batches (por temas/canales)
SYSTEM = """Eres un experto en atención al cliente. Tu tarea es analizar conversaciones reales 
entre el equipo de Yeppo y sus clientes, y extraer conocimiento estructurado para entrenar a un agente de IA.

Yeppo es una tienda de cosméticos coreanos ubicada en Patronato, Santiago de Chile.
Tiene tienda física y tienda online (yeppo.cl)."""

# Batch 1: Chat web (92 convs)
print("\nProcesando batch 1: Chat web...")
chat_sample = "\n\n---\n\n".join(by_channel.get("chat", [])[:40])
prompt1 = f"""Analiza estas {len(by_channel.get('chat', []))} conversaciones del chat web de Yeppo y extrae:

1. **Preguntas frecuentes** y cómo las respondía el equipo (con el tono exacto)
2. **Políticas y procesos** mencionados (devoluciones, despachos, mayoristas, asesorías, etc.)
3. **Productos y servicios** más consultados
4. **Frases y expresiones** características del equipo
5. **Casos especiales** que requieren manejo particular

CONVERSACIONES:
{chat_sample}

Estructura el resultado como un documento de referencia claro y conciso."""

result1 = claude(prompt1, SYSTEM)
print("  Batch 1 OK")
time.sleep(2)

# Batch 2: WhatsApp (57 convs)
print("Procesando batch 2: WhatsApp...")
wa_sample = "\n\n---\n\n".join(by_channel.get("whatsapp", [])[:40])
prompt2 = f"""Analiza estas conversaciones de WhatsApp de Yeppo y extrae lo mismo que antes,
PERO enfócate especialmente en:
- Consultas de horarios y ubicación
- Consultas sobre despacho/delivery
- Reclamos y cómo se resolvieron
- Consultas de mayoristas por WhatsApp

CONVERSACIONES:
{wa_sample}

Complementa con información nueva que no esté ya capturada en el análisis previo."""

result2 = claude(prompt2, SYSTEM)
print("  Batch 2 OK")
time.sleep(2)

# Batch 3: Instagram + síntesis final
print("Procesando batch 3: Instagram + síntesis final...")
ig_sample = "\n\n---\n\n".join(by_channel.get("instagram", [])[:20])
all_analysis = f"ANÁLISIS CHAT WEB:\n{result1}\n\nANÁLISIS WHATSAPP:\n{result2}"

prompt3 = f"""Con base en estos dos análisis previos de conversaciones de Yeppo, más estas conversaciones de Instagram:

INSTAGRAM:
{ig_sample}

Genera el DOCUMENTO FINAL DE CONOCIMIENTO para el agente de IA de Yeppo. 

El documento debe incluir:

# BASE DE CONOCIMIENTO — YEPPO

## 1. Quiénes somos
(descripción de Yeppo basada en las conversaciones)

## 2. Productos y servicios
(qué venden, servicios especiales como asesoría gratuita, etc.)

## 3. Preguntas frecuentes y respuestas
(las preguntas más comunes con la forma exacta de responderlas, usando el tono del equipo)

## 4. Políticas operativas
(devoluciones, despachos, mayoristas, horarios, etc.)

## 5. Tono y estilo de comunicación
(cómo habla el equipo de Yeppo con los clientes)

## 6. Casos especiales
(situaciones que requieren manejo particular: reclamos, pedidos cambiados, etc.)

## 7. Lo que NO hace el agente
(límites claros: cuándo derivar a humano)

Usa el tono y vocabulario real del equipo, no genérico. 
Sé específico con ejemplos reales cuando ayude.

{all_analysis}"""

result3 = claude(prompt3, SYSTEM)
print("  Batch 3 OK")

# Guardar documento final
doc_path = os.path.join(OUT_DIR, "knowledge_doc.md")
with open(doc_path, "w", encoding="utf-8") as f:
    f.write(result3)

print(f"\nDocumento guardado: {doc_path}")
print(f"Tamaño: {len(result3)} chars")
