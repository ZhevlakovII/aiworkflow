# Status (2026-11)

**Core + flow + restrictions** for OMP / Cursor / OpenCode: **closed** (2026-11-06). Live smokes = install consumer → probe (see `.workflow/ledger/core-flow-complete-2026-11-06.md`, Forza `.workflow/ledger/smoke-live-omp-forza-2026-11-08.md`, FinManage OMP+Cursor `.workflow/ledger/smoke-live-omp-cursor-finmanage-2026-11-09.md`).

## Landed

| Area | State |
|------|--------|
| Ports-as-SRC | `ports/<client>/` = installer SRC; no root dogfood `.omp` / `.cursor` |
| Scaffold stage | **retired** on `generation: spec-roadmap`; legacy + lever only; `scaffolder` not default mid |
| Roadmap stage (Phase 1, 2026-11-13) | Named judge stage; `roadmap-begin`/`done`; `roadmap_session` + `roadmapper`; execute-begin needs roadmap-done on new gen; gate second axis spec↔roadmap |
| Generation cutover | Exclusive `generation: spec-roadmap` vs absent/`sp-adr`; design-lock without product ADR on new gen |
| Session write protected (SWP) | command-hook deny Write/Edit on protected stage paths |
| Lead freeze (execute-open) | operator edit freeze while execute stage open |
| `by:judge` zone marker | grants / zone allow via judge entry |
| Path + bash bridge | adapters normalize tools; bash/PS → core `ompGuardDecision` / `opencodeGuardDecision` before regex leftovers |
| Shell SWP / freeze | bash/PS redirects denied when SWP/freeze active |
| Design C B-track | design_session / execute_session + judge + attribution fail-closed (OMP) |
| Domain roles collapse (phase 1) | Six `*-developer` removed from canon; default execute = `executor`; zonemap optional, not seeded (2026-11-09) |
| Flow opt-in + contract-key | plan/scaffold default off; ck12 strip id/supersedes/stage + binds; judge stage MISROUTE parity (2026-11-09) |
| Domain roles collapse (phase 2) | `ports/*/agents` regenerated via render (live five + roadmapper + scaffolder legacy); domain md removed; drift asserts committed ports (2026-11-09) |
| Bootstrap+docs (wave C, 2026-11-11) | Bootstrap = release zip+sha256 (not clone-root); shared head AIWF_CONFIG_HOME/XDG/~/.config/aiwf; legacy models.yml strip + modelRoles→OMP sync; all includes cursor+dsh; OpenCode rewrite-to-dest; update=re-bootstrap; uninstall keeps head |
| Installer CLI rewrite (2026-11-13) | Primary `tools/aiwf.ts` + `tools/install/**`; modes full|key|soft|yolo; four live flavors; thin shells; install-claude removed |

Pointers: `.workflow/ledger/b-track-status-2026-10-30.md`, `layout-agents-cleanup-2026-11-02.md`, `core-ports-finish-2026-11-06.md`, `wave-c-bootstrap-docs-2026-11-11.md`.

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
