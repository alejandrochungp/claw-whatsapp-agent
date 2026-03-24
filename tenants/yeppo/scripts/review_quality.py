"""
Revisa calidad de las conversaciones extraídas
"""
import json, os, sys

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "knowledge")

with open(os.path.join(OUT_DIR, "knowledge_base.json"), encoding="utf-8") as f:
    kb = json.load(f)

print(f"Total: {len(kb)} conversaciones\n")

# Stats generales
from collections import Counter
channels = Counter(c["channel"] for c in kb)
print("Por canal:")
for ch, n in channels.most_common():
    print(f"  {ch}: {n}")

# Largo promedio de diálogos
avg_len = sum(len(c["dialogue"]) for c in kb) / len(kb)
print(f"\nLargo promedio diálogo: {avg_len:.0f} chars")

# Conversaciones muy cortas (posible baja calidad)
short = [c for c in kb if len(c["dialogue"]) < 100]
print(f"Muy cortas (<100 chars): {len(short)}")

# Mostrar muestra variada
print("\n" + "="*60)
print("MUESTRA DE CONVERSACIONES")
print("="*60)

# 3 de chat, 3 de whatsapp, 2 de instagram
samples = []
for ch in ["chat", "urn:crisp.im:whatsapp:0", "urn:crisp.im:instagram:0"]:
    convs = [c for c in kb if c["channel"] == ch]
    samples.extend(convs[:3])

for i, conv in enumerate(samples[:8]):
    canal = conv["channel"].replace("urn:crisp.im:", "").replace(":0", "")
    print(f"\n--- [{i+1}] {canal} | {conv['date']} ---")
    print(conv["dialogue"][:600])
    if len(conv["dialogue"]) > 600:
        print("...")
