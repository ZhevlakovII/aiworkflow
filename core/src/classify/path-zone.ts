/**
 * Path-zone classification (T2c) — the SECOND zone-surface, distinct from the
 * bash-parsing surface in `./zone.ts` (T2b, `isWriteToProtected`).
 *
 * A `Write`/`Edit` tool-call carries a `file_path` directly — no shell
 * parsing is involved, this is a pure glob-match against the resolved zone
 * (contract §Модель). This is where the WORKER ALLOWLIST lives (D9, "worker
 * writes ONLY inside its allow-lane") — `classify.ts`/`zone.ts` (T2a/T2b)
 * never consult `zone.allow`, only `zone.deny` (see `ZoneOptions` doc-comment
 * in `classify.ts`).
 *
 * Reuses `DEFAULT_PROTECTED` (`./rules.ts`) and `Verdict`/`Actor`/
 * `ZoneOptions` (`./classify.ts`) — no duplicate type/data definitions
 * (contract scope note).
 */
import { homedir } from "node:os";
import nodePath from "node:path";

import { DEFAULT_PROTECTED, DEFAULT_EXTERNAL_PROTECTED } from "./rules.ts";
import type { ResolvedPolicy } from "../policy/policy.ts";
import type { Actor, Verdict, ZoneOptions } from "./classify.ts";

export interface ClassifyPathOptions {
  /** Fail-closed (contract L-2): omitted -> `"worker"` (the strict path). */
  actor?: Actor;
  policy: ResolvedPolicy;
  /** `zone.allow` — worker allow-lane globs. `zone.deny` — worker-scoped extra denylist (merged with DEFAULT_PROTECTED). */
  zone?: ZoneOptions;
  /**
   * Repo root used to relativize an absolute `filePath`. Not required for an
   * already-relative `filePath`. See `normalizePath` for the outside-repoRoot
   * fail-closed behaviour.
   */
  repoRoot?: string;
  /**
   * T7-7 (contract L-1) — home directory used to resolve `~`-prefixed globs
   * in `policy.operator_zone.external_allow` / `DEFAULT_EXTERNAL_PROTECTED`.
   * Injectable for tests; production default is `os.homedir()` (applied
   * inside `classifyPath`, not here — keeps this options type a plain data
   * bag with no implicit side-effecting default).
   */
  homeDir?: string;
}

/**
 * Normalize a filesystem path to a repo-relative POSIX path (contract DS2 —
 * Windows path handling; T7-8 contract L-1/L-2/L-3 — lexical `.`/`..`
 * collapse BEFORE the result is ever handed to `pathMatches`).
 *
 * T7-8 finding (T7-7 "separate finding", now fixed): the pre-T7-8 version of
 * this function only ever string-sliced the relative suffix after a prefix
 * match against `repoRoot` — it never actually collapsed `.`/`..` segments,
 * it merely used a NET-DEPTH counter (`escapesRoot`) to reject a path that
 * escapes `repoRoot` overall. That counter correctly answers "does this
 * escape?" but does NOT derive the canonical string — an INTERIOR `..` that
 * stays net-non-negative (e.g. `core/legacy/../secret/x`) was returned
 * RAW, `..` segment intact, and `classifyPath` then glob-matched that raw
 * string — letting `core/legacy/**` "allow" a path that actually resolves
 * OUTSIDE `core/legacy` entirely. Fixed by routing every branch through the
 * SAME lexical resolver (`resolveForMatch`, reused from T7-7 — not
 * duplicated) so the string this function returns is always the REAL
 * collapsed path, never a raw one a glob can be lexically fooled by.
 *
 * Steps:
 *  1. Backslash -> forward-slash (Windows paths use `\`; the glob machinery
 *     below is POSIX-`/`-only).
 *  2. If `filePath` is absolute (after step 1: starts with `/`, or a
 *     `C:/`-style drive letter, or a UNC `//...`) AND `repoRoot` is given:
 *     lexically resolve BOTH `filePath` and `repoRoot` via `resolveForMatch`
 *     (collapses `.`/`..`, applies the same NTFS trailing-dot/space +
 *     `\\?\`/device-path/8.3 hardening as the T7-7 external-whitelist path —
 *     contract L-2, "для обоих акторов") and relativize the RESOLVED path
 *     against the RESOLVED root. Outside the root after resolution, or
 *     either side fails to lexically resolve -> `null` (fail-closed
 *     sentinel: "outside repoRoot", `classifyPath` treats `null` as deny).
 *  3. If `filePath` is absolute and NO `repoRoot` is given, it cannot be
 *     related to the repo tree at all -> `null` (fail-closed: an absolute
 *     path with nothing to relativize against is untrusted).
 *  4. A relative `filePath` with `repoRoot` given (contract L-3) is resolved
 *     the SAME way as step 2 — joined onto `repoRoot` first, then run
 *     through the identical lexical-resolve + relativize path, so
 *     `"core/../x"` and `"<repoRoot>/core/../x"` produce IDENTICAL results.
 *  5. A relative `filePath` with NO `repoRoot` given (e.g. `zone-check.ts`'s
 *     git-diff-relative paths, which never carry a real repoRoot) is still
 *     lexically collapsed — anchored to an internal synthetic root purely to
 *     reuse the same Win32-lexical machinery — so a `..` that nets negative
 *     (escapes even a notional root) still fails closed (`null`), matching
 *     the pre-T7-8 `escapesRoot` net-depth semantics, but now via REAL
 *     collapse, not just a depth counter.
 */
