/**
 * zone-check core (T7-2) — TS port of `tools/zone_check.py`'s matching logic.
 *
 * Pure `checkZone(paths, allow, deny) -> {violations, ok}` (contract L-3):
 * no git/fs access, no process.exit — testable in isolation. The thin I/O
 * shell (argv parsing, git subprocess, stdin) lives in `./zone-check-cli.ts`.
 *
 * Glob-semantics (contract L-2): reuses `globToRegExp`/`pathMatches` from
 * `../classify/path-zone.ts` — NOT a third glob implementation. See
 * `zone-check-cli.ts`'s doc-comment for the ONE documented divergence from
 * the Python `glob_to_re` found while porting (`**` immediately followed by
 * `/` eating that slash vs not).
 *
 * Path normalization mirrors the Python `norm()` (strip whitespace,
 * backslash -> `/`, strip a leading `./`) via a thin local wrapper around
 * `normalizePath` (no `repoRoot` — paths here are always git-diff/stdin
 * relative, never absolute; `normalizePath` returning `null` for an
 * absolute path with no `repoRoot` is treated as "keep the raw slash-
 * normalized string", not a special deny — same as Python, which does not
 * special-case absolute paths, they simply fail to match a relative glob).
 */
import { pathMatches, normalizePath } from "../classify/path-zone.ts";

export interface ZoneCheckResult {
  violations: string[];
  ok: boolean;
}

function normPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const n = normalizePath(trimmed);
  return n ?? trimmed.replace(/\\/g, "/");
}

/** Trim + drop blank entries — same as Python's `x.strip()` per CSV glob token. */
function cleanGlobs(globs: readonly string[]): string[] {
  return globs.map((g) => g.trim()).filter((g) => g.length > 0);
}

/**
 * Each normalized path must match >=1 allow-glob AND no deny-glob, else a
 * violation. Deny wins over allow (checked first, same as Python). `allow`
 * empty is a caller-level error in the Python CLI (exit 2 before ever
 * reaching this function) — here an empty `allow` simply means everything
 * is "вне allow-zone" (every non-blank path becomes a violation).
 */
export function checkZone(
  paths: readonly string[],
  allow: readonly string[],
  deny: readonly string[],
): ZoneCheckResult {
  const allowGlobs = cleanGlobs(allow);
  const denyGlobs = cleanGlobs(deny);
  const ps = paths.map(normPath).filter((p) => p.length > 0);

  const violations: string[] = [];
  for (const p of ps) {
    if (pathMatches(p, denyGlobs)) {
      violations.push(`${p}: matches deny-zone`);
    } else if (!pathMatches(p, allowGlobs)) {
      violations.push(`${p}: вне allow-zone`);
    }
  }
  return { violations, ok: violations.length === 0 };
}
