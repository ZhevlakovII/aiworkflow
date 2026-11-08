# AI Workflow — flow (OMP как control point)

Портируемый контракт-слой поверх OMP.

## Роли (резолвятся из `.omp/agents/`)
- **producer** — problem-space spec (SP-*) + solution-space ADR (AD-*), с альтернативами. Не решает.
- **critic** — независимый проход свежим контекстом над {источник, spec, ADR}, findings по severity. Не лочит, не правит.
- **explorer** — read-only discovery, возвращает curated inventory (не raw-дамп).
- **scaffolder** — каркас после design-lock (пути/сигнатуры/stub-тесты/DoD); без полного impl. Фиксирован на scaffold; reuse executor/domain-devs на scaffold запрещён.
- **executor** — реализация внутри залоченного контракта, в своей зоне (isolated). Дефолт, если зона не резолвит домен.
- **kmp-developer / go-developer / …** — домен-executor'ы. executor + домен-семантика. Резолвятся из зоны, не выбираются вручную.

## Домен-executor резолв
Execute-задача → домен-агент резолвится **детерминированно** из `allow`-зоны task-file через `.omp/zonemap.yml` (маппинг path-glob→tech→agent). Резолв делает **тул `execute_session` внутри себя** (не lead); lead спавнит возвращённого агента.
- Один домен в зоне → `execute_session` возвращает домен-агента (`kmp-developer`/`go-developer`/…) для native spawn.
- Несколько доменов (ambiguous) / нет матча → generic `executor`.
- **Не safety-рельс, а expertise-routing:** commit-rail (zone-check в `execute_session` step=check и на `gated_commit`) энфорсит зону независимо от того, кто писал. Домен-агент = качество/семантика, не containment.

## Стадии
`classify → design(детерминир. драйвер) → plan(нарезка зон) → scaffold → execute(fan-out воркеров) → gate → report`.
Класс задачи включает подмножество: `trivial` без design; `feature` лёгкий design; `security`/`migration` — critic обязателен + rollback.

**Design-стадию НЕ реализует lead.** Default path = **`design_session`** + native in-session producer/critic (B2a; R1 spawn-map: producer required, critic conditional, explorer optional). Lead диспатчит шаги тула и спавнит роли; модели внутри `design_session` не вызываются:
```
design_session(step="begin"|"gate"|"critic-record"|"lock", task="<design-task-file>", findings?)
```
Поток: `begin` → spawn producer → `gate` (gateLint + judge; 1 bounce-retry) → spawn critic → `critic-record` (budget 1) → `lock` → `gated_commit`. Механический гейт — `gateLint` (B1 judge journal). Locked только при gate PASS + нет blocker/major от critic.

**Scaffold-стадию тоже НЕ ведёт lead.** Default path = **`scaffold_session`** + native in-session `scaffolder` (fixed agent; no zonemap domain resolve). Между design lock и execute. Lead диспатчит шаги тула и спавнит scaffolder; модели внутри `scaffold_session` не вызываются:
```
scaffold_session(step="begin"|"check"|"done", task="<scaffold-task-file>")
```
Поток: `begin` (judge scaffold-started + active-zone.json + scaffolder handoff) → spawn native scaffolder → `check` (zoneCheck staged, no commit) → `done` (judge scaffold-done ok|violation) → `gated_commit`.

**Execute-стадию тоже НЕ ведёт lead.** Default path = **`execute_session`** + native in-session executor/domain-dev (B2b; zonemap resolve inside the tool). Lead диспатчит шаги тула и спавнит роль; модели внутри `execute_session` не вызываются:
```
execute_session(step="begin"|"check"|"done", task="<execute-task-file>")
```
Поток: `begin` (judge exec-started + active-zone.json + domain handoff) → spawn native executor/domain-dev → `check` (zoneCheck staged, no commit) → `done` (judge exec-done ok|violation) → `gated_commit`.

## Backend делегации (ручка исполнителя per-stage)
Воркер design/execute-стадий: `omp` (дефолт, нативная modelRoles/провайдер-модель) | `omp-fanout` (только execute; inner = omp). Резолв: task-file поле (`design-backend:`/`execute-backend:`) > env (`OMP_BACKEND_DESIGN/EXECUTE`) > `<cwd>/.omp/delegation.yml` > дефолт `omp`. Fail-closed на недопустимый (design ≠ omp-fanout; claude/codex retired B4).

## Telemetry (3 оси: perf / consumption / quality-safety)
Тулы+хук пишут NDJSON (best-effort) в `<cwd>/.workflow/telemetry.ndjson` + `~/.omp/agent/telemetry.ndjson`. `kind:run` (per stage-run: backend/outcome/duration/worker-usage/commit + классификация ошибок errClass/errMsg) + `kind:guard` (срабатывание рельса: zone-violation/gate-bounce/critic/misroute/fr-trace-fail/test-cmd-red/worker-error/request-error/raw-git-deny). Rail-коммиты несут трейлер `[omp-rail:<tool>]` (bypass-аудит). Анализ: `python tools/stats.py` (3-осевые таблицы + cost-per-verified + by-model + секции ошибок; `--csv` экспорт, `--tid` drill). Под автономной очередью queue-runner сам аудитит bypass на done. NDJSON ротируется при ≥20MB. Telemetry не влияет на поток (сбой глотается).

**Routing детерминирован (enforcement > инструкция):** тулы fail-closed'ят по `stage`. `design_session` бежит ⟺ stage начинается с `design` (иначе MISROUTE); `scaffold_session` — только `scaffold*` (MISROUTE на `design*`/`execute*`); `execute_session` отказывает на `design*`. Lead диспатчит task-файл нужному тулу (design → `design_session`, scaffold → `scaffold_session`, execute → `execute_session`), НЕ пишет spec/ADR/каркас сам.

## Gate — детерминированный, не на усмотрение lead
Two-stage gate = **запуск линтера**, не свободное суждение. В design-пути гейт исполняется в `design_session(step=gate)` (`gateLint` + judge record) — lead не объявляет PASS на глаз. PASS → дальше critic; BOUNCE → вернуть producer'у (budget 1). Вердикт — в stage journal (`.workflow/stages/`). Impl-гейт (тесты/lint/build) — отдельно, по проекту.

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
