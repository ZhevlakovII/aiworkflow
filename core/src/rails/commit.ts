/**
 * gatedCommit (T4) — TS port of `tools/gated_commit.py`, re-modeled under the
 * rail/quality_gate/zone governance concerns (contract §Rail-концерн
 * семантика) instead of the Python original's always-on behaviour.
 *
 * Ported behaviour (contract §Что портируется, L-2):
 *  1. git-repo check.
 *  2. `git add -A` — stage BEFORE the gate (otherwise untracked files never
 *     enter the staged set the gate/zone-check see — the same reasoning as
 *     the Python original's comment).
 *  3. zone-check every staged path via `classifyPath` (NEW vs Python: the
 *     original had no zone-check inside `gated_commit.py` itself — this is
 *     the T4 zone concern, replacing the separate `zone_check.py`/
 *     `core/src/zone/zone-check-cli.ts` surface with the unified path-zone
 *     classifier).
 *  4. quality-gate (concern-gated: only when `policy.quality_gate.enabled`
 *     AND a cmd resolves) — red or zone-violation -> `git reset -q`
 *     (unstage; working tree changes survive) + fail.
 *  5. `git commit -m message` on green, with a `[omp-rail:commit]` trailer
 *     appended (contract L-1, T7-6) — unless `message` already carries a
 *     `[omp-rail:` trailer — so `audit-commits` classifies rail-made
 *     commits as signed instead of bypass-suspected (NEW vs Python: the
 *     original committed the message verbatim, no auto-signature).
 *
 * Deliberately OMITTED vs Python (contract §gatedCommit): the
 * `.workflow/gate/PASS` + pending-hash marker — a live-flow runtime
 * artifact, out of scope for this pure rail function.
 *
 * B1 journal-scope (minimum): `.workflow/stages/*.ndjson` are trackable via
 * root `.gitignore` exceptions (`/.workflow/*` + `!/.workflow/stages/**`).
 * Operator may stage/commit them (`.workflow` is not operator_zone.protected).
 * B3 attribution fail-closed: when `policy.stage.attribution_fail_closed`,
 * staged design artifacts (`docs/design/*-{spec,adr}.md`) require a
 * design-lock owner in the journal index; new unattributed files →
 * `attribution-denied` + index reset; HEAD without owner grandfathered.
 */
import { RAIL_REACH } from "../classify/git.ts";
import { classifyPath } from "../classify/path-zone.ts";
import type { Actor, ZoneOptions } from "../classify/classify.ts";
import type { ResolvedPolicy } from "../policy/policy.ts";
import { evaluateStagedAttribution } from "../stage/attribution.ts";
import { GATE_SHELL_MISSING, railTrailerArgs, tailOutput, type GitSeam, type RailResult } from "./git-seam.ts";
import { evaluateTaskScopedProtectedException } from "./task-scoped-protected.ts";

export type { RailResult };

export interface GatedCommitOptions {
  git: GitSeam;
  policy: ResolvedPolicy;
  message: string;
  /** `git commit --allow-empty` equivalent. */
  allowEmpty?: boolean;
  /** Override for the quality-gate command (contract: `policy.quality_gate.cmd`, OR this explicit override). */
  gateCmd?: string;
  /** zone-check actor/zone/repoRoot — forwarded to `classifyPath` per staged file. */
  actor?: Actor;
  zone?: ZoneOptions;
  repoRoot?: string;
  /**
   * T8 H2: active worker zone (`.workflow/active-zone.json`) at commit time.
   * When set, EVERY staged path is additionally checked as `actor: "worker"`
   * against it (outside `allow` / inside `deny` -> `zone-violation`, index
   * reset) — on top of the `actor`/`zone` check above, never instead of it.
   */
  workerZone?: ZoneOptions;
  /**
   * A2 (U13): `.workflow/active-zone.json`'s `task` field (bare task id) —
   * forwarded so a staged path denied under `policy.operator_zone.protected`
   * can be re-checked against `.workflow/tasks/<workerZoneTask>.md` for the
   * task-scoped exception (`./task-scoped-protected.ts`). Only meaningful
   * together with `workerZone`; absent -> exception never attempted (falls
   * back to the plain deny, same as pre-A2 behaviour).
   */
  workerZoneTask?: string;
}

function splitLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function gatedCommit(options: GatedCommitOptions): RailResult {
  const { git, policy } = options;

  if (policy.rail.level === "none") {
    return { ok: false, status: "rail-disabled", detail: "rail.level=none — рельсы выключены (raw git — разрешённый путь)." };
  }
  if (!RAIL_REACH[policy.rail.level].includes("commit")) {
    return {
      ok: false,
      status: "beyond-reach",
      detail: `gatedCommit требует reach>=commit, rail.level=${policy.rail.level} не покрывает commit.`,
    };
  }

  if (git.run(["git", "rev-parse", "--git-dir"]).code !== 0) {
    return { ok: false, status: "guard-fail", detail: "не git-репо" };
  }

  const add = git.run(["git", "add", "-A"]);
  if (add.code !== 0) {
    return { ok: false, status: "guard-fail", detail: `git add -A failed: ${add.stderr}` };
  }

  // zone-check КАЖДОГО staged-файла (contract §Zone концерн).
  const staged = git.run(["git", "diff", "--cached", "--name-only"]);
  if (options.workerZone && staged.code !== 0) {
    // T8 H2 fail-closed: an active zone that cannot be checked is not a pass.
    git.run(["git", "reset", "-q"]);
    return { ok: false, status: "guard-fail", detail: `active-zone: staged-список не получен: ${staged.stderr}` };
  }
  if (staged.code === 0) {
    for (const filePath of splitLines(staged.stdout)) {
      const verdict = classifyPath(filePath, {
        actor: options.actor,
        policy,
        zone: options.zone,
        repoRoot: options.repoRoot,
      });
      if (verdict.decision === "deny") {
        // A2 (U13): a deny under `policy.operator_zone.protected` (never
        // `.git`/DEFAULT_PROTECTED) MAY be waived — task-scoped exception,
        // contract §Требуется п.1-2. `"not-applicable"` -> unchanged deny.
        const exception = evaluateTaskScopedProtectedException({
          filePath,
          actor: options.actor,
          policy,
          repoRoot: options.repoRoot,
          workerZone: options.workerZone,
          workerZoneTask: options.workerZoneTask,
        });
        if (exception.kind === "denied") {
          git.run(["git", "reset", "-q"]);
          return { ok: false, status: exception.status, detail: `${filePath}: ${exception.reason}` };
        }
        if (exception.kind === "not-applicable") {
          git.run(["git", "reset", "-q"]);
          return {
            ok: false,
            status: "zone-violation",
            detail: `${filePath}: ${verdict.reason ?? "zone-guard deny"}`,
          };
        }
        // exception.kind === "exempt" -> waived, fall through (still subject
        // to the workerZone check below, condition (c) re-verified there).
      }
      if (options.workerZone) {
        const zoneVerdict = classifyPath(filePath, {
          actor: "worker",
          policy,
          zone: options.workerZone,
          repoRoot: options.repoRoot,
        });
        if (zoneVerdict.decision === "deny") {
          git.run(["git", "reset", "-q"]);
          return {
            ok: false,
            status: "zone-violation",
            detail: `${filePath}: active-zone: ${zoneVerdict.reason ?? "вне worker-зоны"}`,
          };
        }
      }
    }
  }

  // B3 attribution fail-closed — after staged list / zone-check, before quality-gate.
  if (staged.code === 0 && policy.stage?.attribution_fail_closed) {
    const stagedPaths = splitLines(staged.stdout);
    const attribution = evaluateStagedAttribution({
      staged: stagedPaths,
      policy,
      git,
      repoRoot: options.repoRoot ?? process.cwd(),
    });
    if (!attribution.ok) {
      git.run(["git", "reset", "-q"]);
      return { ok: false, status: attribution.status, detail: attribution.detail };
    }
  }

  // quality-gate — только если concern включён И cmd резолвится (policy или override).
  const gateCmd = options.gateCmd ?? policy.quality_gate.cmd ?? undefined;
  if (policy.quality_gate.enabled && gateCmd) {
    const res = git.runShell(gateCmd);
    if (res.code !== 0) {
      git.run(["git", "reset", "-q"]);
      const status = res.stderr.startsWith(GATE_SHELL_MISSING) ? GATE_SHELL_MISSING : "gate-red";
      return {
        ok: false,
        status,
        detail: `${status} (exit ${res.code}): ${tailOutput(res.stderr || res.stdout)}`,
      };
    }
  }

  // Rail-signature trailer (contract L-1) — [omp-rail:commit], skipped if the
  // message already carries any `[omp-rail:` trailer (no double-sign).
  const commitArgs = ["git", "commit", "-m", options.message, ...railTrailerArgs(options.message, "commit")];
  if (options.allowEmpty) commitArgs.push("--allow-empty");
  const commit = git.run(commitArgs);
  if (commit.code !== 0) {
    return { ok: false, status: "commit-failed", detail: commit.stderr };
  }
  return { ok: true, status: "committed", detail: commit.stdout };
}
