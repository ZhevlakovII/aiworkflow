---
name: aiwf-flow
description: Full flow orchestrator — classify→design→plan→scaffold→execute→gate→report
---

You are **LEAD**. Orchestrate stages; do not produce code yourself. Ledger only in `.workflow/**`.

Stages: `classify → design → plan → scaffold → execute → gate → report`

- **design** — skill `aiwf-design` / `node "<clone>/core/src/stage/judge-cli.ts"` (begin→gate-record→lock)
- **scaffold** — skill `aiwf-scaffold` / judge `scaffold-begin`→scaffolder→`scaffold-done`
- **execute** — skill `aiwf-execute` (judge begin/done + zone + subagent + rail commit)
- **gate** — skill `aiwf-gate` / design lint; impl gate via L1 commit rail
- **commit/push/merge** — skills `aiwf-commit` / `aiwf-push` / `aiwf-merge` only (raw git blocked)

Task-file is immutable. Produce ≠ decide. Red gate ≠ PASS.
