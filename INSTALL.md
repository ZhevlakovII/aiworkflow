# INSTALL — накат AI Workflow

Один флоу, **три подложки (flavor)**. OMP/Claude — через installer-флаг `--flow` / `-Flow`; OpenCode — project-local:

| flavor | подложка | куда ставится | как включается |
|--------|----------|---------------|----------------|
| `omp` | Oh My Pi (нативные тулы/хуки/агенты) | глобал `~/.omp/agent/` | `-Flow omp` |
| `claude` | Claude Code (субагенты + slash-команды + hooks) | глобал `~/.claude/` (или проект `-Target`) | `-Flow claude` |
| `opencode` | OpenCode (TS-тулы + плагины + агенты + команды) | глобал `~/.config/opencode/` (или проект `--target`) | `-Flow opencode` / `--flow opencode` |
| `all` (**дефолт**) | omp + claude + opencode | все три | без флага (`both` — deprecated алиас `all`) |

Маппинг OMP→CC: `docs/design/omp-to-claude-code-port-2026-09-06.md`.
Маппинг OMP→OpenCode + гэпы: `docs/design/omp-to-opencode-port-2026-09-08.md`.

> **OpenCode-flavor** полностью разведён: `setup.*`/`bootstrap.*` `--flow opencode`, свои `install-opencode.{sh,ps1}`
> (§2.4). Zero-install альтернатива: `.opencode/` уже в репо, opencode авто-дискаверит при открытии проекта.

**OMP-flavor:** продукт = **глобальный OMP-конфиг** (`~/.omp/agent/`), не junction в каждый репо.
Installer копирует канон `<repo>/.omp` → глобал и splice'ит продукт-блок в глобальный `config.yml`,
сохраняя machine-специфику (modelRoles/theme). Проектный `.omp/` несёт только `zonemap.yml`.

**Claude-Code-flavor:** деплоит `.claude/` слой (агенты `.claude/agents/`, slash-команды `.claude/commands/`,
enforcement-хуки + `settings.json`). Дефолт — глобал `~/.claude/` (доступно в каждом проекте); `-Target <dir>`
стемпит в `<dir>/.claude` + кладёт `CLAUDE.md` (project-scoped). Пути тулов/хуков переписываются на абсолютные
пути клона; хуки cwd-aware (берут корень целевого проекта из stdin) → один глобальный экземпляр обслуживает
любой проект. `settings.json` **мёржится** (hooks + permissions.deny вплайсиваются, чужие ключи сохраняются).

## 1. Prerequisites

| Компонент | Зачем | Проверка |
|-----------|------|----------|
| **OMP (oh-my-pi)** ≥ 18 | рантайм-платформа (**flavor omp/all**) | `omp --version` |
| **Node.js** ≥ 24 | нативные TS-тулы strip-types (**flavor omp/all**) | `node --version` |
| **Python** ≥ 3.10 | рельсы/драйверы `tools/*.py` (**обе flavor**) | `python --version` |
| **Claude CLI** (claude.ai/code) | сильная модель воркером (`claude -p`, ToS-safe); **required для flavor claude** | `claude --version` |
| **OpenCode** (opencode.ai, в т.ч. Desktop) | рантайм-платформа (**flavor opencode**); несёт свой Bun | `opencode --version` |
| **git** | контракт-данные, рельсы (обе) | `git --version` |
| **ast-index** | discovery-тулы / агенты (обе) | `ast-index version` |
| **PowerShell 5.1+** _или_ **bash** (rsync опц.) | installer (Windows / linux+macos) | — |

Опционально:
- **LM Studio + Qwen** (напр. `qwen3.6-35b-a3b`) — дешёвый локальный lead-по-умолчанию (Pool B, ~free).
  Endpoint прописан в `~/.omp/agent/models.yml`. Без него укажи lead явно (`--model`), но потечёт бюджет.
- **Java 21 + Android SDK** — если target = KMP-проект (для gradle test-cmd).
- **codex CLI + OpenAI-auth** — только для `codex_worker` (кросс-вендор seam). `npm i -g @openai/codex` + `codex login`.

