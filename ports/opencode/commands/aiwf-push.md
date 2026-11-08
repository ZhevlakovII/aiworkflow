---
description: "L2 push/PR-рельс (тул gated_push): protected-check + clean-tree + ahead → push -u [+ PR]"
---

Push ТОЛЬКО через рельс — нативный тул `gated_push` (raw `git push`/`merge` блокированы).

Аргументы: $ARGUMENTS (опц. pr/base/title/remote).

Вызови тул:
```
gated_push(pr?=true, base?="main", title?="<t>", remote?="origin")
```

Гейт доставки: ветка НЕ protected + дерево ЧИСТОЕ + есть коммиты вперёд. Пушит feature-ветку `-u`; с `pr:true` открывает PR через `gh`. **Merge апрувит человек (L2).**

Доложи результат/причину отказа.
