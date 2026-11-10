# Ключевые решения

Только короткие локи. Археология → `docs/archive/` (local-canon only; не в публичном installable surface). EN-зеркало → `docs/en/`.

## Publish

- Публичный dist = whitelist через `publish.sh` / `publish.ps1`; никогда `git push origin master` — только `bash publish.sh` или `.\publish.ps1`.

## Макро-флоу

**Дефолт:** `classify → design? → execute → gate → report` (design для нетривиального; `trivial` может без design).

**Каталог стадий (7):** classify · design · plan · scaffold · execute · gate · report. Plan и scaffold — именованные стадии, **default off**, opt-in рычагом задачи (`plan`/`plan-opt-in`, `scaffold`/`scaffold-opt-in`).

- Lead оркестрирует; не производит production-код/контент.
- Session-драйверы: `design_session` / `execute_session`; `scaffold_session` только при scaffold on. Judge/journal в `core/src/stage/` (общий ck12: strip id/supersedes/stage + `binds` на design-задачу).
- Механический design-гейт = `gate-lint` / judge — красный ≠ PASS.
- Task-file (`.workflow/tasks/<id>.md`) — иммутабельный контракт.

## Роли

Текст канона: `canon/roles/` → в port `agents/` на install/render.

producer · critic · explorer · scaffolder · executor (пять базовых). Доменный агент — не канон: consumer overlay + запись заполненной project zonemap.

Резолв execute: нет карты / пустая / miss / deny / ambiguous → `executor`; ровно одно совпадение → имя из карты. Правила проекта на `executor` (и любом domain-акторе) важнее общих идиом. Produce ≠ decide: worker производит; critic находит; **лочит lead**.

## Рельсы L1–L3

Сырой `git commit|push|merge|reset|…` режет хук. Только rail CLI / gated-тулы (`core/src/rails/cli.ts`): commit → push → merge. На L1 — zone-check staged-путей.

## Zone-guards (что живо)

| Слой | Поведение |
|------|-----------|
| Path / Write | command-hook + адаптеры; allow-глобы active-zone |
| Bash / PS | мост в core guard (SWP / freeze) до regex-хвостов харнесса |
| SWP | `session_write_protected` — deny operator Write/Edit на protected stage-пути |
| Freeze | lead freeze при открытом execute |
| `by:judge` | зона/grants через judge, не freeform |
| Не живо | полный design rebind zone-guard (отложен навсегда) |

## Ограничения

- **SWP** — protected stage-файлы не правятся operator-тулами.
- **Freeze** — заморозка правок lead на время открытого execute.
- **by:judge** — зона/grants от судьи, не произвольный lead-write зоны.
- **Tasks** — create-only контракты; после авторства не переписывать.
- **Ports-as-SRC** — правим `ports/<client>/`; install штампует consumer `.<client>/`. В product-репо нет root dogfood.

## Порты

| Клиент | SRC | Dest у consumer |
|--------|-----|-----------------|
| omp | `ports/omp/` | `.omp/` или `~/.omp/agent` |
| cursor | `ports/cursor/` | `.cursor/` / `~/.cursor` |
| opencode | `ports/opencode/` | `.opencode/` (+ root `opencode.json`) |
| dsh | `ports/dsh/` | профиль `~/.dsh/profiles/<profile>/plugins/aiwf/` + проект `.dsh-aiwf/` |
| claude | `ports/claude/` | `.claude/` / `~/.claude` |

**DSH P1 (2026-11-09):** `gated_merge`, `code_search`/`outline`/`callers` (ast-index), `hooks/dsh-telemetry.ts`, seed `delegation.yml`, `setup.sh -Flow all` → dsh.

**DSH P2 (2026-11-09):** `plan`/`synthesize`/`archive_spec`, `hooks/queue-runner` (`DSH_QUEUE`/`AIWF_QUEUE`), `WATCHDOG.md`+`WATCHDOG.yml` (doc-only advisor), fan-out **unsupported** (`backend.ts` fail-closed).
