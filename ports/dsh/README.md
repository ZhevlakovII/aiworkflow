# ports/dsh — AI Workflow Cordis plugin (P0–P2)

DeepSeek Harness mounts this package via profile `cordis.patch.yml`. **No** root `.dsh/` dogfood in the product repo.

## Layout

| Surface | Consumer dest |
|---------|----------------|
| Plugin (tools, hooks, `src/index.ts`) | `~/.dsh/profiles/<profile>/plugins/aiwf/` |
| AGENTS.md, RULES.md, WATCHDOG*, rendered agents, zonemap, delegation | `<project>/.dsh-aiwf/` |

## Registered tools

| Tool | Role |
|------|------|
| `gated_commit` / `gated_push` / `gated_merge` | L1–L3 git rails |
| `design_session` / `scaffold_session` / `execute_session` | Stage drivers |
| `code_search` / `outline` / `callers` | ast-index discovery |
| `plan` / `synthesize` / `archive_spec` | P2 one-shot + living spec (see gaps below) |
| `hooks/pre/zone-guard` | pre-execute deny |
| `hooks/dsh-telemetry` | harness NDJSON (`DSH_TELEMETRY_OFF=1`) |
| `hooks/queue-runner` (in `activate`) | opt-in autonomous queue |

## P2 gaps (honest)

| Surface | Live? | Notes |
|---------|-------|--------|
| `archive_spec` deterministic merge | **yes** | reconcile/dedupe need `DSH_ONESHOT=1` or host `ctx.exec` |
| `plan` / `synthesize` | **conditional** | nested harness via `DSH_ONESHOT=1` + `DSH_ONESHOT_BIN`; else fail-closed message |
| `queue-runner` | **best-effort** | Arm: `DSH_QUEUE=1` or `AIWF_QUEUE=1`. Needs Cordis `agent_end`/`turn_end`; inject needs `ctx.sendMessage` — else writes `.workflow/queue-dispatch.ndjson` |
| WATCHDOG | **doc-only** | `WATCHDOG.md` + `WATCHDOG.yml` seeded; advisor runtime not in Cordis v1 |
| Fan-out | **unsupported** | `backend.ts` allows `dsh` only; `*-fanout` fail-closed |

Rail trailer for queue bypass audit: `[dsh-rail:<tool>]`.

## Queue env

| Var | Meaning |
|-----|---------|
| `DSH_QUEUE` / `AIWF_QUEUE` | `1` arms queue-runner |
| `DSH_QUEUE_STATE` / `AIWF_QUEUE_STATE` | default `.workflow/queue-state.json` |
| `DSH_QUEUE_MAX_PARALLEL` | default `1` |
| `DSH_QUEUE_ROLLBACK` | reset tree on blocked (single in-flight) |

## One-shot env

| Var | Meaning |
|-----|---------|
| `DSH_ONESHOT` | `1` enables nested `dsh` for plan/synthesize/reconcile |
| `DSH_ONESHOT_BIN` | default `dsh` |
| `DSH_ONESHOT_ARGS` | extra CLI tokens before `-p` |
| `DSH_PLAN_MODEL` | default model for plan/synthesize |

## Mount

1. `bash tools/install-dsh.sh --profile headless --target /path/to/project`
2. `bash tools/setup.sh --flow all` includes **dsh**.

## Contract tests

**P2 presence:**

```bash
node -e "const fs=require('fs'); const must=['ports/dsh/tools/plan.ts','ports/dsh/tools/synthesize.ts','ports/dsh/tools/archive_spec.ts','ports/dsh/hooks/queue-runner.ts','ports/dsh/WATCHDOG.md','ports/dsh/WATCHDOG.yml']; for (const p of must) { if (!fs.existsSync(p)) { console.error('missing '+p); process.exit(1);} } console.log('ok');"
```

**P1:** merge, discovery, telemetry — see prior README table.

## peerDependencies

`@deepseek-ai/cordis` — provided by the harness at runtime.

## Optional OAuth

`install-dsh --with-xai-oauth` documents patch stanza only (no login).
