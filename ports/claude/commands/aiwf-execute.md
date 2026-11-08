---
description: Execute-стадия (CC-нативно): резолв домен-агента из зоны → subagent пишет в зоне → gated_commit
argument-hint: <task-file>
allowed-tools: Bash, Read, Grep, Glob, Task
---

Execute-стадия залоченного контракта. **CC-адаптация** (не буквальный порт OMP execute_worker.ts): вместо nested `claude -p` используем CC-нативные субагенты, enforcement — на коммите (`gated_commit` zone-check). Ты — оркестратор, НЕ производишь код сам.

Task-file: `$ARGUMENTS`

Шаги:
1. **Прочитай task-file.** Возьми `allow`-зону (глобы), `test-cmd` (если есть), DoD. Запомни id задачи — basename
   task-file без `.md` (напр. `.workflow/tasks/a5a-foo.md` → `a5a-foo`).
2. **Резолв домен-агента** из зоны — механически, через CLI (не проза, не выбор моделью):
   ```
   node "$CLAUDE_PROJECT_DIR/core/src/zone/zonemap-cli.ts" --zonemap ".omp/zonemap.yml" --allow "<glob1>" --allow "<glob2>" ...
   ```
   (по одному `--allow` на каждый глоб из allow-зоны task-file; `.omp/zonemap.yml` — путь ПРОЕКТА, не клона фреймворка —
   CC запускает команды из корня проекта, поэтому относительный путь.) Exit 0 → stdout = имя резолвнутого агента. Exit 3
   (ambiguous, зона задевает >1 домен) или exit 4 (denied-domain, глоб попал в legacy `deny-domain`) → **стоп и вопрос
   юзеру** (не выбор моделью, не рационализация дефолтом). Exit 2 — usage-ошибка (проверь путь/аргументы).
2.5. **Запиши worker-зону** (контракт T7-0 L-1/L-6) — `.workflow/active-zone.json`:
   ```json
   {"task": "<id задачи из шага 1, БЕЗ пути и без .md>", "allow": ["<globs из task-file>", ".workflow/ledger/**"]}
   ```
   (`.workflow/ledger/**` — только если субагенту нужно писать отчёт туда). Хук читает этот файл для actor=worker (PreToolUse Write/Edit/Bash); без него — fail-closed deny на любую запись субагента. `task` — ИМЕННО id (рельс валидирует его как `[A-Za-z0-9._-]`, путь провалит проверку → `zone-invalid`).
3. **Спавни субагента** (Task tool, `subagent_type` = резолвнутый агент; при широком blast-radius — `isolation: "worktree"`). Передай: task-file pointer, allow-зону, DoD, «не выходи за зону, коммит НЕ сам». Дай узкий return (pointer+summary), не тело.
4. **Commit через рельс** — НЕ raw git, БЕЗ `--gate` (при активной зоне `--gate` запрещён рельсом — `gate-override-denied`; gate-check делает сам L1):
   ```
   node "$CLAUDE_PROJECT_DIR/core/src/rails/cli.ts" commit -m "<msg>"
   ```
   Рельс сам: стейджит, проверяет staged против зоны, резолвит эффективный гейт — `test-cmd` из task-file активной
   задачи (`.workflow/active-zone.json`'s `task`), иначе `policy.quality_gate.cmd`, иначе без гейта — и коммитит только
   на зелёном. Staged вне зоны / красный гейт / task-file отсутствует, не разбирается или его `test-cmd` пуст
   (`zone-invalid`, НИКОГДА тихий фоллбэк) = нет коммита. Вывод рельса называет источник гейта (`gate:
   task|policy|none`, или `none (disabled)`/`none (not reached)` если гейт фактически не выполнился) — доложи его.
5. **Удали `.workflow/active-zone.json`** (worker-зона больше не нужна) ПОСЛЕ коммита и **дай Report:** изменённые файлы, зона OK/violation, источник и статус гейта, коммит.

Не проси субагента обходить zone-guard. Красный zone-check → патч не принимается (не рационализируй).