> Windows-native OMP: бинарь x64, in-process ripgrep/glob/coreutils — без Unix-tool зависимостей.

## 2. Установка

Из корня репозитория канона.

### 2.0. All-in-one (рекомендовано)

`setup.*` оборачивает installer 4 шагами: prereq-детект+**интерактивная установка** (§1) →
machine-head bootstrap (seed `models.yml`/`modelRoles` из `tools/templates/` **только если
отсутствуют**) → `install.*` → load-smoke (`omp -p` exit 0).

Prereq ставятся: `omp` — upstream-инсталлер (`omp.sh/install.sh` / `install.ps1`); `ast-index` —
**winget** (`defendend.ast-index`) на Windows, GitHub-release бинарь → `~/.local/bin` на mac/linux;
`node`/`git`/`java` — платформенный пакет-менеджер (**brew** macOS / **apt/dnf/pacman/zypper** linux /
**winget/scoop** windows); `codex` — **npm**. Дефолт — спросить y/N на каждый недостающий installable.
Только `claude` — руками (хинт, не npm; ToS-safe).

**Windows:**
```powershell
powershell -ExecutionPolicy Bypass -File tools/setup.ps1 -Check            # dry-run (ничего не пишет; список installable)
powershell -ExecutionPolicy Bypass -File tools/setup.ps1                   # накат, промпт на каждый prereq
powershell -ExecutionPolicy Bypass -File tools/setup.ps1 -Yes              # non-interactive: ставит все installable
powershell -ExecutionPolicy Bypass -File tools/setup.ps1 -Install node,git # ставит только названные, без промпта
```

**Linux / macOS:**
```bash
bash tools/setup.sh --check             # dry-run (список installable)
bash tools/setup.sh                      # накат, промпт на каждый prereq
bash tools/setup.sh --yes                # non-interactive: ставит все installable
bash tools/setup.sh --install=node,git   # ставит только названные, без промпта
```

Флаги: `-SkipSmoke`/`--skip-smoke` — без load-smoke (CI без модели). `-InstallMissing`/
`--install-missing` — back-compat алиас `-Yes`/`--yes`. Bootstrap **никогда не перезаписывает**
реальный machine-head; seed'ит template только когда `models.yml`/`modelRoles` отсутствуют —
после seed **отредактируй endpoint/model** под свою машину (§8).

> **Одна команда с нуля** (клон+setup) — `bootstrap.sh`/`bootstrap.ps1` из корня, см. README «Установка».

### 2.1. Только installer (без prereq/bootstrap/smoke)

**Windows (PowerShell):**
```powershell
powershell -ExecutionPolicy Bypass -File tools/install.ps1 -Check   # dry-run
powershell -ExecutionPolicy Bypass -File tools/install.ps1          # накат
```

**Linux / macOS (bash):**
```bash
bash tools/install.sh --check   # dry-run
bash tools/install.sh           # накат
```

Оба installer'а используют один канон, один MARKER и одну splice-семантику → взаимозаменяемы
и идемпотентны. `install.sh` зеркалит через `rsync --delete` (fallback `rm -rf`+`cp -R` без rsync);
`--check` деревьев тоже работает без rsync (POSIX-diff `find`/`cmp`/`comm`).

Installer:
1. зеркалит `tools/` `hooks/` `agents/` (`robocopy /MIR` / `rsync --delete` — удаляет устаревшее) → `~/.omp/agent/`;
2. копирует `RULES.md` `AGENTS.md` `WATCHDOG.md` `WATCHDOG.yml`;
3. splice'ит ПРОДУКТ-блок в `~/.omp/agent/config.yml` (пути `./.omp/` → `~/.omp/agent/`, tilde т.к.
   relative резолвятся против CWD, не config-файла), **сохраняя machine-head** (modelRoles/theme/...).

Идемпотентно: повторный `-Check` / `--check` покажет `config.yml: in sync`.

### 2.2. Выбор flavor (`--flow` / `-Flow`)

