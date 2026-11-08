---
description: L2 push/PR-рельс (gated_push): protected-check + clean-tree + ahead → push -u [+ PR]
argument-hint: [--pr --base <branch> --title "<t>"]
allowed-tools: Bash(node:*), Read
---

Push ТОЛЬКО через рельс (raw `git push`/`merge` блокированы).

```
node "$CLAUDE_PROJECT_DIR/core/src/rails/cli.ts" push $ARGUMENTS
```

Гейт доставки: ветка НЕ protected + дерево ЧИСТОЕ + есть коммиты вперёд. Пушит feature-ветку `-u`; с `--pr` открывает PR через `gh`. **Merge апрувит человек (L2).**

Доложи результат/причину отказа.
