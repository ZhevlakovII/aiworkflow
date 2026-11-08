---
description: L1 commit-рельс (gated_commit): stage→zone-check→test-cmd→commit только на зелёном
argument-hint: -m "<message>" [--gate "<cmd>"]
allowed-tools: Bash(node:*), Read
---

Коммить ТОЛЬКО через рельс (raw `git commit` блокирует zone-guard hook).

```
node "$CLAUDE_PROJECT_DIR/core/src/rails/cli.ts" commit $ARGUMENTS
```

Рельс: `git add -A` → zone-check staged → test-cmd → `git commit` только на зелёном. Staged вне зоны ИЛИ красный тест = нет коммита (staged сброшен). Детерминированно, неважно кто писал.

Активная worker-зона (`.workflow/active-zone.json` существует):
- каждый staged путь проверяется против её `allow`/`deny` — вне `allow` или в `deny` → `zone-violation`, коммита нет;
- битый файл (не JSON / нет `task` / `allow` не string[] / `deny` не string[]) → `zone-invalid`, коммит отклонён (fail-closed);
- `--gate` **запрещён** → `gate-override-denied`; эффективный гейт = `test-cmd` из task-file активной задачи
  (`.workflow/tasks/<task>.md`), иначе `policy.quality_gate.cmd`, иначе без гейта. Task-file отсутствует, не
  разбирается (нет frontmatter/`zone`-блока/`zone.allow`), или `test-cmd` пуст/только пробелы → `zone-invalid`
  (fail-closed), НИКОГДА тихий фоллбэк на policy. Вывод рельса называет источник (`gate: task|policy|none`), и не
  называет его, если гейт фактически не выполнился (`none (disabled)` / `none (not reached)`).

Нет файла → прежнее поведение (`--gate "<cmd>"` переопределяет гейт).

A2 (U13), task-scoped исключение из `operator_zone.protected` (напр. `.omp/**`): staged путь под protected-корнем
(НЕ `.git`) допускается ТОЛЬКО если разом — валидная активная зона; task-file `.workflow/tasks/<task>.md` явно
разрешает его (`zone.allow`-глоб начинается с `<protected>/`, широкие `**`/`*` не считаются явным разрешением) и не
денаит его `zone.deny`; путь покрыт `allow` активной зоны и не покрыт её `deny`. Не хватает условия — прежний
`zone-violation`; битый/отсутствующий task-file — `zone-invalid` (fail-closed). `.git` не освобождается никогда.

Доложи: коммит SHA или причину отказа. Не объявляй успех при ненулевом exit.
