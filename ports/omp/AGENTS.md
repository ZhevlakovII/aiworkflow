# AI Workflow — flow (OMP как control point)

Портируемый контракт-слой поверх OMP.

## Generation marker
Task frontmatter `generation: spec-roadmap` = новый путь (spec + roadmap). Absent / `generation: sp-adr` = legacy dual SP+ADR + optional scaffold lever. Exclusive — never mixed gate axes on one contract.

## Роли (резолвятся из `.omp/agents/`)
- **producer** — product spec (SP-*/FR-*). На `spec-roadmap` — **без** product ADR. Legacy `sp-adr` — dual-emit SP+ADR. Не решает.
- **critic** — независимый проход свежим контекстом над {источник, spec[, ADR]}, findings по severity. Не лочит, не правит. Default-off / opt-in.
- **explorer** — read-only discovery, возвращает curated inventory (не raw-дамп).
- **roadmapper** — roadmap stage: phases / verification / acceptance / tests, bound к spec ids. Фиксирован на roadmap; не producer/executor.
- **scaffolder** — **retired** на `spec-roadmap`. Legacy only + scaffold lever. Не default mid-stage.
- **executor** — реализация внутри залоченного контракта, в своей зоне (isolated). Дефолт, если зона не резолвит домен.
- **kmp-developer / go-developer / …** — домен-executor'ы. Резолвятся из зоны, не выбираются вручную.

## Домен-executor резолв
Execute-задача → домен-агент резолвится **детерминированно** из `allow`-зоны task-file через `.omp/zonemap.yml` (маппинг path-glob→tech→agent). Резолв делает **тул `execute_session` внутри себя** (не lead); lead спавнит возвращённого агента.
- Один домен в зоне → `execute_session` возвращает домен-агента (`kmp-developer`/`go-developer`/…) для native spawn.
- Несколько доменов (ambiguous) / нет матча → generic `executor`.
- **Не safety-рельс, а expertise-routing:** commit-rail (zone-check в `execute_session` step=check и на `gated_commit`) энфорсит зону независимо от того, кто писал. Домен-агент = качество/семантика, не containment.

## Стадии
**Дефолт:** `classify → design(spec) → roadmap → execute → gate → report` (при `generation: spec-roadmap`; design для нетривиального).
**Каталог:** classify · design · roadmap · execute · gate · report.
Имена `plan` / `scaffold` **не** в каталоге стадий. Plan-тул — non-gate utility (не journal, не precondition execute). Scaffold_session — только legacy + lever; на `spec-roadmap` отказывает.
Critic opt-in: `critic`/`critic-opt-in` — truthy `on`/`true`/`1`/`yes`. Critic **не обязателен** по class.

Класс: `trivial` может без design (legacy scaffold-off); `feature`/прочие — design-lock нужен. На `spec-roadmap` execute-begin требует design-lock + roadmap-done ok (никогда не fake roadmap-done).

**Design-стадию НЕ реализует lead.** Default path = **`design_session`** + native in-session producer/critic (B2a). Lead диспатчит шаги тула и спавнит роли; модели внутри `design_session` не вызываются:
```
design_session(step="begin"|"gate"|"critic-record"|"lock", task="<design-task-file>", findings?)
```
Поток: `begin` → spawn producer → `gate` (gateLint + judge; 1 bounce-retry) → spawn critic → `critic-record` (budget 1) → `lock` → `gated_commit`. На `spec-roadmap` producer пишет только spec; gate = source↔spec (без ADR). Locked только при gate PASS + нет blocker/major от critic (если opt-in).

**Roadmap (default-on для non-trivial / spec-roadmap).** НЕ ведёт lead. Default path = **`roadmap_session`** + native `roadmapper` (fixed). Между design lock и execute:
```
roadmap_session(step="begin"|"check"|"done", task="<roadmap-task-file>")
```
Поток: `begin` (judge roadmap-started + active-zone.json + roadmapper handoff) → spawn native roadmapper → `check` (zoneCheck staged) → `done` (judge roadmap-done ok|violation) → `gated_commit`. Fail-closed если generation ≠ spec-roadmap.

