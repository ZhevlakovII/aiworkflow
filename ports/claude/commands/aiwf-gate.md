---
description: Детерминированный design-гейт (gate-lint): source-ref + SP↔AD coverage + EARS-синтакс
argument-hint: --task <t> --spec <s> --adr <a>
allowed-tools: Bash(node:*), Read
---

Запусти механический design-гейт. Это **запуск линтера**, не свободное суждение.

```
node "$CLAUDE_PROJECT_DIR/core/src/design/gate-lint-cli.ts" $ARGUMENTS
```

- Exit 0 = PASS. Exit 1 = BOUNCE (вернуть producer'у с findings линтера).
- Проверяет: SP source-ref (анти-фабрикация), SP↔AD coverage, EARS-синтакс FR.
- Ты НЕ вправе объявить PASS при ненулевом exit. Доложи findings дословно.
