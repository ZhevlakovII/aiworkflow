---
description: "Roadmap-стадия (тул roadmap_session): begin→spawn roadmapper→check→done→gated_commit"
---

Roadmap-стадия между design lock и execute — нативный тул `roadmap_session` (`generation: spec-roadmap`). Ты — оркестратор, НЕ производишь roadmap сам. Тул: пишет active-zone (`by:judge`) + fixed agent `roadmapper` → ты спавнишь native roadmapper → `check` (zoneCheck staged) → `done` → `gated_commit`.

```
roadmap_session(step="begin"|"check"|"done", task="<task-file>")
```

Поток: `begin` (judge roadmap-started + active-zone.json + roadmapper handoff) → spawn native `roadmapper` в allow-зоне → `check` → `done` → `gated_commit(task=...)`.
