// gate-lint adapter (phase-b1, contract L-2) — thin shim over
// core/src/design/gate-lint.ts (single implementation, T7 "kill dupes"
// direction). Own two-stage/EARS gate logic removed. Exported API
// (`GateResult`/`gateLint`) is UNCHANGED for existing callers
// (design_worker.ts).
export type { GateResult } from "../../../../core/src/design/gate-lint.ts";
export { gateLint } from "../../../../core/src/design/gate-lint.ts";
