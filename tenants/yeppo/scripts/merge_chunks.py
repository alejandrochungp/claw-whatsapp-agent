import json, os, sys
from collections import Counter

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "knowledge")
all_results = []

chunks = sorted([f for f in os.listdir(OUT_DIR) if f.startswith("chunk_")])
for chunk in chunks:
    with open(os.path.join(OUT_DIR, chunk), encoding="utf-8") as f:
        data = json.load(f)
    print(f"{chunk}: {len(data)}")
    all_results.extend(data)

print(f"\nTOTAL: {len(all_results)} conversaciones con respuesta del equipo")

if all_results:
    print("\n--- Ejemplo ---")
    ex = all_results[0]
    print(f"Canal: {ex['channel']}")
    print(f"Fecha: {ex['date']}")
    print("Dialogo (primeros 500 chars):")
    print(ex["dialogue"][:500])

channels = Counter(c["channel"] for c in all_results)
print("\nPor canal:")
for ch, n in channels.most_common():
    print(f"  {ch}: {n}")

out_path = os.path.join(OUT_DIR, "knowledge_base.json")
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(all_results, f, ensure_ascii=False, indent=2)
print(f"\nGuardado: {out_path}")
