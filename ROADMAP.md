
## Mejora Futura — Sistema de Aprendizaje Autónomo

**Idea:** Analizar conversaciones en Redis para que el agente mejore solo con el tiempo.

**Flujo:**
- Cada N conversaciones ? job analiza patrones
- Actualizaciones de bajo riesgo (FAQs, horarios, precios) ? auto-aprobadas al knowledge_doc.md
- Info sensible o inconsistente ? postea en canal Slack #agente-aprendizaje con botones Aprobar/Editar/Rechazar
- Respuestas corregidas por humano vía 	omar ? capturadas como "mejor respuesta"

**Beneficio:** Agente mejora autónomamente, con supervisión humana en lo sensible.

**Estado:** Pendiente — priorizar cuando el volumen de conversaciones justifique el esfuerzo.
