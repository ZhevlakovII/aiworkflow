// fr-trace adapter (phase-b1, contract L-2) — thin shim over
// core/src/design/fr-trace.ts (single implementation). Own traceability-gate
// logic removed. Exported API (`FrTraceResult`/`frIdsFromSpec`/`isTestFile`/
// `frTrace`) is UNCHANGED for existing callers (execute_worker.ts,
// codex_worker.ts).
export type { FrTraceResult } from "../../../core/src/design/fr-trace.ts";
export { frIdsFromSpec, isTestFile, frTrace } from "../../../core/src/design/fr-trace.ts";
