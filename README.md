# AI Workflow

Дисциплинированный SDLC-слой: контракт-ориентированный флоу с детерминированными рельсами
и лестницей автономии L1→L3. Один флоу, **три подложки (flavor)**:
- **OMP** ([oh-my-pi](https://omp.sh)) — конфиг + нативные тулы + хуки + роли внутри OMP.
- **Claude Code** — субагенты (`.claude/agents/`) + slash-команды (`.claude/commands/`) +
  enforcement-хуки. Порт: [`docs/design/omp-to-claude-code-port-2026-09-06.md`](docs/design/omp-to-claude-code-port-2026-09-06.md).
- **OpenCode** ([sst/opencode](https://opencode.ai), в т.ч. Desktop) — TS-нативные тулы (`.opencode/tools/`) +
  плагины (`.opencode/plugins/`, `tool.execute.before/after`) + субагенты + slash-команды. Ближе к OMP-оригиналу
  (оба TS/Bun-native). Порт: [`docs/design/omp-to-opencode-port-2026-09-08.md`](docs/design/omp-to-opencode-port-2026-09-08.md).

Выбор инсталлером: `--flow omp|claude|opencode|all` (дефолт `all` = omp+claude+opencode; `both` — deprecated
алиас `all`). Все три ставятся одинаково (setup/bootstrap/свой installer); opencode-flavor умеет и zero-install
(`.opencode/` версионится в репо → opencode авто-дискаверит при открытии проекта). У opencode флоу идёт **без
команды** (always-on `AGENTS.md` governs дефолтный `build`-агент) или явными `/aiwf-*` командами.

## Установка (одна команда)

Раскатка на mac/linux/windows. Bootstrap клонит репо в `~/.aiworkflow` и запускает setup
(детект prereq → **интерактивная установка** через brew/apt/winget/scoop → накат продукта → smoke).

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/ZhevlakovII/aiworkflow/main/bootstrap.sh | bash
# non-interactive (авто-ставит installable prereq):
curl -fsSL https://raw.githubusercontent.com/ZhevlakovII/aiworkflow/main/bootstrap.sh | bash -s -- --yes
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/ZhevlakovII/aiworkflow/main/bootstrap.ps1 | iex
# с флагами (irm|iex не берёт аргументы напрямую):
$b = irm https://raw.githubusercontent.com/ZhevlakovII/aiworkflow/main/bootstrap.ps1
& ([scriptblock]::Create($b)) -Yes
```

**Только Claude Code flavor:**
```bash
curl -fsSL .../bootstrap.sh | bash -s -- --flow claude          # глобал ~/.claude
```
```powershell
& ([scriptblock]::Create($b)) -Flow claude                       # или -Flow claude -Target C:\proj
```
После CC-установки перезапусти сессию Claude Code (hooks из `settings.json` — на старте сессии).

**Только OpenCode flavor:**
```bash
curl -fsSL .../bootstrap.sh | bash -s -- --flow opencode         # глобал ~/.config/opencode
```
```powershell
& ([scriptblock]::Create($b)) -Flow opencode                     # или -Flow opencode -Target C:\proj
```
Открой проект в OpenCode (TUI/Desktop) — флоу идёт без команды (`AGENTS.md` → `build`-агент) или через `/aiwf-*`.

Уже склонировал репо? Запусти setup напрямую — `bash tools/setup.sh` / `tools/setup.ps1`
(`--check`/`-Check` = dry-run; `--flow`/`-Flow` = выбор подложки). Детали, флаги, обновление,
machine-специфика — в [INSTALL.md](INSTALL.md).

Ставит выбором всё: `omp` (upstream-инсталлер omp.sh), `ast-index` (winget на Windows /
GitHub-release бинарь на mac/linux), `node`/`git`/`java` (pkg-mgr), `codex` (npm). Только
`claude` руками (не npm, ToS-safe) — печатается хинт.

## Цель

Дать агентам SDLC-дисциплину, которую не даёт ни один харнесс из коробки:

- **Анти-дрейф.** Контракт задачи (task-file + spec/ADR) иммутабелен и является единственным
  источником истины. Спека не расходится с постановкой, решение трассируется на спеку.
- **Enforcement > инструкция.** Границы держат не промпты (модель их обходит), а **детерминированный
  код на чокпоинтах**: зонный линт путей на коммите, gate-lint дизайна, FR↔test трассировка,
  capability-probe перед merge. Модель физически не может протащить плохое состояние.
- **Автономия по лестнице.** L1 (до коммита) → L2 (до PR) → L3 (merge) — каждый уровень открывается
  только тем, что построил enforcement-шим. Автономная очередь крутится внутри одного OMP-процесса.
- **Токен-экономия (cost per verified outcome).** Дешёвый локальный Qwen — дефолт-lead; сильная
  модель (claude) заходит субпроцессом ровно там, где нужна семантика (design/critic/execute).
- **Кросс-харнесс перенос.** Универсален только контракт-данные (plain-файлы в репо). Воркером может
  быть OMP-субагент ИЛИ чужой харнесс-subprocess (`claude -p`, `codex exec`).

## Возможности

### Нативные тулы-рельсы (customTools, логика внутри OMP)

| Тул | Что делает |
|-----|-----------|
| `gated_commit` | стейдж → zone-check путей против allow/deny зоны task-file → коммит только на зелёном. Raw `git commit` заблокирован. |
| `gated_push` | protected-branch / clean-tree / commits-ahead гарды → push feature-ветки (+опц. PR через `gh`). L2-рельс. |
| `gated_merge` | capability-probe (green-gate/clean-rebase/forced-critic/rollback) → merge `--no-ff` → свежий gate на слитом дереве → откат на красном. L3-рельс. |
| `design_worker` | вся design-стадия (producer→gate_lint→bounce-retry→critic→ledger→commit) детерминированно; `claude -p` через `pi.exec`. |
| `execute_worker` | execute-стадия: резолв домен-агента (zonemap) → воркер пишет код+тест → zone-check → test-cmd → **FR↔test трассировка** → commit. |
| `codex_worker` | execute через `codex exec` как кросс-вендор harness-subprocess воркер (dsh-seam). Требует установленного codex CLI. |
| `archive_spec` | delta→archive живая спека: merge SP/FR из change-spec в канон `docs/spec/<capability>.md` по id (ADD/SKIP/COLLISION), опц. claude-reconcile + cross-ID семантик-dedupe. |
| `code_search` / `outline` / `callers` | discovery поверх `ast-index` (дефолт вместо mass-grep). |
| `plan` / `synthesize` | one-shot синтез из спек (`claude -p`), вне автономного контура. |

### Хуки

- `zone-guard` (pre) — блочит запись в `.git`/`.omp`, форсит делегирование в интерактиве (`hasUI`).
- `queue-runner` — автономная очередь внутри OMP-процесса (armed env `OMP_QUEUE`): `agent_end` → verdict
  по HEAD-advance → dispatch следующей → **autotrigger `archive_spec` на task-done**.

### Роли (`.omp/agents/`)

`producer` / `critic` / `explorer` / `executor` (flow-роли) + каталог домен-executor'ов
`kmp-developer` / `go-developer` / `gradle-developer` / `rust-developer` / `swift-developer` /
`ktor-developer` (резолвятся из `.omp/zonemap.yml` по зоне правки). Каталог широкий; проект wire'ит
только под реальные зоны — новый домен = `.omp/agents/<name>.md` (executor + домен-семантика,
не свободный редизайн) + строка zonemap.

### Enforcement-примитивы (OMP-нативные)

`bash.patterns` deny (raw git-мутации, pipe-to-shell, nc/ssh), `tools.approvalMode`, `task.isolation`
(projfs-клоны для fan-out), `intentTracing` (per-call intent, auditability).

## Использование

### Интерактив
```bash
cd <твой-проект>
omp                       # lead держит контракт и гейтит, работа через воркеров
```
Модель зовёт рельсы как first-class тулы (`gated_commit` и т.д.); raw git блокируется.

### Автономная очередь (L1)
```bash
# задачи — .workflow/tasks/<id>.md (иммутабельны), статус в .workflow/queue-state.json
python tools/queue_rpc.py --cwd <проект> [--tasks-dir DIR] [--state FILE] [--timeout SEC]
```
Один персистентный `omp --mode=rpc` дренирует очередь: dispatch → `execute_worker`/`design_worker`
→ рельсы → verdict → next → autotrigger archive. Lead только диспатчит.

### Формат task-file
```yaml
---
id: money-abs-2026-08-31
stage: execute            # execute | design*
class: feature
capability: money         # канон живой спеки docs/spec/<capability>.md
spec: docs/design/<id>-spec.md
allow: ["core/money/**"]   # зона (glob) — enforced на коммите
deny: ["source/**"]
test-cmd: "./gradlew :core:money:testDebugUnitTest"
---
# контракт (INV-1, иммутабелен)
```

### Спека с EARS-FR (для FR↔test гейта)
````markdown
```fr
id: FR-abs-negate
source: <task-file>#L17
pattern: event            # ubiquitous | event | unwanted
statement: WHEN abs is called on a negative Money THE SYSTEM SHALL return its positive
```
````
Каждый FR обязан быть покрыт тестом, ссылающимся на его FR-id (иначе коммит отклонён).

## Установка

См. [INSTALL.md](INSTALL.md). All-in-one (prereq-детект → machine-head bootstrap → install → load-smoke):
`powershell -File tools/setup.ps1` (Windows) / `bash tools/setup.sh` (linux/macos). Только копирование
канона — `tools/install.ps1` / `tools/install.sh`. Канон `.omp` → глобальный `~/.omp/agent` (продукт);
проектный `.omp/` несёт только `zonemap.yml`.

## Тесты
```bash
python tools/tests/test_ears_gate.py       # EARS FR gate-lint (parity python↔TS)
python tools/tests/test_fr_trace.py        # FR↔test трассировка (parity)
python tools/tests/test_archive_spec.py    # archive merge (add/skip/collision)
python tools/tests/test_archive_parity.py  # archive TS↔python паритет
python tools/tests/test_dedupe_unit.py     # cross-ID dedupe (детерминир. часть)
node .omp/tools/_lib/zonemap.test.ts        # zone→домен-агент резолвер
node .omp/tools/_lib/backend.test.ts        # backend-резолв + runWorker exec-формы + fanout dispatch
node .omp/tools/_lib/backend.fanout.test.ts # omp-fanout Path A (git-worktree изолятор, реальный temp-git)
```

## Архитектура (кратко)

- **Топология:** единая точка на OMP (control point + orchestration runtime), не N-адаптеров.
- **Слой продукта:** глобальный `~/.omp/agent` (тулы/хуки/роли/RULES/AGENTS/bash.patterns).
- **Проектный слой:** тонкий `<repo>/.omp` (`zonemap.yml`), мёржится OMP'ом поверх глобала per-key.
- **Контракт-данные:** `.workflow/tasks` (задачи) + `docs/design` (spec/ADR) + `docs/spec` (живой канон)
  + ledger — plain-файлы, harness-agnostic.

Полный роадмап и провенанс решений: `docs/design/omp-orchestration-roadmap-2026-08-24.md`.
