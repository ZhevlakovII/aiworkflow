# Repo map

Product tree for AI Workflow (harness-neutral SDLC layer).

| Path | Role |
|------|------|
| `canon/` | Roles SSOT (+ example `zonemap.yml`, not seeded; `delegation` skeleton). Roles → port agents at install/render. |
| `core/` | Engine: rails L1–L3, judge/stage, gate-lint, render, command-hook / zone guards. |
| `tools/` | Installers, adapters (`tools/adapters/<client>.yml`), setup/bootstrap, templates. |
| `ports/<client>/` | **Port SRC SSOT** (omp, cursor, opencode, claude, …). Not a live harness root in this repo. |
| `.workflow/` | Tasks (immutable contracts), ledger, stage journals, active-zone (runtime). |

## Install destinations

Installers copy `ports/<client>/` → consumer `.<client>/` (project) or the flavor’s global path (`~/.omp/agent`, `~/.cursor`, …). This product checkout does **not** keep live dogfood `.<client>/` trees at root.

Project overlays (optional filled `zonemap.yml` / `delegation.yml`, custom agents) belong in the **consumer** project, not in canon. Installers do **not** seed empty zonemap; missing file is normal → executor.

## Macro path

Default: `classify → design? → execute → gate → report`. Full stage catalog (7) and plan/scaffold opt-in — `docs/en/keys.md`.

## Live docs

- `docs/map.md` — this file
- `docs/status.md` — current product status
- `docs/keys.md` — key decisions

History (design ADRs, research, old install notes) lives in local-canon `docs/archive/` only — not shipped in the public installable tree.
