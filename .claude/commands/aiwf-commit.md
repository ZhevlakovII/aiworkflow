---
description: L1 commit-рельс (gated_commit): stage→zone-check→test-cmd→commit только на зелёном
argument-hint: -m "<message>" [--gate "<cmd>"]
allowed-tools: Bash(python:*), Read
---

Коммить ТОЛЬКО через рельс (raw `git commit` блокирует zone-guard hook).

```
python tools/gated_commit.py $ARGUMENTS
```

Рельс: `git add -A` → zone-check staged (из зоны task-file / `--gate`) → test-cmd → `git commit` только на зелёном. Staged вне зоны ИЛИ красный тест = нет коммита (staged сброшен). Детерминированно, неважно кто писал.

Доложи: коммит SHA или причину отказа. Не объявляй успех при ненулевом exit.
