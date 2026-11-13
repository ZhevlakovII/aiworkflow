---
name: aiwf-flow
description: Full flow orchestrator — classify→design(spec)→roadmap→execute→gate→report
---

You are **LEAD**. Orchestrate stages; do not produce code yourself. Ledger only in `.workflow/**`.

**Default spine** (`generation: spec-roadmap`): `classify → design(spec) → roadmap → execute → gate → report`

**Catalog:** classify · design · roadmap · execute · gate · report. Names `plan` / `scaffold` are not catalog stages.

- **design** — skill `aiwf-design` / `node "<clone>/core/src/stage/judge-cli.ts"` (begin→gate-record→lock); spec-only on new generation
- **roadmap** — skill `aiwf-roadmap` / judge `roadmap-begin`→roadmapper→`roadmap-done`
- **execute** — skill `aiwf-execute` (judge begin/done + zone + subagent + rail commit); consume locked roadmap AC
- **gate** — skill `aiwf-gate` / design lint; impl gate via L1 commit rail
- **commit/push/merge** — skills `aiwf-commit` / `aiwf-push` / `aiwf-merge` only (raw git blocked)

**Legacy:** `aiwf-scaffold` remains for `generation: sp-adr` + scaffold lever only — not the default mid stage.

Task-file is immutable. Produce ≠ decide. Red gate ≠ PASS.
