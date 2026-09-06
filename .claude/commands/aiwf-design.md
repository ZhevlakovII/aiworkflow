---
description: Design-стадия (детерминир. драйвер): producer→gate_lint→bounce→critic→ledger→gated_commit
argument-hint: <task-file> [--model sonnet|opus]
allowed-tools: Bash(python:*), Read
---

Запусти **детерминированный** design-драйвер. НЕ оркеструй сам, НЕ пиши spec/ADR сам — драйвер (`tools/design_stage.py`) ведёт поток через `claude -p` (producer→gate_lint→1 bounce-retry→critic→ledger→gated_commit). Твоя роль — запустить и доложить вердикт.

Выполни:
```
python tools/design_stage.py --task $ARGUMENTS
```

Правила:
- Exit 0 = design locked+committed. Exit 1 = bounced/blocked (НЕ закоммичено — доложи findings из ledger). Exit 2 = ошибка драйвера.
- Не объявляй PASS при ненулевом exit. Не рационализируй красный гейт.
- После завершения — краткий report: вердикт гейта, critic-severity, путь к spec/ADR/ledger, статус коммита.