`setup.*` и `bootstrap.*` принимают `--flow omp|claude|opencode|all` (дефолт `all` = omp+claude+opencode;
`both` — deprecated алиас `all`). Одиночные `claude`/`opencode` пропускают OMP-шаги (machine-head/modelRoles/
load-smoke): `claude` требует `claude` CLI, `opencode` — `opencode` CLI (вместо `omp`+`node`). `--target <dir>`
работает и для claude, и для opencode. `all` требует prereq всех трёх (omp+node+claude+opencode).

**Windows:**
```powershell
powershell -ExecutionPolicy Bypass -File tools/setup.ps1 -Flow claude            # только Claude Code (глобал ~/.claude)
powershell -ExecutionPolicy Bypass -File tools/setup.ps1 -Flow claude -Target C:\proj  # project-scoped в C:\proj\.claude
powershell -ExecutionPolicy Bypass -File tools/setup.ps1 -Flow all                # все три (дефолт)
```
**Linux / macOS:**
```bash
bash tools/setup.sh --flow claude                 # глобал ~/.claude
bash tools/setup.sh --flow claude --target /proj  # project-scoped /proj/.claude
```

Только CC-installer (без prereq/setup):
```powershell
powershell -ExecutionPolicy Bypass -File tools/install-claude.ps1 -Check           # dry-run (глобал)
powershell -ExecutionPolicy Bypass -File tools/install-claude.ps1 -Target C:\proj  # project-scoped
```
```bash
bash tools/install-claude.sh --check
bash tools/install-claude.sh --target /proj
```

> **Важно:** после установки CC-flavor **перезапусти сессию Claude Code** — `settings.json` hooks
> подхватываются на старте сессии (агенты/команды видны сразу).

### 2.3. Что деплоит Claude-Code-flavor

```
~/.claude/agents/     producer, critic, explorer, executor, kmp/go/gradle-developer
~/.claude/commands/   aiwf-flow/design/execute/gate/commit/push/merge/explore (пути тулов -> клон)
~/.claude/settings.json  PreToolUse zone-guard + PostToolUse telemetry + permissions.deny (мёрж)
(project-scoped -Target: то же в <proj>/.claude + CLAUDE.md с lead-протоколом)
```
Enforcement: `.claude/hooks/zone-guard.py` (блок .git/.omp write, raw-git→стир к gated-рельсам,
pipe-to-shell/nc/ssh/rm-rf) + `telemetry.py` (NDJSON → `<proj>/.workflow/telemetry.ndjson`).
Рельсы/стадии — те же `tools/*.py`, обёрнутые slash-командами.

### 2.4. OpenCode-flavor (`install-opencode.{sh,ps1}` / `--flow opencode`)

Installer-твины `install-claude.*` для OpenCode. Дефолт-цель — global `~/.config/opencode` (или `$XDG_CONFIG_HOME/opencode`); `--target <dir>` — project-scoped `<dir>/.opencode` + `<dir>/opencode.json`.

**Через all-in-one (prereq-детект → install):**
```bash
bash tools/setup.sh --flow opencode                      # global; --target /proj — project-scoped
```
```powershell
powershell -ExecutionPolicy Bypass -File tools/setup.ps1 -Flow opencode            # global
powershell -ExecutionPolicy Bypass -File tools/setup.ps1 -Flow opencode -Target C:\proj
```
**Одной командой с нуля:** `bootstrap.sh --flow opencode` / `bootstrap.ps1 -Flow opencode` (см. README).

**Только installer (без prereq/setup):**
```bash
bash tools/install-opencode.sh --check               # dry-run (ничего не пишет)
bash tools/install-opencode.sh                        # global ~/.config/opencode
bash tools/install-opencode.sh --target /path/proj    # project-scoped <proj>/.opencode
```
```powershell
powershell -ExecutionPolicy Bypass -File tools/install-opencode.ps1 -Check
powershell -ExecutionPolicy Bypass -File tools/install-opencode.ps1 -Target C:\proj
```