**Scaffold (legacy only).** `scaffold_session` + `scaffolder` только при legacy generation + рычаге on. На `spec-roadmap` — refuse.

**Execute-стадию тоже НЕ ведёт lead.** Default path = **`execute_session`** + native in-session executor/domain-dev (B2b; zonemap resolve inside the tool):
```
execute_session(step="begin"|"check"|"done", task="<execute-task-file>")
```
Поток: `begin` (judge exec-started + active-zone.json + domain handoff) → spawn native executor/domain-dev → `check` (zoneCheck staged) → `done` (judge exec-done ok|violation) → `gated_commit`. На `spec-roadmap` begin ждёт roadmap-done.

## Backend делегации (ручка исполнителя per-stage)
Воркер design/execute-стадий: `omp` (дефолт, нативная modelRoles/провайдер-модель) | `omp-fanout` (только execute; inner = omp). Резолв: task-file поле (`design-backend:`/`execute-backend:`) > env (`OMP_BACKEND_DESIGN/EXECUTE`) > `<cwd>/.omp/delegation.yml` > дефолт `omp`. Fail-closed на недопустимый (design ≠ omp-fanout; claude/codex retired B4).

## Telemetry (3 оси: perf / consumption / quality-safety)
Тулы+хук пишут NDJSON (best-effort) в `<cwd>/.workflow/telemetry.ndjson` + `~/.omp/agent/telemetry.ndjson`. `kind:run` (per stage-run: backend/outcome/duration/worker-usage/commit + классификация ошибок errClass/errMsg) + `kind:guard` (срабатывание рельса: zone-violation/gate-bounce/critic/misroute/fr-trace-fail/test-cmd-red/worker-error/request-error/raw-git-deny). Rail-коммиты несут трейлер `[omp-rail:<tool>]` (bypass-аудит). Анализ: `python tools/stats.py` (3-осевые таблицы + cost-per-verified + by-model + секции ошибок; `--csv` экспорт, `--tid` drill). Под автономной очередью queue-runner сам аудитит bypass на done. NDJSON ротируется при ≥20MB. Telemetry не влияет на поток (сбой глотается).

**Routing детерминирован (enforcement > инструкция):** тулы fail-closed'ят по `stage`. `design_session` бежит ⟺ stage начинается с `design` (иначе MISROUTE); `roadmap_session` — только `roadmap*`; `scaffold_session` — только legacy `scaffold*`; `execute_session` отказывает на `design*`. Lead диспатчит task-файл нужному тулу, НЕ пишет spec/roadmap/каркас сам.

## Gate — детерминированный, не на усмотрение lead
Two-stage gate = **запуск линтера**, не свободное суждение. В design-пути гейт исполняется в `design_session(step=gate)` (`gateLint` + judge record) — lead не объявляет PASS на глаз. **Legacy:** source↔spec, spec↔ADR. **`spec-roadmap`:** source↔spec; second axis = spec↔roadmap (` ```ac ` / ` ```phase ` covers→SP/FR). PASS → дальше critic (если opt-in); BOUNCE → вернуть producer'у (budget 1). Вердикт — в stage journal (`.workflow/stages/`). Impl-гейт (тесты/lint/build) — отдельно, по проекту.

**Gate EARS:** для функц-требований producer эмитит FR-блоки в EARS (ubiquitous/event/unwanted). gate_lint проверяет FR source-ref (анти-фабрикация) + EARS-синтакс. FR **условен** — на мета/констрейнт-задаче FR=0, это норма. Семантика (testable/тот ли паттерн) — на critic.

## Инварианты
- immutable task-file — источник контракта, не мутирует.
- narrow handoff — pointer + узкий return, не тело.
- two-stage gate — source↔spec + (legacy spec↔ADR | new spec↔roadmap).
- produce ≠ decide — lead гейтит и лочит, worker производит.
- critic свежим контекстом, независимо.
- token-economy — Composer временный cheap-default; дорогой рычаг (4.7/fan-out/critic/slow) только по классу задачи/blast-radius.

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
