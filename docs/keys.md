# Ключевые решения

Только короткие локи. Археология → `docs/archive/` (local-canon only; не в публичном installable surface). EN-зеркало → `docs/en/`.

## Publish

- Публичный dist = whitelist через `publish.sh`; никогда `git push origin master` — только `bash publish.sh`.

## Макро-флоу

`classify → design → plan → scaffold → execute → gate → report`

- Lead оркестрирует; не производит production-код/контент.
- Дефолтный session-путь: `design_session` / `scaffold_session` / `execute_session` (+ native spawn ролей). Judge/journal в `core/src/stage/`.
- Механический design-гейт = `gate-lint` / judge — красный ≠ PASS.
- Task-file (`.workflow/tasks/<id>.md`) — иммутабельный контракт.

## Роли

Текст канона: `canon/roles/` → в port `agents/` на install/render.

producer · critic · explorer · scaffolder · executor · домен-девы (kmp/go/gradle/ktor/rust/swift).

Доменный executor резолвится из project zonemap + allow-глобов задачи — не «на вкус» lead. Produce ≠ decide: worker производит; critic находит; **лочит lead**.

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
| claude | `ports/claude/` | `.claude/` / `~/.claude` |
