# Статус (2026-11)

**Core + flow + ограничения** для OMP / Cursor / OpenCode: **закрыты** (2026-11-06). **DSH (P0):** `ports/dsh/` Cordis-плагин + `install-dsh` + `dshGuardDecision` (2026-11-09, execute-ports-dsh-p0). **DSH (P1):** merge + ast-index discovery + telemetry + `setup -Flow all` включает dsh (execute-ports-dsh-p1, 2026-11-09). **DSH (P2):** plan/synthesize/archive_spec + queue-runner + WATCHDOG doc + fan-out unsupported (execute-ports-dsh-p2, 2026-11-09). Лайв-смоки = install в consumer → пробы (см. `.workflow/ledger/core-flow-complete-2026-11-06.md`, smoke Forza `.workflow/ledger/smoke-live-omp-forza-2026-11-08.md`, smoke FinManage OMP+Cursor `.workflow/ledger/smoke-live-omp-cursor-finmanage-2026-11-09.md`).

## Заземлилось

| Область | Состояние |
|---------|-----------|
| Ports-as-SRC | `ports/<client>/` = SRC инсталлера; нет root dogfood `.omp` / `.cursor` |
| Стадия scaffold | **opt-in** (default off); judge `scaffold-*` + роль `scaffolder` when on; `scaffold_session` OMP; execute-begin не требует scaffold-done если off |
| Session write protected (SWP) | command-hook: deny Write/Edit на защищённые stage-пути |
| Lead freeze (execute-open) | заморозка правок operator, пока открыта стадия execute |
| Маркер `by:judge` | mutual exclusion: begin без legacy-зоны; grants apply на входе judge |
| Path + bash bridge | адаптеры нормализуют тулы; bash/PS → core `ompGuardDecision` / `opencodeGuardDecision` до regex-хвостов харнесса |
| Shell SWP / freeze | redirect-таргеты bash/PS под SWP/freeze |
| Design C B-track | `design_session` / `execute_session` + judge + attribution fail-closed (OMP) |
| Domain roles collapse (phase 1) | Шесть `*-developer` убраны из канона; default execute = `executor`; zonemap optional, not seeded (2026-11-09) |
| Flow opt-in + contract-key | plan/scaffold default off; ck12 strip id/supersedes/stage + binds; judge stage MISROUTE parity (2026-11-09) |
| Domain roles collapse (phase 2) | `ports/*/agents` регенерированы рендером (base five); domain md удалены; drift test сверяет committed ports (2026-11-09) |
| Global rollout + Composer seed (2026-11-10) | Global OMP/Cursor/DSH reinstall (base five); public `origin/main` republished; `smol`/seed cheap-default = xAI Composer (не local Qwen); matrix 4.7 на producer/slow/scaffolder |
| Cursor model_map ↔ OMP (2026-11-10) | tools/adapters/cursor.yml: composer-2.5-fast / grok-4.7-high-fast (не sonnet/opus); global Cursor reinstall |
| plan/synthesize/archive defaults (2026-11-10) | `resolveStrongModel` from live OMP modelRoles (producer→slow→default); OpenCode oneshot → omp -p |
| Installer vendor+rewrite (wave B, 2026-11-11) | Все flavor installers (`install`/`install-*` ps1+sh) зовут `tools/install-runtime.ts`: vendor `core/src` в dest, rewrite imports file-relative, commands abs-in-dest; OpenCode oneshot/reason overlay; Cursor included; `-Check` would-vendor |
| Bootstrap+docs (wave C, 2026-11-11) | Bootstrap = release zip+sha256 (not clone-root); shared head AIWF_CONFIG_HOME / XDG / ~/.config/aiwf; legacy models.yml strip + modelRoles→OMP sync; all includes cursor+dsh; OpenCode rewrite-to-dest; update=re-bootstrap; uninstall=installer flag, head preserved |
| Install shadow stdout fix (2026-11-12) | `rewrite-imports`/`vendor`/`rewrite-commands` status → stderr; bash `new_import_rewritten_shadow` redirects runtime to `>&2` so command-sub captures only shadow path (macOS rsync exit 23) |



Указатели: `.workflow/ledger/b-track-status-2026-10-30.md`, `layout-agents-cleanup-2026-11-02.md`, `core-ports-finish-2026-11-06.md`, `flow-rollout-composer-2026-11-10.md`, `cursor-omp-model-align-2026-11-10.md`, `plan-strong-model-modelroles-2026-11-10.md`, `wave-b-installers-vendor-2026-11-11.md`, `wave-c-bootstrap-docs-2026-11-11.md`.

## Отложено навсегда

Пока явно не откроем заново:

| Пункт | Заметка |
|-------|---------|
| Полный rebind zone-guard | Тонкий path/bash-bridge уже есть; полный design rebind отложен |
| Bounce / revise machines | в т.ч. счётчики `revise_budget` |
| CC `design_session` | у Claude Code нет parity in-session design_session |
| OMP loader §6.2 | работа над loader отложена |

## Раскладка доков

Живой корень = `map` / `status` / `keys` (RU). EN → `docs/en/`. Старое design/research/decisions — в локальном `docs/archive/` (не в публичном dist).