Отличия от claude-installer: TS-тулы self-contained (relative `../lib`-импорты + PATH-бинари git/gh/claude/opencode/codex/ast-index) → **path-rewrite не нужен**. `opencode.json` **мёржится** (permission + instructions вплайсиваются, чужие ключи юзера сохраняются) через python. Копирование `agents/` — **overlay** (без удаления чужих агентов в global-дире); `tools/plugins/lib/commands` — полный mirror. Идемпотентно (`--check` → `in sync`).

**Zero-install альтернатива:** ничего не запускать — `.opencode/` версионируется в репо, opencode авто-дискаверит при открытии проекта (project-local wins над global per-имя).

> **cwd-caveat (global):** driver-тулы (`design_worker`/`execute_worker`) читают `.opencode/{agents,delegation.yml,zonemap.yml}` относительно **cwd проекта**. Для полного флоу при global-инсталле держи проектный `.opencode/` ИЛИ ставь project-scoped (`--target`) — тогда всё резолвится cwd-relative, робастно.

Деплоит:
```
.opencode/tools/      gated_commit/push/merge, design_worker, execute_worker, codex_worker,
                      gate_lint, archive_spec, plan, synthesize, code_search, outline, callers (+ lib/)
.opencode/plugins/    zone-guard (tool.execute.before, throw-deny) + telemetry (tool.execute.after)
.opencode/agents/     producer, critic, explorer, executor, kmp/go/gradle-developer + primary `aiwf`
.opencode/commands/   aiwf-flow/design/execute/gate/commit/push/merge/explore
.opencode/{AGENTS.md,delegation.yml,zonemap.yml}  + root opencode.json (permission + instructions)
```
Enforcement: plugin `zone-guard` (throw-deny: .git/.omp/.opencode write, raw-git→стир к рельсам,
pipe-to-shell/nc/ssh/rm-rf) + `telemetry`. Рельсы зовут git через Bun `$` (минуют plugin — аналог pi.exec).

**Prereq:** `opencode` CLI (несёт свой Bun), `git`, `ast-index` (discovery). Опц. `claude`/`codex` CLI —
только если backend делегации переставлен на них (§9). Дефолтный backend flavor'а — `opencode` (нативный движок).

**Запуск:** флоу **без команды** — дефолтный `build`-агент следует always-on `AGENTS.md` (просто пиши задачу;
trivial-escape для чистых вопросов). Строгий lead — Tab → primary `aiwf`. Явные алиасы — `/aiwf-*` команды.

> **Не прогнано на живом OpenCode** (порт собран на хосте без opencode) — сверить API-caveats
> (сигнатура `tool.execute.before`, флаги `opencode run --agent`, plural-dirs, глобальная загрузка
> `AGENTS.md`) в порт-доке §Caveats перед проданкшн-использованием.

## 3. Что деплоится в `~/.omp/agent/` (flavor omp)

```
tools/          commit/push/merge, design_worker, execute_worker, codex_worker,
                archive_spec, plan, synthesize, code_search, outline, callers (+ _lib/)
hooks/          pre/zone-guard.ts, queue-runner.ts
agents/         flow-роли: producer, critic, explorer, executor
                домен-executor каталог: kmp-developer, go-developer, gradle-developer,
                  rust-developer, swift-developer, ktor-developer
                (каталог широкий; проект wire'ит через zonemap только под РЕАЛЬНЫЕ зоны — §5)
RULES.md AGENTS.md WATCHDOG.md WATCHDOG.yml
config.yml      machine-head (modelRoles/theme) + ПРОДУКТ-блок (extensions/customTools/
                tools.approvalMode/bash.patterns[raw-git deny, pipe-to-shell, nc/ssh]/task.isolation)
```

## 4. Пост-инсталл верификация

```bash
# load-smoke: OMP грузит config + все customTools + хуки без ошибок
cd <любой-git-проект>
omp -p "Reply exactly: LOADED" --yolo        # exit 0 = всё загрузилось

# в проде фикс/тулы на месте
grep -c execFileSync ~/.omp/agent/hooks/queue-runner.ts    # >0
```

## 5. Подключение проекта (target)

Проектный слой — тонкий, коммитится в репо проекта:

