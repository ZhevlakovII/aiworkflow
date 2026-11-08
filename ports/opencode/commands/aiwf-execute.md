---
description: "Execute-стадия (тул execute_session): begin→spawn domain→check→done→gated_commit"
---

Execute-стадия залоченного контракта — нативный тул `execute_session`. Ты — оркестратор, НЕ производишь код сам. Тул: резолвит домен-агента из `.opencode/zonemap.yml` + пишет active-zone → ты спавнишь native executor/domain → `check` (zoneCheck staged) → `done` → `gated_commit`.

```
execute_session(step="begin"|"check"|"done", task="<task-file>")
```

Поток: `begin` (judge + domain handoff + active-zone.json) → spawn native agent в allow-зоне → `check` → `done` → `gated_commit(task=...)`.
