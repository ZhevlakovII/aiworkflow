/**
 * git-mut / branch-delete classification, rail-reach-aware (T2a).
 *
 * T7-6 (contract L-4): `tools/policy/intent.py` below is a HISTORICAL source
 * — deleted in T7; this file is the source of truth now (see `./rules.ts`
 * header for the full note).
 *
 * Ported from `tools/policy/intent.py` (`_git_mut_regex`, `_branch_delete_regex`,
 * the git-mut/branch-delete steps of `classify()`), re-modeled as profile-aware
 * verdicts driven by `policy.rail.level` (contract §Модель verdict, D6 —
 * reach-semantics; the old intent.py had no profile concept, only a single
 * always-on rail behaviour — see T1 PRESETS + corpus.json note fields for the
 * old→new mapping).
 */
import type { RailLevel } from "../policy/profile.ts";
import { BRANCH_DELETE_PATTERN, GIT_MUT, GIT_MUT_RAILS } from "./rules.ts";

export type Decision = "allow" | "deny" | "rail";

export interface Verdict {
  decision: Decision;
  reason?: string;
  subcommand?: string;
}

// FIX-4 (security review, intent.py `_GIT_BIN` comment): `git.exe` is the
// real git binary name on PATH on Windows. A bare `\bgit\s+` regex required
// a space right after "git" -> "git.exe commit" slipped past the rail.
// `git(?:\.exe)?\s+` catches both forms. MUST be preserved verbatim.
const GIT_BIN = String.raw`\bgit(?:\.exe)?\s+`;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const GIT_MUT_REGEX = new RegExp(GIT_BIN + "(" + GIT_MUT.map(escapeRegExp).join("|") + ")\\b");
const BRANCH_DELETE_REGEX = new RegExp(GIT_BIN + BRANCH_DELETE_PATTERN);

/** Railable subcommands, in reach order (contract D6: commit ⊆ push ⊆ merge). */
const RAILABLE = new Set(["commit", "push", "merge"]);

/**
 * Reach table (contract D6: commit ⊆ push ⊆ merge), exported for reuse by the
 * rail-concern reach-guard (T4, `core/src/rails/*.ts`) — the rails MUST read
 * reach from here, not re-derive/duplicate the table (contract L-4).
 */
export const RAIL_REACH: Readonly<Record<Exclude<RailLevel, "none">, readonly string[]>> = {
  commit: ["commit"],
  push: ["commit", "push"],
  merge: ["commit", "push", "merge"],
};

function allow(): Verdict {
  return { decision: "allow" };
}

function deny(reason: string, subcommand?: string): Verdict {
  return { decision: "deny", reason, subcommand };
}

function rail(subcommand: string, reason: string): Verdict {
  return { decision: "rail", reason, subcommand };
}

const BRANCH_DELETE_DENY_REASON =
  "zone-guard: raw git-мутация `git branch -d/-D` запрещена (рельсы держат " +
  "дерево чистым; используй gated_commit/push/merge или читай состояние).";

function genericDenyReason(sub: string): string {
  return (
    `zone-guard: raw git-мутация \`git ${sub}\` запрещена (рельсы держат ` +
    `дерево чистым; используй gated_commit/push/merge или читай состояние).`
  );
}

function railReason(sub: string): string {
  const railText = GIT_MUT_RAILS[sub];
  return (
    `zone-guard: raw \`git ${sub}\` заблокирован — коммить/пушь/мёржи ТОЛЬКО ` +
    `через рельс: ${railText}. Рельс делает zone-check staged + test-cmd/probe ` +
    `(детерминир. enforcement на чокпоинте).`
  );
}

function beyondReachDenyReason(sub: string, railLevel: RailLevel): string {
  return (
    `zone-guard: raw \`git ${sub}\` за пределами reach текущего rail-уровня ` +
    `(${railLevel}) — запрещено (рельс этого уровня не покрывает \`${sub}\`).`
  );
}

/**
 * Classify a git-mutation / branch-delete command under a rail level.
 * Returns `null` when `cmd` is not a git-mut match at all — this includes
 * git-READ (status/diff/log/rev-parse/show/branch-without-flags), which
 * falls through to `allow` further up the chain in classify.ts.
 *
 * Reach semantics (contract §Модель verdict, D6):
 *  - `railLevel === "none"` (profiles off/assist): raw git-mut is allowed
 *    (operator trusted); branch-delete is allowed too.
 *  - `railLevel !== "none"`: railable subs {commit,push,merge} within reach
 *    (commit⊆push⊆merge) -> rail; beyond reach -> deny. Non-railable
 *    mutations (reset/checkout/restore/clean/stash/rm/apply/cherry-pick/
 *    rebase/tag/add) -> deny. branch-delete -> deny.
 */
export function classifyGit(cmd: string, railLevel: RailLevel): Verdict | null {
  if (BRANCH_DELETE_REGEX.test(cmd)) {
    if (railLevel === "none") return allow();
    return deny(BRANCH_DELETE_DENY_REASON);
  }

  const match = GIT_MUT_REGEX.exec(cmd);
  if (!match) return null;
  const sub = match[1];

  if (railLevel === "none") return allow();

  if (RAILABLE.has(sub)) {
    const reach = RAIL_REACH[railLevel];
    if (reach.includes(sub)) return rail(sub, railReason(sub));
    return deny(beyondReachDenyReason(sub, railLevel), sub);
  }

  return deny(genericDenyReason(sub), sub);
}
