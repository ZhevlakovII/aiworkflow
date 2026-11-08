---
description: "L1 commit-рельс (тул gated_commit): stage→zone-check→test-cmd→commit только на зелёном"
---

Коммить ТОЛЬКО через рельс — нативный тул `gated_commit` (raw `git commit` блокирует zone-guard plugin).

Аргументы: $ARGUMENTS (commit message; опц. task-file для зоны).

Вызови тул:
```
gated_commit(message="<msg>", task?="<task-file>")
```

Рельс: `git add -A` → zone-check staged (из зоны task-file) → test-cmd → `git commit` только на зелёном. Staged вне зоны ИЛИ красный тест = нет коммита (staged сброшен). Детерминированно, неважно кто писал.

Доложи: коммит SHA или причину отказа. Не объявляй успех при ошибке тула.