export function normalizePath(filePath: string, repoRoot?: string): string | null {
  const raw = filePath.replace(/\\/g, "/");

  const isAbsolute = raw.startsWith("/") || /^[A-Za-z]:\//.test(raw);

  if (isAbsolute) {
    if (!repoRoot) {
      // Absolute path, nothing to relativize against -> can't prove it's
      // inside the repo -> fail-closed deny signal.
      return null;
    }
    return relativizeInRepo(raw, repoRoot);
  }

  if (repoRoot) {
    const root = repoRoot.replace(/\\/g, "/").replace(/\/+$/, "");
    return relativizeInRepo(root + "/" + raw, repoRoot);
  }

  return collapseRelativeNoRoot(raw);
}

/**
 * T7-8 — lexically resolve an ABSOLUTE `absoluteRaw` and an absolute
 * `repoRoot` (both via `resolveForMatch`, T7-7) and return `absoluteRaw`'s
 * path RELATIVE to `repoRoot` in canonical (already `.`/`..`-collapsed)
 * `/`-joined form. `null` if either side fails to lexically resolve, or the
 * resolved `absoluteRaw` is not inside the resolved `repoRoot` at all.
 * Case-insensitive prefix compare (mirrors the pre-T7-8 `rootLower`/
 * `rawLower` convention — Windows-safe drive-letter + realistic
 * same-machine path-casing drift), but the RETURNED string preserves
 * `absoluteRaw`'s original casing (same contract as before T7-8).
 */
function relativizeInRepo(absoluteRaw: string, repoRoot: string): string | null {
  const resolvedPath = resolveForMatch(absoluteRaw);
  if (resolvedPath === null) return null;
  const resolvedRoot = resolveForMatch(repoRoot);
  if (resolvedRoot === null) return null;

  const rootNoSlash = resolvedRoot.replace(/\/+$/, "");
  const rootLower = rootNoSlash.toLowerCase();
  const pathLower = resolvedPath.toLowerCase();

  if (pathLower === rootLower) return "";
  if (pathLower.startsWith(rootLower + "/")) {
    return resolvedPath.slice(rootNoSlash.length + 1);
  }
  // Resolved path outside repoRoot's tree entirely (incl. any '..' that
  // nets it above repoRoot — contract L-3/L-5, e.g. `core/legacy/../../..`).
  return null;
}

// T7-8 — a relative `filePath` normalized with NO real `repoRoot` (e.g.
// `zone-check.ts`'s git-diff-relative paths) still needs the SAME lexical
// `.`/`..` collapse + NTFS hygiene as the repoRoot-anchored branches, but
// has no real absolute root to resolve against. Anchored to this synthetic,
// Windows-shaped sentinel purely to reuse `resolveForMatch`'s machinery
// (contract "переиспользовать resolveForMatch, не дублировать") — never
// exposed outside this module, never matched against anything real.
const RELATIVE_ANCHOR = "C:/__t7_8_normalize_anchor__";