1. **`<project>/.omp/zonemap.yml`** — карта зона→tech→домен-агент. Ссылайся на любого агента
   из глобального каталога (`~/.omp/agent/agents/`) под РЕАЛЬНУЮ зону проекта — гипотетические
   зоны не заводим (правило Track C: enforcement под реальный код, не про запас):
   ```yaml
   map:
     - { glob: "core/**",        tech: kmp,   agent: kmp-developer }     # KMP app
     - { glob: "server/**",      tech: ktor,  agent: ktor-developer }    # Kotlin backend
     - { glob: "bot/**",         tech: go,    agent: go-developer }
     - { glob: "cli/**",         tech: rust,  agent: rust-developer }
     - { glob: "apple/**",       tech: swift, agent: swift-developer }   # iOS/macOS
     - { glob: "build-logic/**", tech: gradle, agent: gradle-developer }
   default: { agent: executor }
   ```
   Каталог домен-executor'ов широкий (kmp/go/gradle/rust/swift/ktor); проект берёт из него
   подмножество под свои зоны. Нет домен-агента под зону → добавь `.omp/agents/<name>.md`
   в канон (executor + домен-семантика, БЕЗ свободного редизайна) + строку в zonemap.
2. **`.gitignore`** проекта: `/.workflow/` (runtime-состояние очереди/гейта) — не версионим.
   `.omp/` (тонкий) — версионим.
3. **git с ≥1 коммитом** (валидный HEAD) — prereq изоляции (projfs fail-closed без HEAD).

OMP мёржит глобал + проектный `.omp/config.yml` per-key → продукт из глобала, специфика из проекта.

## 6. Автономная очередь

```bash
# положи задачи в .workflow/tasks/<id>.md (формат — см. README), затем:
python tools/queue_rpc.py --cwd <project> [--tasks-dir DIR] [--state FILE] [--timeout SEC]
```
Один персистентный `omp --mode=rpc --approval-mode yolo` (armed `OMP_QUEUE`) дренирует очередь;
рельсы держат независимо от approvalMode. `--rollback-on-block` откатывает упор.

> Windows Task Scheduler-обёртка вокруг `queue_rpc.py` — для прогонов по расписанию.

## 7. Обновление

Правки канона `<repo>/.omp` → повторный `tools/install.ps1` (Windows) или `tools/install.sh` (linux/macos).
Проверь: `install.ps1 -Check` / `install.sh --check` → `in sync`.

## 8. Machine-специфика (не в гите продукта)

`~/.omp/agent/models.yml` (провайдеры/endpoint LM Studio) и `modelRoles` в `~/.omp/agent/config.yml`
(`default/producer/critic/explorer/advisor` = Qwen **намеренно**, INV-9 cheap-дефолт) — редактируются
на машине, installer их **сохраняет** (не перезаписывает machine-head). Сильная модель заходит через
`claude -p` субпроцесс в `design_worker`/`execute_worker`, не через эти роли.

## 9. Backend делегации (выбор исполнителя design/execute)

Кто исполняет design/execute-стадии — настраивается per-stage. Backend: `claude` (дефолт, сильная
модель через `claude -p`, ToS-safe) | `omp` (нативная модель из `modelRoles`/провайдера, вкл. strong-API) |
`codex` (execute, кросс-вендор) | `omp-fanout` (execute, изолированный воркер в git-worktree-клоне).

Приоритет override: task-file поле (`design-backend:`/`execute-backend:`) > env
(`OMP_BACKEND_DESIGN`/`OMP_BACKEND_EXECUTE`) > `<project>/.omp/delegation.yml` > дефолт `claude`.

Три варианта (пример `delegation.yml`):
```yaml
# 1) только OMP:        design: omp     execute: omp
# 2) делегация части:   design: claude  execute: omp
# 3) делегация всего:   design: claude  execute: claude   # дефолт
design: claude
execute: claude
```
`delegation.yml` — проектный (читается от cwd, как `zonemap.yml`), не глобал. Нет файла → дефолт `claude`.

