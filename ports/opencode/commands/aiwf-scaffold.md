---
description: "Scaffold-стадия (тул scaffold_session): begin→spawn scaffolder→check→done→gated_commit"
---

Scaffold-стадия между design lock и execute — нативный тул `scaffold_session`. Ты — оркестратор, НЕ производишь каркас сам. Тул: пишет active-zone (`by:judge`) + fixed agent `scaffolder` → ты спавнишь native scaffolder → `check` (zoneCheck staged) → `done` → `gated_commit`.

```
scaffold_session(step="begin"|"check"|"done", task="<task-file>")
```

Поток: `begin` (judge scaffold-started + active-zone.json + scaffolder handoff) → spawn native `scaffolder` в allow-зоне → `check` → `done` → `gated_commit(task=...)`.
