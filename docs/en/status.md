# Status (2026-11)

**Core + flow + restrictions** for OMP / Cursor / OpenCode: **closed** (2026-11-06). Live smokes = install consumer → probe (see `.workflow/ledger/core-flow-complete-2026-11-06.md`).

## Landed

| Area | State |
|------|--------|
| Ports-as-SRC | `ports/<client>/` = installer SRC; no root dogfood `.omp` / `.cursor` |
| Scaffold stage | judge `scaffold-*` + role `scaffolder`; `scaffold_session` on OMP/OC; Cursor skill `aiwf-scaffold` |
| Session write protected (SWP) | command-hook deny Write/Edit on protected stage paths |
| Lead freeze (execute-open) | operator edit freeze while execute stage open |
| `by:judge` zone marker | grants / zone allow via judge entry |
| Path + bash bridge | adapters normalize tools; bash/PS → core `ompGuardDecision` / `opencodeGuardDecision` before regex leftovers |
| Shell SWP / freeze | bash/PS redirects denied when SWP/freeze active |
| Design C B-track | design_session / execute_session + judge + attribution fail-closed (OMP) |

Pointers: `.workflow/ledger/b-track-status-2026-10-30.md`, `layout-agents-cleanup-2026-11-02.md`, `core-ports-finish-2026-11-06.md`.

## Deferred forever

Until explicit reopen:

| Item | Note |
|------|------|
| Full zone-guard rebind | Thin path-bridge landed; full rebind design deferred |
| Bounce / revise machines | revise_budget counters included |
| CC `design_session` | Claude Code port lacks in-session design_session parity |
| OMP loader §6.2 | Loader work deferred |

## Docs layout

Live root = `map` / `status` / `keys` only. Prior design/research/decisions stay in local-canon `docs/archive/` (not in the public dist).