Статусы: `claude` валиден. `codex` load-proven (нужен codex CLI+auth). **`omp` built, LIVE-PENDING**
(`--mode json` output-shape не сверен, model-backend flaky). **`omp-fanout` — Path A (git-worktree)
валиден** (регресс `backend.fanout.test.ts` 9/9): воркер бежит в клоне HEAD, в реальный tree возвращаются
ТОЛЬКО файлы в зоне (вне-зоны отбрасываются с клоном — изоляция load-bearing). `backend: omp` = вложенный
`omp -p` → любая `modelRoles`-модель, включая сильную по API (§8).

> **omp-fanout Path B (нативный isolated task-субагент)** — экспериментальный upgrade за флагом
> `OMP_FANOUT_NATIVE=1` (даёт OMP-managed projfs вместо нашей git-worktree). Probe подтвердил наличие
> `pi.pi.BUILTIN_TOOLS.task`/`TaskParams.isolated`, но контракт вызова не сверён → при флаге пробуется
> native, при сбое fallback на Path A; диагностика формы в `.workflow/fanout-native-diag.json`. Требует
> живой yolo-валидации.

**OpenCode-flavor delegation** — отдельная: `.opencode/delegation.yml` (не `.omp/`), env `AIWF_BACKEND_DESIGN`/
`AIWF_BACKEND_EXECUTE` (не `OMP_BACKEND_*`). Backend'ы: `opencode` (нативный движок, `opencode run --agent`, **дефолт
flavor'а**) | `claude` | `codex` | `opencode-fanout` (git-worktree Path A; native Path B не портирован). Приоритет
override тот же (task-file поле > env > delegation.yml > code-дефолт `claude`).

## 10. Телеметрия и анализ

Тулы/хуки пишут структурированный NDJSON (best-effort, не влияет на поток) по 3 осям —
производительность / потребление / качество-безопасность:
- `<project>/.workflow/telemetry.ndjson` (по-проектно, gitignored вместе с `/.workflow/`)
- `~/.omp/agent/telemetry.ndjson` (cross-project агрегат, machine-specific, не версионится)

Два вида строк: `kind:run` (per stage-run — backend/outcome/duration/worker-tokens+cost/commit) и
`kind:guard` (срабатывание рельса — zone-violation/gate-bounce/critic/misroute/fr-trace-fail/
test-cmd-red/raw-git-deny/bypass-suspected). Rail-коммиты несут трейлер `[omp-rail:<tool>]`.

```bash
python tools/stats.py                       # 3-осевые таблицы (глобал): perf/consumption/guard + cost-per-verified + by-model
python tools/stats.py --path .workflow/telemetry.ndjson   # проектный
python tools/stats.py --csv metrics.csv     # экспорт run-строк (под внешний анализ)
python tools/stats.py --tid <id>            # drill-down: все run+guard строки одной задачи
python tools/audit_commits.py --since <ref> # коммиты без rail-подписи = обход (--emit пишет guard)
```

- **Авто-bypass-аудит:** под автономной очередью (`queue_rpc.py`) queue-runner на done-verdict сам
  проверяет коммиты хода на rail-подпись → пишет guard `bypass-suspected` (ручной `audit_commits.py` не нужен).
- **Ротация:** глобальный NDJSON сам ротируется при `≥20MB` (rename `.ndjson.1`); порог — env `OMP_TELEMETRY_CAP_MB`.

> `cost-per-verified-outcome` (stats.py) = измеримый L-3 инвариант. `raw-git-deny`/`bypass-suspected`
> в guard-топе = где модель обходит рельсы → куда харденить продукт.

## Траблшутинг

- **`config.yml: would change` после установки** — PS5.1 читает UTF-8 как cp1251; installer читает
  с `-Encoding UTF8` (фикс на месте). Если правил config вручную не-UTF8 — пересохрани в UTF-8 no-BOM.
- **omp не видит тулы** — проверь tilde-пути в глобал-config (relative не резолвятся против config-файла).
- **`codex_worker` PREFLIGHT err** — codex CLI не установлен/не авторизован (см. §1 опц.).
- **isolation fail-closed** — target-репо без коммитов; сделай ≥1 коммит.
