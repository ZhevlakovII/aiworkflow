// task-file frontmatter parser adapter (phase-b1, contract L-2) — thin shim
// over core/src/design/task-zone.ts (`parseZone`/`scalarField`). Own
// frontmatter/globList/scalar implementations removed; logic + `Zone`
// interface now live in core (single implementation, T7 "kill dupes"
// direction). Exported API is UNCHANGED for existing callers
// (gated_commit.ts, execute_worker.ts, design_worker.ts, codex_worker.ts).
export type { Zone } from "../../../core/src/design/task-zone.ts";
export { parseZone, scalarField } from "../../../core/src/design/task-zone.ts";
