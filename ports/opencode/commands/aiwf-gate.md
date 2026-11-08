---
description: "Детерминированный design-гейт (тул gate_lint): source-ref + SP↔AD coverage + EARS-синтакс"
---

Запусти механический design-гейт — нативный тул `gate_lint`. Это **запуск линтера**, не свободное суждение.

Аргументы: $ARGUMENTS (task/spec/adr пути).

Вызови тул:
```
gate_lint(task="<task>", spec="<spec>", adr="<adr>")
```

- GATE PASS = findings пусто. GATE BOUNCE = вернуть producer'у с findings линтера.
- Проверяет: SP source-ref (анти-фабрикация), SP↔AD coverage, EARS-синтакс FR.
- Ты НЕ вправе объявить PASS при BOUNCE. Доложи findings дословно.