function collapseRelativeNoRoot(raw: string): string | null {
  const resolved = resolveForMatch(RELATIVE_ANCHOR + "/" + raw);
  if (resolved === null) return null;

  const anchorLower = RELATIVE_ANCHOR.toLowerCase();
  const resolvedLower = resolved.toLowerCase();

  if (resolvedLower === anchorLower) return "";
  if (resolvedLower.startsWith(anchorLower + "/")) {
    return resolved.slice(RELATIVE_ANCHOR.length + 1);
  }
  // Enough leading '..' to net-escape even the synthetic anchor -> fail
  // closed (same net-depth-escape semantics as the pre-T7-8 `escapesRoot`).
  return null;
}

/**
 * Compile a gitignore-flavoured glob into a `RegExp` matching a FULL
 * repo-relative POSIX path (contract §Glob-семантика, Q4).
 *
 * Semantics (own minimal implementation, zero deps):
 *  - `**` -> matches across `/` boundaries, i.e. zero-or-more path segments
 *    (`.*` — greedy is fine here, the whole pattern is anchored `^...$`).
 *    A `**` immediately followed by a single `/` additionally consumes that
 *    slash (contract Amend A1, gitignore/Python `glob_to_re` parity): a
 *    glob shaped `x` + `/` + `**` + `/` + `y` matches `x/y` too (zero
 *    intervening segments), not only `x/a/y`. `**` at the very END of a
 *    glob (see the dir-glob prefix decision below) has no following `/` to
 *    consume, so it is unaffected by this rule.
 *  - `*`  -> matches within ONE segment only (`[^/]*` — does not cross `/`).
 *  - `?`  -> exactly one non-`/` character (`[^/]`).
 *  - Any other character is a regex-escaped literal.
 *  - The compiled pattern is anchored (`^` / `$`) — always matched against
 *    the full path, never a substring.
 *
 * dir-glob prefix decision (contract Q4, "реши как в gitignore"): a glob
 * ending in `/**` (e.g. `src/auth/**`) is gitignore-style — `foo/**` means
 * "everything INSIDE foo", the directory `src/auth` itself is NOT matched
 * by `src/auth/**` alone. This is a DELIBERATE choice (documented, tested —
 * see `dir-glob prefix` fixtures in `path-zone.test.ts`): callers who want
 * the directory entry itself matched too should list both `src/auth` and
 * `src/auth/**`, exactly like a `.gitignore` file would need `src/auth`
 * itself matched by a separate line/pattern (a bare directory name in a
 * `.gitignore` already matches the dir and everything under it via the
 * implicit trailing-slash rule; ours is a plain string-equality/glob match
 * with no implicit directory-vs-file distinction, so we mirror the explicit
 * `/**` case only and keep the semantics documented rather than implicit).
 */
export function globToRegExp(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, "/");
  let pattern = "";
  let i = 0;
  const n = normalized.length;
  while (i < n) {
    if (normalized.startsWith("**", i)) {
      pattern += ".*";
      i += 2;
      // `**` immediately followed by `/` eats that slash too — 0+ segments
      // (contract Amend A1, gitignore/Python `glob_to_re` parity).
      if (i < n && normalized[i] === "/") i += 1;
      continue;
    }
    const c = normalized[i];
    if (c === "*") {
      pattern += "[^/]*";
    } else if (c === "?") {
      pattern += "[^/]";
    } else {
      pattern += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    i += 1;
  }
  return new RegExp("^" + pattern + "$");
}

