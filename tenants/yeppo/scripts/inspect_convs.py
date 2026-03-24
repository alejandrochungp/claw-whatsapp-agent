"""
Inspecciona conversaciones en un rango para entender por qué fueron omitidas
"""
import urllib.request, json, base64, time, os, sys

WEBSITE_ID = "0aaff274-e16d-4985-8d59-76e715e12e72"
IDENTIFIER = "b37a978c-dc73-47f7-8be7-6dda4dd8f2bd"
API_KEY    = "388f2e24cd2ab3d399339850759c40c3245c85017367807dbd3b05de8fab7cc8"
AUTH = base64.b64encode(f"{IDENTIFIER}:{API_KEY}".encode()).decode()
HEADERS = {"Authorization": f"Basic {AUTH}", "X-Crisp-Tier": "plugin"}
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "knowledge")

START = int(sys.argv[1]) if len(sys.argv) > 1 else 200
END   = int(sys.argv[2]) if len(sys.argv) > 2 else 205

def api_get(endpoint):
    req = urllib.request.Request(f"https://api.crisp.chat/v1{endpoint}", headers=HEADERS)
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())["data"]

with open(os.path.join(OUT_DIR, "convs_list.json"), encoding="utf-8") as f:
    all_convs = json.load(f)

for i, conv in enumerate(all_convs[START:END], START):
    sid = conv["session_id"]
    origin = (conv.get("meta") or {}).get("origin", "unknown")
    last_msg = conv.get("last_message", "")
    preview = conv.get("preview_message", {})
    preview_from = preview.get("from", "?") if preview else "?"

    print(f"\n[{i}] {sid[:20]}... | canal: {origin} | ultimo_from: {preview_from}")
    print(f"     ultimo_msg: {str(last_msg)[:80]}")

    try:
        msgs = api_get(f"/website/{WEBSITE_ID}/conversation/{sid}/messages")
        total = len(msgs)
        text_msgs = [m for m in msgs if m.get("type") == "text" and isinstance(m.get("content"), str)]
        operators = [m for m in text_msgs if m.get("from") == "operator"]
        users = [m for m in text_msgs if m.get("from") == "user"]

        print(f"     msgs totales: {total} | texto: {len(text_msgs)} | operador: {len(operators)} | usuario: {len(users)}")

        if operators:
            print(f"     primer operador: {operators[0]['content'][:80]}")
        elif text_msgs:
            # Ver qué roles hay
            roles = set(m.get("from","?") for m in msgs)
            print(f"     roles encontrados: {roles}")
            if text_msgs:
                print(f"     primer msg ({text_msgs[0].get('from')}): {text_msgs[0]['content'][:80]}")
    except Exception as e:
        print(f"     ERROR: {e}")

    time.sleep(0.2)
