import urllib.request, json, base64, time, os, re, sys
from datetime import datetime, timezone

WEBSITE_ID = "0aaff274-e16d-4985-8d59-76e715e12e72"
IDENTIFIER = "b37a978c-dc73-47f7-8be7-6dda4dd8f2bd"
API_KEY    = "388f2e24cd2ab3d399339850759c40c3245c85017367807dbd3b05de8fab7cc8"
AUTH = base64.b64encode(f"{IDENTIFIER}:{API_KEY}".encode()).decode()
HEADERS = {"Authorization": f"Basic {AUTH}", "X-Crisp-Tier": "plugin"}
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "knowledge")

START = int(sys.argv[1]) if len(sys.argv) > 1 else 0
END   = int(sys.argv[2]) if len(sys.argv) > 2 else 50

def api_get(endpoint):
    for attempt in range(3):
        try:
            req = urllib.request.Request(f"https://api.crisp.chat/v1{endpoint}", headers=HEADERS)
            with urllib.request.urlopen(req, timeout=15) as r:
                return json.loads(r.read().decode())["data"]
        except urllib.error.HTTPError as e:
            if e.code == 429:
                wait = 5 * (attempt + 1)
                print(f"  429 rate limit, esperando {wait}s...", flush=True)
                time.sleep(wait)
            else:
                raise
    raise Exception("Max retries exceeded (429)")

def clean(text):
    if not text or not isinstance(text, str): return ""
    text = re.sub(r"https?://\S+", "[link]", text)
    return text.strip()

with open(os.path.join(OUT_DIR, "convs_list.json"), encoding="utf-8") as f:
    all_convs = json.load(f)

print(f"Procesando {START}-{END} de {len(all_convs)}...")
sys.stdout.flush()

results = []
skipped = 0

for conv in all_convs[START:END]:
    sid = conv["session_id"]
    try:
        msgs = api_get(f"/website/{WEBSITE_ID}/conversation/{sid}/messages")
        text_msgs = [
            m for m in msgs
            if m.get("type") == "text"
            and isinstance(m.get("content"), str)
            and 2 < len(m["content"].strip()) < 1500
        ]
        if not any(m.get("from") == "operator" for m in text_msgs):
            skipped += 1
        else:
            lines = []
            for m in text_msgs:
                role = "Agente" if m["from"] == "operator" else "Cliente"
                lines.append(f"{role}: {clean(m['content'])}")
            dialogue = "\n".join(lines)
            origin = (conv.get("meta") or {}).get("origin", "unknown")
            ts = datetime.fromtimestamp(conv["created_at"] / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
            results.append({"channel": origin, "date": ts, "dialogue": dialogue})
    except Exception as e:
        skipped += 1
    time.sleep(0.8)

chunk_name = f"chunk_{START:03d}_{END:03d}.json"
out_path = os.path.join(OUT_DIR, chunk_name)
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(results, f, ensure_ascii=False, indent=2)

print(f"OK: {len(results)} con respuesta, {skipped} omitidas -> {chunk_name}")
sys.stdout.flush()
