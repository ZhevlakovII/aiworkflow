/**
 * Command classifier entry point.
 *
 * T7-6 (contract L-4): `tools/policy/intent.py` below is a HISTORICAL source
 * — deleted in T7; this file (+ `./zone.ts`/`./git.ts`/`./security-floor.ts`/
 * `./rules.ts`) is the source of truth now (see `./rules.ts` header for the
 * full note).
 *
 * T2a: security-floor + git verdict.
 * T2b: zone / write-to-protected verdict (port of `tools/policy/intent.py`
 * `classify()` step 3, `_is_write_to_protected` — see `./zone.ts`), wired in
 * with an actor-aware protected-set (contract §Модель, `worker` bash-denylist
 * vs `operator` `operator_zone.protected`).
 *
 * T7-7 (contract `.workflow/tasks/t7-7-operator-external-whitelist.md`, L-4,
 * documented-not-fixed): unlike `path-zone.ts`'s `classifyPath` (which now
 * has a hard "outside repoRoot -> deny unless operator-whitelisted" floor
 * for Write/Edit), THIS bash surface has no repoRoot-boundary concept at
 * all — `resolveProtectedSet`'s protected-set is a raw substring pattern
 * (`./zone.ts` `pathSetRegex`) matched against the write-target TEXT
 * wherever it appears; it never resolves the target to an absolute path or
 * checks it against `repoRoot`/an operator external-whitelist. An operator
 * bash-write to an absolute path OUTSIDE the repo is therefore NOT specially
 * checked (see `classify.test.ts` "T7-7 L-4" fixtures) — a real asymmetry
 * vs. the Write/Edit surface, left AS-IS by design (contract: "ужесточение
 * Bash вне репо — НЕ в этой задаче", a separate future decision).
 */
import type { ResolvedPolicy } from "../policy/policy.ts";
import { matchSecurityFloor } from "./security-floor.ts";
import { classifyGit, type Verdict, type Decision } from "./git.ts";
import { isWriteToProtected, extractWriteTargets, maskHeredocs, type Shell } from "./zone.ts";
import { normalizePath, pathMatches } from "./path-zone.ts";
import { DEFAULT_PROTECTED } from "./rules.ts";

export type { Verdict, Decision };

/**
 * Command actor — who is issuing the shell command.
 *
 * `worker`: the bash-denylist surface (this file) applies `zone.deny`
 * (worker-scoped protected globs) always, plus the bash allow-lane
 * (`zone.allow`, contract T7-0 L-3) when explicitly provided. The primary
 * worker ALLOWlist surface remains Write/Edit `file_path` glob matching
 * (T2c, `path-zone.ts`).
 *
 * `operator`: the classic `operator_zone` surface — protected-set is
 * `policy.operator_zone.protected` when `operator_zone.enabled`, otherwise
 * the zone-check is skipped entirely (off/assist profiles: operator trusted).
 */
export type Actor = "operator" | "worker";

export interface ZoneOptions {
  /** Worker-scoped protected-path globs (bash-denylist). Consulted only for `actor === "worker"`. */
  deny?: readonly string[];
  /**
   * Worker allow-lane globs. Consulted on TWO surfaces: `path-zone.ts`'s
   * `classifyPath` (Write/Edit `file_path`, T2c) always; this bash surface
   * (`classify()`, contract T7-0 L-3) only when explicitly provided (`undefined`
   * -> bash keeps its pre-L-3 zone.deny-only behaviour, see `classify()` step 4).
   */
  allow?: readonly string[];
}

export interface ClassifyOptions {
  /** Shell dialect for token-table selection (T2b). `undefined` -> union of posix+powershell tables. */
  shell?: Shell;
  policy: ResolvedPolicy;
  /**
   * Who issued the command. **Fail-closed (contract, critic m3): if omitted,
   * treated as `"worker"`** (the strict path) — never defaults to the more
   * permissive `operator` behaviour.
   */
  actor?: Actor;
  zone?: ZoneOptions;
  /**
   * Repo root used to normalize an extracted bash write-target (contract
   * T7-0 L-3, `extractWriteTargets` + `normalizePath`) before glob-matching
   * it against `zone.allow`. Mirrors `ClassifyPathOptions.repoRoot`
   * (`path-zone.ts`). Not required when no worker allow-lane check applies
   * (`zone.allow` unset, or actor !== "worker").
   */
  repoRoot?: string;
}

