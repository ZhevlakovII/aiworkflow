# Key decisions

Short locks only. Archaeology → `docs/archive/` (local-canon only; not part of the public installable surface).

## Publish

- Public dist = whitelist via `publish.sh` / `publish.ps1`; never `git push origin master` — only `bash publish.sh` or `.\publish.ps1`.

## Macro flow

**Default:** `classify → design? → execute → gate → report` (design for non-trivial; `trivial` may skip design).

**Stage catalog (7):** classify · design · plan · scaffold · execute · gate · report. Plan and scaffold remain named stages, **default off**, opt-in via task lever (`plan`/`plan-opt-in`, `scaffold`/`scaffold-opt-in`).

- Lead orchestrates; does not produce production code/content.
- Session drivers: `design_session` / `execute_session`; `scaffold_session` only when scaffold is on. Judge/journal in `core/src/stage/` (shared ck12: strip id/supersedes/stage + `binds` to the design task).
- Mechanical design gate = `gate-lint` / judge — red ≠ PASS.
- Task-file (`.workflow/tasks/<id>.md`) is the immutable contract.

## Roles

Canon text: `canon/roles/` → rendered into port `agents/` at install.

producer · critic · explorer · scaffolder · executor (five base roles). Domain agent is not canon: consumer overlay + a filled project zonemap entry.

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

| Client | SRC | Consumer dest |
|--------|-----|----------------|
| omp | `ports/omp/` | `.omp/` or `~/.omp/agent` |
| cursor | `ports/cursor/` | `.cursor/` / `~/.cursor` |
| opencode | `ports/opencode/` | `.opencode/` (+ root `opencode.json`) |
| dsh | `ports/dsh/` | profile `~/.dsh/profiles/<profile>/plugins/aiwf/` + project `.dsh-aiwf/` |
| claude | `ports/claude/` | `.claude/` / `~/.claude` |

**DSH P1 (2026-11-09):** `gated_merge`, `code_search`/`outline`/`callers` (ast-index), `hooks/dsh-telemetry.ts`, `delegation.yml` seed, `setup.sh -Flow all` includes dsh.

**DSH P2 (2026-11-09):** `plan`/`synthesize`/`archive_spec`, queue-runner (`DSH_QUEUE`/`AIWF_QUEUE`, best-effort inject), WATCHDOG (doc-only), fan-out unsupported.
