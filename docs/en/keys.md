# Key decisions

Short locks only. Archaeology → `docs/archive/` (local-canon only; not part of the public installable surface).

## Publish

- Public dist = whitelist via `publish.sh` / `publish.ps1`; never `git push origin master` — only `bash publish.sh` or `.\publish.ps1`.

## Macro flow

**Default:** `classify → design(spec) → roadmap → execute → gate → report` (design+roadmap for non-trivial; `trivial` may skip design where class policy already allows).

**Stage catalog:** classify · design · roadmap · execute · gate · report. Names `plan` / `scaffold` are **not** catalog stages. Critic remains opt-in (`critic`/`critic-opt-in`). Plan tool = non-gate utility.

**Generation marker:** `generation: spec-roadmap` = new path (spec + roadmap, no product ADR). Absent / `generation: sp-adr` = legacy dual SP+ADR (+ optional scaffold lever). Exclusive path per contract — no mixed axes.

- Lead orchestrates; does not produce production code/content.
- Session drivers: `design_session` / `roadmap_session` / `execute_session`; `scaffold_session` only for legacy + scaffold on. Judge/journal in `core/src/stage/` (shared ck12: strip id/supersedes/stage + `binds`; stage `roadmap`).
- Mechanical design gate = `gate-lint` / judge — red ≠ PASS. New-gen second axis = spec↔roadmap (`ac`/`phase` covers).
- Task-file (`.workflow/tasks/<id>.md`) is the immutable contract.

## Roles

Canon text: `canon/roles/` → rendered into port `agents/` at install.

producer · critic · explorer · roadmapper · executor. `scaffolder` retired on `spec-roadmap` (legacy only). Domain agent is not canon: consumer overlay + a filled project zonemap entry.

Execute resolve: missing map / empty / unmatched / denied / ambiguous → `executor`; single match → map name. Project rules on `executor` (and any domain actor) beat generic idioms. Produce ≠ decide: worker produces; critic finds; **lead locks**.

## Rails L1–L3

Raw `git commit|push|merge|reset|…` denied by hook. Use rail CLI / gated tools only (`core/src/rails/cli.ts`): commit → push → merge. L1 zone-check on staged paths.

## Zone-guards (what is live)

| Layer | Live behavior |
|-------|----------------|
| Path / Write | command-hook + adapters; active-zone allow-globs |
| Bash / PS | bridge into core guard decision (SWP / freeze) before harness regex leftovers |
| SWP | `session_write_protected` — deny operator Write/Edit on protected stage paths |
| Freeze | execute-open lead freeze |
| `by:judge` | zone/grants applied on judge entry |
| Not live | full zone-guard rebind design (deferred forever) |

## Restrictions

- **SWP** — protected stage files not editable by operator tools while marked.
- **Freeze** — lead edit freeze during open execute.
- **by:judge** — grants/zone from judge, not freeform.
- **Tasks** — create-only contract files; immutable after authoring.
- **Ports-as-SRC** — edit `ports/<client>/`; install stamps consumer `.<client>/`. No root dogfood trees in this product repo.

## Ports

| Client | SRC | Consumer dest | Installer |
|--------|-----|----------------|-----------|
| omp | `ports/omp/` | `.omp/` or `~/.omp/agent` | live |
| cursor | `ports/cursor/` | `.cursor/` / `~/.cursor` | live |
| opencode | `ports/opencode/` | `.opencode/` (+ root `opencode.json`) | live |
| dsh | `ports/dsh/` | profile `~/.dsh/profiles/<profile>/plugins/aiwf/` + project `.dsh-aiwf/` | live |
| claude | `ports/claude/` | (unused by installer) | **not** in UX |

**Installer CLI (2026-11-13):** primary `node tools/aiwf.ts` (`setup` | `install` | `uninstall` | `head`); modes `full|key|soft|yolo`; soft never overwrites existing shared head; uninstall never touches `~/.config/aiwf`. Rejected flows: `claude` | `codex` | `both`.

**DSH P1 (2026-11-09):** `gated_merge`, `code_search`/`outline`/`callers` (ast-index), `hooks/dsh-telemetry.ts`, `delegation.yml` seed, setup `--flow all` includes dsh.

**DSH P2 (2026-11-09):** `plan`/`synthesize`/`archive_spec`, queue-runner (`DSH_QUEUE`/`AIWF_QUEUE`, best-effort inject), WATCHDOG (doc-only), fan-out unsupported.

## Shared head + install lifecycle (2026-11-11)

### Shared head path

Resolve: `AIWF_CONFIG_HOME` → `$XDG_CONFIG_HOME/aiwf` → `~/.config/aiwf` (Windows: profile `.config/aiwf`, not %APPDATA%).
Contents: `models.yml` (providers, maxSubagents) + `config.yml` **only** `modelRoles`.
Theme stays in flavor OMP config. Product-block never copied into head.

### Legacy migrate + modelRoles sync

- If shared head absent and home agent has binding → one-shot import models.yml and/or modelRoles (no product-block).
- After **successful** copy: **strip** legacy home-agent models.yml. Failed copy does not delete.
- Do **not** strip modelRoles from OMP home `config.yml` as sole store.
- **Sync shared → OMP** modelRoles on seed, import, every setup_roles write (product block preserved).
- User edits shared head. OpenCode/DSH do not read the OMP mirror.
- Project `.omp/models.yml` and `.dsh-aiwf/models.yml` beat shared list.

### Bootstrap (not clone-root)

bootstrap downloads `aiworkflow-install.zip` + neighbor sha256, verifies, extracts to temp cache,
runs setup from cache, deletes cache **only on success**; on failure retains + prints path.
Does not delete existing `~/.aiworkflow`. Dest is self-contained with vendored `<dest>/core/src`.

### Flow membership

`omp|opencode|cursor|dsh|all`. Default `all` = four live flavors. `claude` / `codex` / `both` retired from installer UX.
Harness CLI soft-optional on multi-flow (solo flow hard for that flow).

### Path rewrite (all flavors incl OpenCode)

OpenCode **does** rewrite core paths (stale claim that it skips rewrite because `../lib` is relative is false).
All flavors rewrite to **vendored dest**, not clone/cache.

### Update / uninstall

- **Update** = re-bootstrap latest/pin with sum verify; head preserved; project models seed-if-absent preserved; modelRoles still synced OMP from head.
- **Uninstall** = installer flag: removes managed flavor trees incl vendored core + mirrored canon agents; may clear download cache;
  does **not** remove shared head / OMP modelRoles mirror without explicit head purge; does **not** delete `~/.aiworkflow` or user project seed-if-absent without purge.
