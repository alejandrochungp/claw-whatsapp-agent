import json, os, sys
from collections import Counter

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "knowledge")
all_results = []

# Usar los chunks más recientes (los que tienen datos completos)
# Priorizar chunks nuevos sobre los viejos (los de 50 en 50 que fallaron)
chunk_ranges = [
    (0, 50), (50, 100), (100, 150), (150, 200),
    (200, 300), (300, 400), (400, 500), (500, 600)
]

for start, end in chunk_ranges:
    # Buscar chunk con este rango
    fname = f"chunk_{start:03d}_{end:03d}.json"
    fpath = os.path.join(OUT_DIR, fname)
    if os.path.exists(fpath):
        with open(fpath, encoding="utf-8") as f:
            data = json.load(f)
        print(f"{fname}: {len(data)}")
        all_results.extend(data)
    else:
        print(f"{fname}: no encontrado")

print(f"\nTOTAL: {len(all_results)} conversaciones con respuesta del equipo")

channels = Counter(c["channel"] for c in all_results)
print("\nPor canal:")
for ch, n in channels.most_common():
    print(f"  {ch}: {n}")

out_path = os.path.join(OUT_DIR, "knowledge_base.json")
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(all_results, f, ensure_ascii=False, indent=2)
print(f"\nGuardado: {out_path}")
