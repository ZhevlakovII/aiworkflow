# Статус (2026-11)

**Core + flow + ограничения** для OMP / Cursor / OpenCode: **закрыты** (2026-11-06). Лайв-смоки = install в consumer → пробы (см. `.workflow/ledger/core-flow-complete-2026-11-06.md`, smoke Forza `.workflow/ledger/smoke-live-omp-forza-2026-11-08.md`).

## Заземлилось

| Область | Состояние |
|---------|-----------|
| Ports-as-SRC | `ports/<client>/` = SRC инсталлера; нет root dogfood `.omp` / `.cursor` |
| Стадия scaffold | judge `scaffold-*` + роль `scaffolder`; `scaffold_session` на OMP/OC; Cursor skill `aiwf-scaffold` |
| Session write protected (SWP) | command-hook: deny Write/Edit на защищённые stage-пути |
| Lead freeze (execute-open) | заморозка правок operator, пока открыта стадия execute |
| Маркер `by:judge` | mutual exclusion: begin без legacy-зоны; grants apply на входе judge |
| Path + bash bridge | адаптеры нормализуют тулы; bash/PS → core `ompGuardDecision` / `opencodeGuardDecision` до regex-хвостов харнесса |
| Shell SWP / freeze | redirect-таргеты bash/PS под SWP/freeze |
| Design C B-track | `design_session` / `execute_session` + judge + attribution fail-closed (OMP) |

Указатели: `.workflow/ledger/b-track-status-2026-10-30.md`, `layout-agents-cleanup-2026-11-02.md`, `core-ports-finish-2026-11-06.md`.

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
