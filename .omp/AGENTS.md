# AI Workflow — flow (OMP как control point)

Портируемый контракт-слой поверх OMP.

## Роли (резолвятся из `.omp/agents/`)
- **producer** — problem-space spec (SP-*) + solution-space ADR (AD-*), с альтернативами. Не решает.
- **critic** — независимый проход свежим контекстом над {источник, spec, ADR}, findings по severity. Не лочит, не правит.
- **explorer** — read-only discovery, возвращает curated inventory (не raw-дамп).
- **executor** — реализация внутри залоченного контракта, в своей зоне (isolated). Дефолт, если зона не резолвит домен.
- **kmp-developer / go-developer / …** — домен-executor'ы. executor + домен-семантика. Резолвятся из зоны, не выбираются вручную.

## Домен-executor резолв
Execute-задача → домен-агент резолвится **детерминированно** из `allow`-зоны task-file через `.omp/zonemap.yml` (маппинг path-glob→tech→agent). Резолв делает **тул `execute_worker` внутри себя** (не lead).
- Один домен в зоне → `execute_worker` берёт домен-агента (`kmp-developer`/`go-developer`/…) как sysprompt воркера.
- Несколько доменов (ambiguous) / нет матча → generic `executor`.
- **Не safety-рельс, а expertise-routing:** commit-rail (zone-check в самом `execute_worker`) энфорсит зону независимо от того, кто писал. Домен-агент = качество/семантика, не containment.

## Стадии
`classify → design(детерминир. драйвер) → plan(нарезка зон) → execute(fan-out воркеров) → gate → report`.
Класс задачи включает подмножество: `trivial` без design; `feature` лёгкий design; `security`/`migration` — critic обязателен + rollback.

**Design-стадию НЕ ведёт lead.** Design идёт **нативным тулом** `design_worker` (оркестрация детерминирована в TS внутри OMP):
```
design_worker(task="<design-task-file>", model?="sonnet")
```
Тул (не модель) оркестрирует поток: producer→gate_lint→(bounce-retry)→critic→ledger→gated_commit. Мышление — сильной моделью через `pi.exec` (ToS-safe). Механический гейт — `gateLint`. Locked только при gate PASS + нет blocker/major от critic; иначе blocked (не коммитит).

**Execute-стадию тоже НЕ ведёт lead.** Execute идёт **нативным тулом** `execute_worker` — симметрично design_worker:
```
execute_worker(task="<execute-task-file>", model?="sonnet")
```
Тул: резолв домен-агента (zonemap) → worker (домен-sysprompt, {Read,Write,Glob,Grep}, без Bash) пишет код+тест по DoD → `git add -A` → zone-check staged → test-cmd → commit только на зелёном. Контейнмент = no-Bash воркер + zone-check на коммите (commit-rail = enforcement).

## Backend делегации (ручка исполнителя per-stage)
Воркер design/execute-стадий выбирается: `claude` (дефолт, ToS-safe) | `omp` (нативная modelRoles/провайдер-модель, вкл. strong-API) | `codex` (execute, кросс-вендор) | `omp-fanout` (execute). Резолв: task-file поле (`design-backend:`/`execute-backend:`) > env (`OMP_BACKEND_DESIGN/EXECUTE`) > `<cwd>/.omp/delegation.yml` > дефолт `claude`. Fail-closed на недопустимый (design ≠ codex/omp-fanout). Три варианта = как заполнен `delegation.yml`/env: только-OMP (omp/omp), делегация части (микс), делегация всего (claude/claude=дефолт).

## Telemetry (3 оси: perf / consumption / quality-safety)
Тулы+хук пишут NDJSON (best-effort) в `<cwd>/.workflow/telemetry.ndjson` + `~/.omp/agent/telemetry.ndjson`. `kind:run` (per stage-run: backend/outcome/duration/worker-usage/commit + классификация ошибок errClass/errMsg) + `kind:guard` (срабатывание рельса: zone-violation/gate-bounce/critic/misroute/fr-trace-fail/test-cmd-red/worker-error/request-error/raw-git-deny). Rail-коммиты несут трейлер `[omp-rail:<tool>]` (bypass-аудит). Анализ: `python tools/stats.py` (3-осевые таблицы + cost-per-verified + by-model + секции ошибок; `--csv` экспорт, `--tid` drill). Под автономной очередью queue-runner сам аудитит bypass на done. NDJSON ротируется при ≥20MB. Telemetry не влияет на поток (сбой глотается).

**Routing детерминирован (enforcement > инструкция):** оба тула fail-closed'ят по `stage`. `design_worker` бежит ⟺ stage начинается с `design` (иначе MISROUTE GUARD); `execute_worker` — наоборот, отказывает на `design*`. Lead только диспатчит task-файл нужному тулу, НЕ оркестрирует и НЕ реализует.

