---
name: aiwf-design
description: Design stage — judge begin→producer→gate-lint→optional critic→lock→rail commit
---

Do not write spec/ADR yourself. Orchestrate judge + subagents via `judge-cli`.

1. Begin:
   ```
   node "<clone>/core/src/stage/judge-cli.ts" design-begin --task <task-file>
   ```
2. Spawn producer subagent → write spec/ADR under task allow (narrow return).
3. Gate (mechanical lint, then record). Prefer gate-lint CLI when present:
   ```
   node "<clone>/core/src/design/gate-lint-cli.ts" --task <t> --spec <s> --adr <a>
   node "<clone>/core/src/stage/judge-cli.ts" design-gate-record --task <task-file> --verdict PASS|BOUNCE
   ```
   (If gate-lint-cli is unavailable, run gate via design_session/`gateLint` path and still `design-gate-record`.)
   BOUNCE → one producer retry then re-gate. Red ≠ PASS.
4. Optional critic (per task/class opt-in): spawn critic → findings →
   ```
   node "<clone>/core/src/stage/judge-cli.ts" design-critic-record --task <task-file> --findings <path>
   ```
5. Lock:
   ```
   node "<clone>/core/src/stage/judge-cli.ts" design-lock --task <task-file>
   ```
6. Rail commit:
   ```
   node "<clone>/core/src/rails/cli.ts" commit -m "<msg>"
   ```
