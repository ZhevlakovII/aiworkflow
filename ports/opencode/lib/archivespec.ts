// archive-spec adapter (phase-b1, contract L-2) — thin shim over
// core/src/design/archive-spec.ts (single implementation). Own merge/dedupe
// logic removed. Exported API is UNCHANGED for existing callers
// (archive_spec.ts).
export type { ReqKind, RawBlock, MergeResult, ReconcileFn } from "../../../core/src/design/archive-spec.ts";
export {
  parseBlocksRaw,
  injectFrom,
  stmt,
  emitCanon,
  buildDedupePrompt,
  applyDedupe,
  mergeCanon,
} from "../../../core/src/design/archive-spec.ts";