/** Merge `DEFAULT_PROTECTED` (FIX-1 floor) with a caller-configured set, de-duplicated. */
function withFloor(configured: readonly string[]): readonly string[] {
  const seen: string[] = [];
  for (const p of [...DEFAULT_PROTECTED, ...configured]) {
    if (!seen.includes(p)) seen.push(p);
  }
  return seen;
}

/**
 * Resolve the actor-aware protected-set for the zone/write-to-protected step
 * (contract §Модель verdict).
 *
 * FIX-1 (security-review, blocker): whenever the zone-check is ACTIVE for the
 * actor, `DEFAULT_PROTECTED` (`.git`, see `rules.ts`) is merged in as a
 * non-removable floor — an empty/unconfigured `zone.deny` /
 * `operator_zone.protected` must never silently fail-open the whole
 * zone-check.
 *
 * - `worker` -> zone-check always active -> `DEFAULT_PROTECTED ∪ zone.deny`.
 * - `operator` + `operator_zone.enabled` (guarded/autonomous) -> zone-check
 *   active -> `DEFAULT_PROTECTED ∪ policy.operator_zone.protected`.
 * - `operator` + `operator_zone` off (off/assist profiles, no explicit
 *   override) -> zone-check SKIPPED ENTIRELY (floor included, by design —
 *   operator trusted at those profiles) -> empty.
 */
export function resolveProtectedSet(
  actor: Actor,
  policy: ResolvedPolicy,
  zone: ZoneOptions | undefined
): readonly string[] {
  if (actor === "worker") {
    return withFloor(zone?.deny ?? []);
  }
  if (policy.operator_zone.enabled) {
    return withFloor(policy.operator_zone.protected);
  }
  return [];
}

/**
 * Classify a shell command under a resolved policy.
 *
 * Order (contract §Модель verdict — porting `tools/policy/intent.py`
 * `classify()`'s step order onto the new profile-aware model):
 *   0. heredoc-body masking (T7-9, contract L-1, `zone.ts` `maskHeredocs`) —
 *      applied ONCE, up front, to the raw `cmd`; every step below (including
 *      security-floor) sees the masked text. A heredoc body is DATA, not
 *      commands, unless its consumer is an interpreter (fail-closed).
 *   1. security-floor (always, unless `policy.security_floor.enabled === false`
 *      — an explicit opt-out) — hard deny, independent of profile/path.
 *   2. git-mut / branch-delete, under `policy.rail.level` reach-semantics.
 *   3. zone (write-intent-to-protected, actor-aware protected-set) — T2b.
 *   4. bash allow-lane (worker-only, `zone.allow` explicit) — T7-0 L-3.
 *   5. otherwise -> allow.
 */
export function classify(cmd: string, options: ClassifyOptions): Verdict {
  const { policy, zone } = options;
  const command = maskHeredocs(cmd ?? "");

  if (policy.security_floor.enabled) {
    const reason = matchSecurityFloor(command);
    if (reason) return { decision: "deny", reason };
  }

  const gitVerdict = classifyGit(command, policy.rail.level);
  if (gitVerdict) return gitVerdict;

  const actor: Actor = options.actor ?? "worker"; // fail-closed: no actor -> worker (strict)
  const protectedSet = resolveProtectedSet(actor, policy, zone);
  if (protectedSet.length > 0 && isWriteToProtected(command, options.shell, protectedSet)) {
    return {
      decision: "deny",
      reason: `zone-guard: bash-запись/удаление под ${protectedSet.join("|")} запрещена.`,
    };
  }

  // Step 4 (contract T7-0 L-3): bash allow-lane — worker-only, and ONLY when
  // `zone.allow` is EXPLICITLY provided (undefined -> the bash surface keeps
  // its pre-L-3 zone.deny-only behaviour; many existing callers configure
  // only a protected-denylist here, never an allow-lane — see corpus.json
  // `actor:"worker"` fixtures with `zone:{deny:[...]}` and no `allow` key,
  // which must keep passing unchanged).
  if (actor === "worker" && zone?.allow !== undefined) {
    for (const raw of extractWriteTargets(command, options.shell)) {
      const norm = normalizePath(raw, options.repoRoot);
      if (norm === null || !pathMatches(norm, zone.allow)) {
        return {
          decision: "deny",
          reason: `zone-guard: bash-запись в '${raw}' вне allow-полосы воркера.`,
        };
      }
    }
  }

  return { decision: "allow" };
}
