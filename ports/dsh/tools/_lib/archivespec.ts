// archive-spec adapter — thin shim over core/src/design/archive-spec.ts (OMP parity).
export type { ReqKind, RawBlock, MergeResult, ReconcileFn } from "../../../../core/src/design/archive-spec.ts";
export {
  parseBlocksRaw,
  injectFrom,
  stmt,
  emitCanon,
  buildDedupePrompt,
  applyDedupe,
  mergeCanon,
} from "../../../../core/src/design/archive-spec.ts";
