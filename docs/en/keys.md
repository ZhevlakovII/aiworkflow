# Key decisions

Short locks only. Archaeology → `docs/archive/` (local-canon only; not part of the public installable surface).

## Publish

- Public dist = whitelist via `publish.sh`; never `git push origin master` — only `bash publish.sh`.

## Macro flow

`classify → design → plan → scaffold → execute → gate → report`

- Lead orchestrates; does not produce production code/content.
- Default session path: `design_session` / `scaffold_session` / `execute_session` (+ native role spawns). Judge/journal in `core/src/stage/`.
- Mechanical design gate = `gate-lint` / judge — red ≠ PASS.
- Task-file (`.workflow/tasks/<id>.md`) is the immutable contract.

## Roles

Canon text: `canon/roles/` → rendered into port `agents/` at install.

producer · critic · explorer · scaffolder · executor · domain devs (kmp/go/gradle/ktor/rust/swift).

Domain executor resolves from project zonemap + task allow-globs — not by lead taste. Produce ≠ decide: worker produces; critic finds; **lead locks**.

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
| claude | `ports/claude/` | `.claude/` / `~/.claude` |
