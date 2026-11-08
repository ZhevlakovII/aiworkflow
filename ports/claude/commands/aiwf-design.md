---
description: Design-стадия (детерминир. драйвер): producer→gate_lint→bounce→critic→ledger→commit
argument-hint: <task-file> [--model sonnet|opus]
allowed-tools: Bash(node:*), Read
---

Запусти **детерминированный** design-драйвер. НЕ оркеструй сам, НЕ пиши spec/ADR сам — драйвер (`core/src/design/design-stage-cli.ts`) ведёт поток через `claude -p` (producer→gate_lint→1 bounce-retry→critic→ledger→commit). Твоя роль — запустить и доложить вердикт.

Выполни:
```
node "$CLAUDE_PROJECT_DIR/core/src/design/design-stage-cli.ts" --task $ARGUMENTS
```

Правила:
- Exit 0 = design locked+committed. Exit 1 = bounced/blocked (НЕ закоммичено — доложи findings из ledger). Exit 2 = ошибка драйвера.
- Не объявляй PASS при ненулевом exit. Не рационализируй красный гейт.
- После завершения — краткий report: вердикт гейта, critic-severity, путь к spec/ADR/ledger, статус коммита.
