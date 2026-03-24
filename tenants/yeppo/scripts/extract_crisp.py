"""
extract_crisp.py — Extrae conversaciones de Crisp y genera knowledge base
Uso: python extract_crisp.py
"""

import urllib.request
import urllib.error
import json
import base64
import time
import os
import sys

WEBSITE_ID = "0aaff274-e16d-4985-8d59-76e715e12e72"
IDENTIFIER = "b37a978c-dc73-47f7-8be7-6dda4dd8f2bd"
API_KEY    = "388f2e24cd2ab3d399339850759c40c3245c85017367807dbd3b05de8fab7cc8"

AUTH = base64.b64encode(f"{IDENTIFIER}:{API_KEY}".encode()).decode()
HEADERS = {"Authorization": f"Basic {AUTH}", "X-Crisp-Tier": "plugin"}

DELAY    = 0.25
MAX_PAGES = 30

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "knowledge")
os.makedirs(OUT_DIR, exist_ok=True)

def api_get(endpoint):
    url = f"https://api.crisp.chat/v1{endpoint}"
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())["data"]

def clean(text):
    if not text or not isinstance(text, str):
        return ""
    import re
    text = re.sub(r"https?://\S+", "[link]", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()

# 1. Listar conversaciones
print("📥 Descargando conversaciones...")
all_convs = []
for page in range(1, MAX_PAGES + 1):
    try:
        data = api_get(f"/website/{WEBSITE_ID}/conversations/{page}")
        if not data:
            break
        all_convs.extend(data)
        print(f"  Página {page}: {len(data)} (total: {len(all_convs)})", flush=True)
        if len(data) < 20:
            break
        time.sleep(DELAY)
    except Exception as e:
        print(f"  Error página {page}: {e}")
        break

print(f"✅ {len(all_convs)} conversaciones\n")

# 2. Mensajes
print("📨 Descargando mensajes...")
knowledge = []
skipped   = 0

for i, conv in enumerate(all_convs):
    sid = conv["session_id"]

    if i % 50 == 0:
        print(f"  [{i}/{len(all_convs)}] procesadas...", flush=True)

    try:
        msgs = api_get(f"/website/{WEBSITE_ID}/conversation/{sid}/messages")
        if not msgs:
            skipped += 1
            time.sleep(DELAY)
            continue

        text_msgs = [
            m for m in msgs
            if m.get("type") == "text"
            and isinstance(m.get("content"), str)
            and 2 < len(m["content"].strip()) < 1500
        ]

        if not any(m.get("from") == "operator" for m in text_msgs):
            skipped += 1
            time.sleep(DELAY)
            continue

        dialogue = "\n".join(
            f"{'Agente' if m['from'] == 'operator' else 'Cliente'}: {clean(m['content'])}"
            for m in text_msgs
        )

        origin = ""
        if conv.get("meta") and conv["meta"].get("origin"):
            origin = conv["meta"]["origin"]

        from datetime import datetime, timezone
        ts = conv["created_at"] / 1000
        date = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")

        knowledge.append({"channel": origin or "unknown", "date": date, "dialogue": dialogue})

    except Exception as e:
        skipped += 1

    time.sleep(DELAY)

print(f"\n✅ Con respuesta del equipo: {len(knowledge)}")
print(f"⏭️  Omitidas: {skipped}")

# 3. Guardar
kb_path = os.path.join(OUT_DIR, "knowledge_base.json")
with open(kb_path, "w", encoding="utf-8") as f:
    json.dump(knowledge, f, ensure_ascii=False, indent=2)
print(f"\n💾 Guardado: {kb_path}")

# 4. Stats
from collections import Counter
channels = Counter(c["channel"] for c in knowledge)
print("\n📊 Por canal:")
for ch, n in channels.most_common():
    print(f"   {ch}: {n}")

print("\n🎉 Listo!")