/** True if `path` matches at least one glob in `globs` (contract `pathMatches`). */
export function pathMatches(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

/**
 * Expand a DENY-side protected-entry into its effective glob set.
 *
 * `DEFAULT_PROTECTED` / `zone.deny` / `operator_zone.protected` entries are
 * historically bare directory NAMES (`.git`, `.omp`, ...) — see the T2b
 * corpus fixtures (`protected: [".git"]`, `zone.deny: [".omp"]`) and
 * `rules.ts`'s `DEFAULT_PROTECTED = [".git"]`. `Write`/`Edit` never targets a
 * bare directory (only files) — a literal glob-match on `.git` alone
 * (`^\.git$`) would match NOTHING for realistic paths like `.git/config`,
 * silently defeating the floor (contract L-3: the floor must actually apply
 * here). To keep the SAME entry meaningful on both zone-surfaces (T2b's
 * segment/boundary match already treats `.git` as "the dir and everything
 * under it"), a plain entry with no glob metacharacter (`*`/`?`) is expanded
 * here to `[entry, entry + "/**"]` — matches the directory-as-a-whole-tree
 * intent. An entry the caller already authored WITH a metacharacter (e.g.
 * `logs/**`, `*.secret`) is left as-is — the caller already made an explicit
 * glob choice, this function does not second-guess it. Deliberate,
 * DENY-side-only expansion (never applied to `zone.allow` — allow-lane
 * globs are always author-explicit, e.g. `core/**`, per contract example).
 */
function expandProtectedEntry(entry: string): string[] {
  if (/[*?]/.test(entry)) return [entry];
  const trimmed = entry.replace(/\/+$/, "");
  return [trimmed, trimmed + "/**"];
}

function protectedGlobs(entries: readonly string[]): string[] {
  return entries.flatMap(expandProtectedEntry);
}

/**
 * T7-7 (contract L-1/L-2) — expand a leading `~` (harness-home shorthand,
 * the ONLY glob vocabulary `external_allow`/`DEFAULT_EXTERNAL_PROTECTED`
 * entries use) to an absolute, `/`-joined glob rooted at `homeDir`. A glob
 * NOT starting with `~`/`~/` is returned unchanged (backslash-normalized) —
 * this function does not invent a meaning for `~user`-style expansion,
 * outside this contract's vocabulary.
 */
function expandHomeGlob(glob: string, homeDir: string): string {
  const normalized = glob.replace(/\\/g, "/");
  if (normalized !== "~" && !normalized.startsWith("~/")) return normalized;
  const home = homeDir.replace(/\\/g, "/").replace(/\/+$/, "");
  return home + normalized.slice(1);
}

// T7-7 hardening (path-traversal fix) — `\\.\` / `//./` device-namespace
// prefix: bypasses normal Win32 path parsing at the OS level; this function
// cannot safely reason about it lexically -> always fail-closed (see
// `resolveForMatch`).
const DEVICE_PATH_PREFIX_RE = /^\/\/\.\//;
// `\\?\` / `//?/` long-path prefix: disables `.`/`..` interpretation AT THE
// OS LEVEL for the raw win32 API, but is routinely used simply to opt into
// long-path support — the remainder is still a normal path 99% of the time.
// "Handled" (contract, cheap case) by stripping the prefix and then
// resolving the remainder normally, same as any other Windows path (a
// deliberate, documented approximation — NOT a byte-for-byte port of
// Win32's actual `\\?\`-prefixed parsing rules).
const LONG_PATH_PREFIX_RE = /^\/\/\?\//;
// Windows 8.3 short-name heuristic ("PROGRA~1", "SETTIN~1.JSO") — cheap
// per-segment detection: a short-name expansion requires a filesystem
// lookup (this module deliberately does zero fs access, contract "no
// symlink-following" extends to short-name resolution too) -> "anything you
// can't normalize -> fail-closed deny" (contract). Deliberately broad/
// over-inclusive (may flag a handful of legitimate `~`+digit filenames) —
// same fail-closed-over-fail-open bias as every other floor in this module.
const SHORT_NAME_SEGMENT_RE = /^[^~./]{1,8}~\d+(\.[^~./]{0,3})?$/i;

/**
 * T7-7 hardening (coordinator fix, path-traversal bypass) — lexically
 * resolve an ABSOLUTE path for external-whitelist matching: collapses
 * `.`/`..` segments and repeated/mixed separators (`path.win32.resolve` /
 * `path.posix.resolve`, chosen by input shape — contract "reuse... or
 * resolve depending on input shape"), strips a `\\?\`/`//?/` long-path
 * prefix, and trims NTFS trailing-dot/trailing-space PER SEGMENT (Win32
 * quirk: `settings.json.` and `settings.json ` address the SAME file as
 * `settings.json` — CreateFile-level behaviour, not just the final
 * component, so applied to every segment here, not only the last).
 *
 * Deliberately LEXICAL ONLY — zero filesystem access:
 *  - **Symlinks are OUT OF SCOPE** (not detected, not followed, not denied
 *    specially): a symlink planted inside the whitelist pointing at a
 *    protected file (or vice versa) slips past this function entirely. A
 *    known, documented residual gap — not addressed by this task.
 *  - **8.3 short names** are treated as "cannot normalize" (see
 *    `SHORT_NAME_SEGMENT_RE`) -> fail-closed `null`, not silently resolved.
 *  - `\\.\` device-namespace paths -> fail-closed `null` (see
 *    `DEVICE_PATH_PREFIX_RE`).
 *  - Anything that, after the above, is neither Windows-shaped
 *    (`X:/...` or a UNC `//server/...`) nor POSIX-shaped (`/...`) -> `null`.
 *
 * Returns the resolved path in `/`-joined form (still original-case — the
 * caller lower-cases for the actual glob match), or `null` on any of the
 * fail-closed conditions above.
 */
function resolveForMatch(input: string): string | null {
  let raw = input.replace(/\\/g, "/");

  if (DEVICE_PATH_PREFIX_RE.test(raw)) return null;
  if (LONG_PATH_PREFIX_RE.test(raw)) raw = raw.slice(4);

  const isWindows = /^[A-Za-z]:\//.test(raw) || raw.startsWith("//");
  const isPosix = !isWindows && raw.startsWith("/");
  if (!isWindows && !isPosix) return null; // not a recognizable absolute path -> fail-closed

  if (isWindows) {
    const parts = raw.split("/");
    for (let i = 0; i < parts.length; i++) {
      if (i === 0 && /^[A-Za-z]:$/.test(parts[i])) continue; // never trim the drive-letter root
      // `.`/`..` are path SYNTAX (dot-segments the resolve step below
      // interprets), not literal filenames — the NTFS trailing-dot/space
      // trim below must never touch them (a naive trim would collapse the
      // literal string ".." down to "" since it's entirely dots, silently
      // NEUTERING the traversal instead of correctly resolving it — this
      // was a real bug caught in review here, not a hypothetical).
      if (parts[i] === "." || parts[i] === "..") continue;
      if (SHORT_NAME_SEGMENT_RE.test(parts[i])) return null; // possible 8.3 short name -> fail-closed
      parts[i] = parts[i].replace(/[. ]+$/, "");
    }
    return nodePath.win32.resolve(parts.join("/")).replace(/\\/g, "/");
  }

  return nodePath.posix.resolve(raw);
}

/**
 * T7-7 (contract L-1/L-3) — classify an absolute `filePath` that
 * `normalizePath` already proved is OUTSIDE `repoRoot` (or unrelated to any
 * `repoRoot` at all), for `actor === "operator"` ONLY (the caller,
 * `classifyPath`, never reaches this for `worker` — contract "Worker — без
 * изменений").
 *
 * Both `filePath` AND `homeDir` are lexically resolved via
 * `resolveForMatch` BEFORE matching (path-traversal hardening — a raw
 * `.`/`..`-carrying path must never slip past the whitelist/protected-floor
 * glob check just because the LITERAL, unresolved string happens to start
 * with an allowed prefix). Matching itself is Windows-safe case-INsensitive
 * (mirrors `normalizePath`'s own `rootLower`/`rawLower` prefix-match
 * convention above — same file, same precedent, contract DS2 "drive-letter
 * case" + realistic same-machine path casing drift) — the whole resolved
 * path/glob is lower-cased before compiling/testing, not just the drive
 * letter.
 *
 * Returns:
 *  - `null` — `filePath`/`homeDir` could not be confidently resolved (see
 *    `resolveForMatch`'s fail-closed conditions), OR `filePath` (resolved)
 *    is not under ANY `externalAllow` glob at all. Either way the caller
 *    falls through to its existing unconditional "outside repoRoot" deny.
 *  - a `deny` Verdict — inside the whitelist, but matches
 *    `DEFAULT_EXTERNAL_PROTECTED` (hardcoded floor, NOT policy.yml
 *    overridable, contract L-3: harness hook/permission config files that
 *    would let an agent weaken its own enforcement).
 *  - an `allow` Verdict — inside the whitelist, not protected.
 */
function classifyExternalPath(
  filePath: string,
  homeDir: string,
  externalAllow: readonly string[]
): Verdict | null {
  const resolvedPath = resolveForMatch(filePath);
  if (resolvedPath === null) return null;
  const resolvedHome = resolveForMatch(homeDir);
  if (resolvedHome === null) return null;

  const raw = resolvedPath.toLowerCase();

  const allowGlobs = externalAllow.map((g) => expandHomeGlob(g, resolvedHome).toLowerCase());
  if (!pathMatches(raw, allowGlobs)) {
    return null;
  }

  const protectedGlobsList = DEFAULT_EXTERNAL_PROTECTED.map((g) => expandHomeGlob(g, resolvedHome).toLowerCase());
  if (pathMatches(raw, protectedGlobsList)) {
    return {
      decision: "deny",
      reason:
        "zone-guard: harness-конфиг/хук-файл внутри operator external-whitelist защищён (protected floor) — запись, ослабляющая собственные хуки/permissions, запрещена.",
    };
  }

  return { decision: "allow" };
}

/**
 * Classify a `Write`/`Edit` `file_path` against the resolved zone (contract
 * §Модель verdict — path-surface, distinct from `classify()`'s bash-surface).
 *
 * Order:
 *  1. Normalize `filePath` (see `normalizePath`). `null` (outside repoRoot /
 *     unrelated absolute path) -> immediate **deny** (fail-closed, contract
 *     L-2).
 *  2. `actor` unset -> `"worker"` (fail-closed, contract L-2).
 *  3. `worker`: `allow = zone.allow ?? []`, `deny = [...DEFAULT_PROTECTED,
 *     ...(zone.deny ?? [])]`. Deny-match -> deny. No allow-match (including
 *     an empty allow list -> misconfiguration, D9) -> deny. Otherwise
 *     -> allow.
 *  4. `operator` + `policy.operator_zone.enabled` (guarded/autonomous):
 *     `deny = [...DEFAULT_PROTECTED, ...(policy.operator_zone.protected ??
 *     [])]`. Deny-match -> deny; otherwise -> allow (no allow-lane
 *     restriction — operator is only protected-bound).
 *  5. `operator` + operator_zone OFF (off/assist): allow (model trusted,
 *     unrestricted).
 *
 * Design C `session_write_protected` / `enforcement_paths` / create-only
 * task-files are NOT enforced here — AD-session-write-protected-set is
 * command-hook-only (actor=operator pre-write). L1 `gatedCommit` reuses
 * this function and must still stage `policy.yml` / `core/src/**`.
 *
 * T7-7 (contract L-1, `.workflow/tasks/t7-7-operator-external-whitelist.md`)
 * — step 1's "outside repoRoot -> deny" is no longer UNCONDITIONAL: for
 * `actor === "operator"` specifically (never `worker`, unaffected by this
 * amend, contract "Worker — без изменений") a path outside `repoRoot` is
 * first checked against `policy.operator_zone.external_allow`
 * (`classifyExternalPath`) — allow/deny from THAT whitelist (incl. its own
 * L-3 protected-floor) short-circuits the plain deny below. This check is
 * UNCONDITIONAL on `policy.operator_zone.enabled`/profile (contract text
 * does not gate it on operator_zone — mirrors the fact that the deny it
 * carves an exception FROM was itself unconditional pre-T7-7).
 */
export function classifyPath(filePath: string, options: ClassifyPathOptions): Verdict {
  const { policy, zone, repoRoot } = options;
  const actor: Actor = options.actor ?? "worker"; // fail-closed: no actor -> worker (strict)

  const path = normalizePath(filePath, repoRoot);
  if (path === null) {
    if (actor === "operator") {
      const homeDir = options.homeDir ?? homedir();
      const externalVerdict = classifyExternalPath(filePath, homeDir, policy.operator_zone.external_allow);
      if (externalVerdict !== null) return externalVerdict;
    }
    return {
      decision: "deny",
      reason: "zone-guard: путь вне repoRoot — запись вне репозитория запрещена.",
    };
  }

  if (actor === "worker") {
    const allow = zone?.allow ?? [];
    const rawDeny = [...DEFAULT_PROTECTED, ...(zone?.deny ?? [])];
    if (pathMatches(path, protectedGlobs(rawDeny))) {
      return {
        decision: "deny",
        reason: `zone-guard: запись под ${rawDeny.join("|")} запрещена (protected floor).`,
      };
    }
    if (allow.length === 0 || !pathMatches(path, allow)) {
      return {
        decision: "deny",
        reason: "zone-guard: путь вне allow-полосы воркера (worker allowlist, D9).",
      };
    }
    return { decision: "allow" };
  }

  // actor === "operator"
  if (policy.operator_zone.enabled) {
    const rawDeny = [...DEFAULT_PROTECTED, ...policy.operator_zone.protected];
    if (pathMatches(path, protectedGlobs(rawDeny))) {
      return {
        decision: "deny",
        reason: `zone-guard: запись под ${rawDeny.join("|")} запрещена (operator_zone protected).`,
      };
    }
    return { decision: "allow" };
  }

  return { decision: "allow" };
}
