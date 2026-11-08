---
description: "Design-стадия (тул design_session): begin→producer→gate→critic→lock→gated_commit"
---

Запусти **in-session** design-драйвер — нативный тул `design_session`. НЕ пиши spec/ADR сам: диспатчь шаги тула и спавнь native producer/critic. Модели внутри `design_session` не вызываются. Твоя роль — оркестрировать шаги и доложить вердикт.

```
design_session(step="begin"|"gate"|"critic-record"|"lock", task="<task-file>", findings?)
```

Поток: `begin` → spawn producer → `gate` (gateLint + judge; 1 bounce-retry) → spawn critic → `critic-record` (budget 1) → `lock` → `gated_commit`. Locked только при gate PASS + нет blocker/major от critic.
