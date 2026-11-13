# Repo map

Product tree for AI Workflow (harness-neutral SDLC layer).

| Path | Role |
|------|------|
| `canon/` | Roles SSOT (+ example `zonemap.yml`, not seeded; `delegation` skeleton). Roles → port agents at install/render. |
| `core/` | Engine: rails L1–L3, judge/stage, gate-lint, render, command-hook / zone guards. |
| `tools/` | Node CLI `tools/aiwf.ts` + `tools/install/**`, thin setup/bootstrap shells, adapters, templates. |
| `ports/<client>/` | **Port SRC SSOT** (omp, cursor, opencode, dsh; `ports/claude/` may remain unused). Not a live harness root in this repo. |
| `.workflow/` | Tasks (immutable contracts), ledger, stage journals, active-zone (runtime). |

## Install destinations

Installers copy `ports/<client>/` → consumer `.<client>/` (project) or the flavor’s global path (`~/.omp/agent`, `~/.cursor`, …). This product checkout does **not** keep live dogfood `.<client>/` trees at root.

Project overlays (optional filled `zonemap.yml` / `delegation.yml`, custom agents) belong in the **consumer** project, not in canon. Installers do **not** seed empty zonemap; missing file is normal → executor.


## Shared head + runtime dest

- Shared head (models/modelRoles): `AIWF_CONFIG_HOME` → `$XDG_CONFIG_HOME/aiwf` → `~/.config/aiwf`.
- Install dest (each flavor) vendors `core/src` at `<dest>/core/src`; bootstrap cache and `~/.aiworkflow` are not runtime roots.
- Live installer flavors: `omp` | `opencode` | `cursor` | `dsh` (preset `all`). Modes: `full` | `key` | `soft` | `yolo`. No `claude`/`codex`/`both` in installer UX.
- Uninstall = managed flavor trees only; shared head never purged.
## Macro path

Roles: producer · critic · explorer · **roadmapper** · executor (`scaffolder` legacy).

Default: `classify → design(spec) → roadmap → execute → gate → report`. Catalog (no plan/scaffold as stages) and `generation: spec-roadmap` marker — `docs/en/keys.md`.

## Live docs

- `docs/map.md` — this file
- `docs/status.md` — current product status
- `docs/keys.md` — key decisions

History (design ADRs, research, old install notes) lives in local-canon `docs/archive/` only — not shipped in the public installable tree.
