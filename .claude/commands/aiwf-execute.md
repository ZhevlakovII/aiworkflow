---
description: Execute-стадия (CC-нативно): резолв домен-агента из зоны → subagent пишет в зоне → gated_commit
argument-hint: <task-file>
allowed-tools: Bash, Read, Grep, Glob, Task
---

Execute-стадия залоченного контракта. **CC-адаптация** (не буквальный порт OMP execute_worker.ts): вместо nested `claude -p` используем CC-нативные субагенты, enforcement — на коммите (`gated_commit` zone-check). Ты — оркестратор, НЕ производишь код сам.

Task-file: `$ARGUMENTS`

Шаги:
1. **Прочитай task-file.** Возьми `allow`-зону (глобы), `test-cmd` (если есть), DoD.
2. **Резолв домен-агента** из зоны по `.omp/zonemap.yml` (первый матч по специфичности):
   - `core/**|features/**|tools/**|instances/**|root/**` → `kmp-developer`
   - `build-logic/**` → `gradle-developer`
   - `bot/**` → `go-developer`
   - иначе / несколько доменов (ambiguous) → `executor`
3. **Спавни субагента** (Task tool, `subagent_type` = резолвнутый агент; при широком blast-radius — `isolation: "worktree"`). Передай: task-file pointer, allow-зону, DoD, «не выходи за зону, коммит НЕ сам». Дай узкий return (pointer+summary), не тело.
4. **Zone-check + commit через рельс** — НЕ raw git:
   ```
   python tools/gated_commit.py -m "<msg>" --gate "python tools/zone_check.py --allow '<globs>' --staged"
   ```
   (или прямой gate из task-file test-cmd). Рельс стейджит, проверяет staged против зоны + гоняет test-cmd, коммитит только на зелёном. Staged вне зоны / красный тест = нет коммита.
5. **Report:** изменённые файлы, зона OK/violation, test-статус, коммит.

Не проси субагента обходить zone-guard. Красный zone-check → патч не принимается (не рационализируй).