## Gate — детерминированный, не на усмотрение lead
Two-stage gate = **запуск линтера**, не свободное суждение. В design-пути гейт исполняется ВНУТРИ `design_worker` (`gateLint`) — lead его не гоняет вручную. Exit 0 = PASS; exit 1 = BOUNCE (вернуть producer'у с findings линтера). Lead НЕ вправе объявить PASS при ненулевом коде. Вердикт линтера + решение — в ledger. Impl-гейт (тесты/lint/build) — отдельно, по проекту.

**Gate EARS:** для функц-требований producer эмитит FR-блоки в EARS (ubiquitous/event/unwanted). gate_lint проверяет FR source-ref (анти-фабрикация) + EARS-синтакс. FR **условен** — на мета/констрейнт-задаче FR=0, это норма. Семантика (testable/тот ли паттерн) — на critic.

## Инварианты
- immutable task-file — источник контракта, не мутирует.
- narrow handoff — pointer + узкий return, не тело.
- two-stage gate — source↔spec, spec↔ADR.
- produce ≠ decide — lead гейтит и лочит, worker производит.
- critic свежим контекстом, независимо.
- token-economy — cheap-дефолт (local Qwen), дорогой рычаг (fan-out/critic/slow) только по классу задачи/blast-radius.

## Зоны и enforcement
- Каждый worker пишет в свою зону, isolated worktree. Записи капчатся patch/branch, мёржатся под контролем lead.
- zone-guard хук: блок write/bash в `.git`/`.omp`, lead-delegation (lead не производит), force-isolate на каждый `task`-спавн.
- **Zone-check на merge:** после isolated-run воркера lead линтит его изменения против зоны; VIOLATION → патч не принимается.
- Прекондишн: репо с ≥1 коммитом (HEAD) — иначе isolated fan-out fail-closed.

## Рельсы = НАТИВНЫЕ OMP-тулы (не bash/python)
Рельсы commit/push/merge — **first-class OMP-тулы** (`.omp/tools/`, зарегистрированы в `config.yml customTools`). Зови их КАК ТУЛЫ (`gated_commit`, `gated_push`, `gated_merge`), НЕ через bash-git. Логика зоны/probe живёт внутри OMP; git — внутри тула. Аппрув: автономный yolo авто-разрешает; интерактив — человек аппрувит.

## Commit-rail + zone-gate (L1) — тул `gated_commit`
**Коммит ТОЛЬКО тулом** `gated_commit(message, task?)` (raw `git commit` блокирует хук). Тул: `git add -A` → зона из `task`-file (allow/deny/test-cmd, `.workflow/**` авто-allow) → zone_check(staged) → test-cmd → `git commit` только на зелёном.
   → staged-запись вне зоны ИЛИ красный тест = нет коммита (staged сброшен). Детерминированно, неважно как запись попала.
`task` опц.: без него зона не проверяется (gate-optional). `test-cmd` в task-file добавляет корректностный гейт.

## Push/PR-рельс (L2 — до PR) — тул `gated_push`
Push ТОЛЬКО тулом `gated_push(pr?, base?, title?, protected?, remote?)` (raw `git push`/`git merge` = deny). Гейт доставки: ветка НЕ protected + дерево ЧИСТОЕ + есть коммиты вперёд. Пушит feature-ветку `-u`; с `pr:true` открывает PR через `gh`. **Merge апрувит человек** (L2).

## Merge-рельс (L3 — автономный merge) — тул `gated_merge`
Merge ТОЛЬКО тулом `gated_merge(branch, base?, class?, findings?, allowRisky?)` (raw `git merge` = deny).
**CAPABILITY-PROBE** (гейт L3): для класса требуемые способности ДОЛЖНЫ быть в наличии, иначе INSUFFICIENT → автономия капается (мёржит человек через L2-PR):
- **green-gate** — резолвится gate-команда (свежий гейт на РЕЗУЛЬТАТ merge).
- **clean-rebase** — конфликт-фри (`git merge-tree`); конфликт → отказ.
- **forced-critic** (feature/refactor) — critic-evidence без `[blocker]`.
- **rollback** (migration) — pre-ref + reset.
- **security/migration** — L3 запрещён по умолчанию (`--allow-risky` для явного включения).

Секвенс: probe → checkout base → merge `--no-ff` → **свежий gate на merge-результате** → RED? **откат** (`reset --hard` pre-ref) + отказ : оставить merge. Гейт гоняется уже НА слитом дереве, откат детерминированный.
