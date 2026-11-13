---
description: "Scaffold-стадия (legacy): только sp-adr + lever; новый путь — /aiwf-roadmap"
---

**Legacy only.** На `generation: spec-roadmap` используй `/aiwf-roadmap` (`roadmap_session` + `roadmapper`). `scaffold_session` отказывает на new generation.

Scaffold остаётся для legacy `generation: sp-adr` (или absent) **с** рычагом scaffold on:

```
scaffold_session(step="begin"|"check"|"done", task="<task-file>")
```

Поток: `begin` → spawn native `scaffolder` → `check` → `done` → `gated_commit(task=...)`.
