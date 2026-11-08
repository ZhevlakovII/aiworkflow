# Repo map

Product tree for AI Workflow (harness-neutral SDLC layer).

| Path | Role |
|------|------|
| `canon/` | Roles SSOT (+ empty zonemap/delegation skeletons). Rendered into port agents at install. |
| `core/` | Engine: rails L1–L3, judge/stage, gate-lint, render, command-hook / zone guards. |
| `tools/` | Installers, adapters (`tools/adapters/<client>.yml`), setup/bootstrap, templates. |
| `ports/<client>/` | **Port SRC SSOT** (omp, cursor, opencode, claude, …). Not a live harness root in this repo. |
| `.workflow/` | Tasks (immutable contracts), ledger, stage journals, active-zone (runtime). |

## Install destinations

Installers copy `ports/<client>/` → consumer `.<client>/` (project) or the flavor’s global path (`~/.omp/agent`, `~/.cursor`, …). This product checkout does **not** keep live dogfood `.<client>/` trees at root.

Project overlays (filled `zonemap.yml` / `delegation.yml`, custom agents) belong in the **consumer** project, not in canon.

## Live docs

- `docs/map.md` — this file
- `docs/status.md` — current product status
- `docs/keys.md` — key decisions

History (design ADRs, research, old install notes) lives in local-canon `docs/archive/` only — not shipped in the public installable tree.
