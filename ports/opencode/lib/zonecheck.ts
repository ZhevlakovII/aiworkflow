// zone-check adapter (phase-b1, contract L-2) — thin shim over core/src.
// Own glob/normalize implementations removed; logic now lives in
// core/src/classify/path-zone.ts (globToRegExp/normalizePath) and
// core/src/zone/zone-check.ts (checkZone). Exported API (globToRe/norm/
// zoneCheck) is UNCHANGED for existing callers (gated_commit.ts, design_worker.ts,
// execute_worker.ts, codex_worker.ts, zonemap.ts) — only the implementation
// moved. Where core's semantics differ from the old local copy (T7-8 lexical
// `.`/`..` collapse in `norm`/`normalizePath`, absent from the old `norm`),
// core WINS (contract L-3) — see phase-b1 task return for the one documented
// divergence.
import { globToRegExp, normalizePath } from "../../../core/src/classify/path-zone.ts";
import { checkZone } from "../../../core/src/zone/zone-check.ts";

/** Compiles a gitignore-flavoured glob into a RegExp (delegates to core). */
export function globToRe(glob: string): RegExp {
  return globToRegExp(glob);
}

/** Normalizes a path for zone-matching (delegates to core's normalizePath,
 *  no repoRoot — these paths are always git-diff/stdin relative). */
export function norm(p: string): string {
  const trimmed = p.trim();
  if (!trimmed) return "";
  return normalizePath(trimmed) ?? trimmed.replace(/\\/g, "/");
}

/** Returns the list of violation-strings (empty = clean). allow required. */
export function zoneCheck(paths: string[], allow: string[], deny: string[]): string[] {
  return checkZone(paths, allow, deny).violations;
}
