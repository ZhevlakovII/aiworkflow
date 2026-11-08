/**
 * Rail CLI (T6 c-build) — runnable process-entrypoint over the T4 rails
 * (`gatedCommit`/`gatedPush`/`gatedMerge`).
 * Source: `.workflow/tasks/ts-pivot-rail-cli-t6cbuild.md`.
 *
 * T7-6 (contract L-4, current state — supersedes the original T6 c-build
 * "NOT wired" scope note below): this CLI IS live-wired now. The copied
 * slash-commands (`.claude/commands/aiwf-commit.md` / `aiwf-push.md` /
 * `aiwf-merge.md`) invoke it directly (`node core/src/rails/cli.ts
 * commit|push|merge ...`) — it IS the active commit/push/merge path.
 * `tools/gated_commit.py` / `gated_push.py` / `gated_merge.py` are DELETED
 * (retired in T7, python rails surface gone); this file is the only path.
 *

 * This module is a THIN wrapper (contract L-2): argv -> Options ->
 * gatedCommit/Push/Merge (T4, unmodified). No rail-logic duplication, no
 * separate policy-resolution — `buildPolicy` (T5a wiring) is the only policy
 * path, same as `command-hook.ts`. `actor` is fixed to `"operator"` for the
 * commit-rail (contract: a rail invocation is an operator/lead action, not a
 * worker path — worker-zone is enforced separately on the path-surface).
 * T8 H2/H3: the commit rail ALSO checks staged paths against an active
 * `.workflow/active-zone.json` (`./active-zone.ts`; broken file ->
 * `zone-invalid`, fail-closed) and refuses `--gate` while that zone is
 * active (`gate-override-denied`). Both statuses exit 1.
 * A5a: while that zone is active the effective quality gate is the active
 * task-file's own `test-cmd` (`./task-gate.ts`, reusing A2's strict
 * `zone:`-block parser) first, `policy.quality_gate.cmd` next, no gate last
 * (unchanged pre-A5a shape) — ANY failure to resolve the task-file's own gate
 * (missing, unreadable, malformed `zone:` block, blank `test-cmd`) is
 * `zone-invalid` too, fail-closed, no silent fallback. The commit's stdout
 * carries a trailing `gate: task|policy|none|override` line naming which
 * source ACTUALLY ran (`none (disabled)` / `none (not reached)` when a
 * resolved cmd never executed — never mislabelled as the resolved source).
 *
 * Exit-code parity (contract L-3, per the explicit §Маппинг table): `ok:true`
 * -> 0; `ok:false` with a guard/policy status (rail-disabled, beyond-reach,
 * guard-fail, zone-violation, gate-red, insufficient, class-blocked,
 * rolled-back) -> 1; `ok:false` with an execution-failure status
 * (`*-failed`, e.g. commit-failed/push-failed) -> 2. Implemented generically
 * via a `-failed` suffix check (exhaustively covers every status the T4
 * rails currently emit — see `core/test/rails.test.ts` / rail source files
 * for the full status enumeration).
 *
 * Type-strip-safe (no enum/namespace/param-props/decorators), zero external
 * deps — only `node:url` + the core modules below. Pure `runRailCli` (deps
 * injection, no direct fs/process access) + thin `main` (real stdin/argv/
 * process.exit), same pure-core/thin-shell split as `command-hook.ts`.
 */
import { fileURLToPath } from "node:url";

import { gatedCommit } from "./commit.ts";
import { gatedPush } from "./push.ts";
import { gatedMerge } from "./merge.ts";
import { nodeGitSeam, type GitSeam, type RailResult } from "./git-seam.ts";
import type { ResolvedPolicy, Policy } from "../policy/policy.ts";
import { buildPolicy, loadPolicyFile, resolveInteractive } from "../wiring/policy-source.ts";
import { loadActiveZoneForCommit, ACTIVE_ZONE_REL, type ActiveZoneLoad } from "./active-zone.ts";
import { resolveTaskGateCmd } from "./task-gate.ts";

// ---------------------------------------------------------------------------
// Deps (injectable — contract: pure runRailCli, testable without fs/process)
// ---------------------------------------------------------------------------

export interface RailCliDeps {
  loadPolicy(cwd?: string): { policy: Policy; warnings: string[] };
  makeSeam(cwd?: string): GitSeam;
  cwd: string;
  /** TTY signal, forwarded to `resolveInteractive` (contract wiring pattern). Absent -> fail-closed (`false`). */
  isTTY?: boolean;
  /**
   * T8 H2/H3: active worker-zone source for the commit rail. Absent -> the
   * real fs loader over `<cwd>/.workflow/active-zone.json` (production and
   * any caller that does not inject one — never silently skipped).
   */
  loadZone?(cwd: string): ActiveZoneLoad;
}

export interface RailCliOutput {
  stdout: string;
  exitCode: number;
}

const USAGE = "usage: rail <commit|push|merge> [options]";

// ---------------------------------------------------------------------------
// RailResult -> {stdout, exitCode} mapping (contract §Маппинг)
// ---------------------------------------------------------------------------

function railExitCode(result: RailResult): number {
  if (result.ok) return 0;
  return result.status.endsWith("-failed") ? 2 : 1;
}

function formatResult(result: RailResult): string {
  if (result.ok) return result.detail ?? result.status;
  return `${result.status}: ${result.detail ?? ""}`;
}

function toOutput(result: RailResult): RailCliOutput {
  return { stdout: formatResult(result), exitCode: railExitCode(result) };
}

function usageError(message: string): RailCliOutput {
  return { stdout: `${USAGE}\n${message}`, exitCode: 2 };
}

// ---------------------------------------------------------------------------
// argv parsing (small, hand-rolled — no external deps)
// ---------------------------------------------------------------------------

interface FlagSpec {
  /** alias (e.g. "-m", "--message") -> canonical key. */
  value: Record<string, string>;
  bool: Record<string, string>;
}

interface ParsedFlags {
  values: Record<string, string>;
  bools: Set<string>;
  error?: string;
}

function parseFlags(args: string[], spec: FlagSpec): ParsedFlags {
  const values: Record<string, string> = {};
  const bools = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a in spec.bool) {
      bools.add(spec.bool[a] as string);
      continue;
    }
    if (a in spec.value) {
      const v = args[i + 1];
      if (v === undefined) {
        return { values, bools, error: `${a}: требуется значение` };
      }
      values[spec.value[a] as string] = v;
      i++;
      continue;
    }
    return { values, bools, error: `неизвестный аргумент: ${a}` };
  }
  return { values, bools };
}

// ---------------------------------------------------------------------------
// per-subcommand: argv -> rail Options -> RailResult
// ---------------------------------------------------------------------------

function runCommit(
  rest: string[],
  seam: GitSeam,
  policy: ResolvedPolicy,
  cwd: string,
  zoneLoad: ActiveZoneLoad
): RailCliOutput {
  const parsed = parseFlags(rest, {
    value: { "-m": "message", "--message": "message", "--gate": "gate" },
    bool: { "--allow-empty": "allowEmpty" },
  });
  if (parsed.error) return usageError(parsed.error);
  const message = parsed.values.message;
  if (!message) return usageError("commit: -m/--message обязателен");

  // T8 H2 fail-closed: a present-but-broken zone file refuses the commit
  // (nothing staged yet — the rail has not run `git add` at this point).
  if (zoneLoad.kind === "invalid") {
    return toOutput({
      ok: false,
      status: "zone-invalid",
      detail: `${ACTIVE_ZONE_REL} битый — коммит отклонён (fail-closed): ${zoneLoad.reason}`,
    });
  }
  // T8 H3: while a worker zone is active `--gate` is refused outright, not
  // silently ignored — the effective gate is resolved below instead (A5a:
  // task-file `test-cmd` first, `policy.quality_gate.cmd` fallback).
  if (zoneLoad.kind === "zone" && parsed.values.gate !== undefined) {
    return toOutput({
      ok: false,
      status: "gate-override-denied",
      detail:
        `--gate запрещён при активной worker-зоне (${ACTIVE_ZONE_REL}, task=${zoneLoad.task}) — ` +
        "гейт из task-file test-cmd (иначе policy.quality_gate.cmd).",
    });
  }

  // A5a: effective gate resolution. No active zone -> pre-A5a behaviour
  // (`--gate` override, else policy). Active zone -> task-file `test-cmd`
  // (`./task-gate.ts`, reuses A2's strict parser) first, `policy.quality_gate
  // .cmd` fallback if absent; ANY failure to resolve the task-file's own gate
  // contract (missing, unreadable, malformed `zone:` block, or a present-but-
  // blank `test-cmd`) -> `zone-invalid` (fail-closed, no silent fallback —
  // post-security-review lead decision).
  let gateCmd: string | undefined;
  let gateSource: "override" | "task" | "policy" | "none";
  if (zoneLoad.kind === "zone") {
    const taskGate = resolveTaskGateCmd(cwd, zoneLoad.task);
    if (taskGate.kind === "invalid") {
      return toOutput({
        ok: false,
        status: "zone-invalid",
        detail: `.workflow/tasks/${zoneLoad.task}.md битый — коммит отклонён (fail-closed): ${taskGate.reason}`,
      });
    }
    if (taskGate.kind === "cmd") {
      gateCmd = taskGate.cmd;
      gateSource = "task";
    } else {
      gateCmd = undefined;
      gateSource = policy.quality_gate.cmd ? "policy" : "none";
    }
  } else {
    gateCmd = parsed.values.gate;
    gateSource = parsed.values.gate ? "override" : policy.quality_gate.cmd ? "policy" : "none";
  }

  const result = gatedCommit({
    git: seam,
    policy,
    message,
    allowEmpty: parsed.bools.has("allowEmpty"),
    gateCmd,
    actor: "operator",
    repoRoot: cwd,
    workerZone: zoneLoad.kind === "zone" ? zoneLoad.zone : undefined,
    workerZoneTask: zoneLoad.kind === "zone" ? zoneLoad.task : undefined,
  });

  // Security review: the reported source must reflect what ACTUALLY ran, not
  // merely what was resolved. `gatedCommit` (`./commit.ts`) itself falls back
  // to `policy.quality_gate.cmd` when `gateCmd` is undefined (`gateSource ===
  // "policy"` deliberately leaves the local `gateCmd` undefined and relies on
  // that same fallback) — mirror that resolution here so "did it run" is
  // judged against the cmd `commit.ts` ACTUALLY used, not this function's
  // local variable. It only runs when `policy.quality_gate.enabled` AND that
  // cmd resolves, AND only after staging/zone-check already passed — a
  // resolved cmd that never reached that step (disabled concern, or an
  // earlier zone-violation/guard failure) must never be reported as
  // `task`/`policy`/`override`.
  const effectiveGateCmd = gateCmd ?? policy.quality_gate.cmd ?? undefined;
  const gateReachedStatuses = new Set(["committed", "gate-red", "commit-failed"]);
  const gateRan =
    policy.quality_gate.enabled && effectiveGateCmd !== undefined && gateReachedStatuses.has(result.status);
  const gateLabel = gateRan
    ? gateSource
    : !policy.quality_gate.enabled
      ? "none (disabled)"
      : effectiveGateCmd === undefined
        ? "none"
        : "none (not reached)";

  const output = toOutput(result);
  return { ...output, stdout: `${output.stdout}\ngate: ${gateLabel}` };
}

function runPush(rest: string[], seam: GitSeam, policy: ResolvedPolicy): RailCliOutput {
  const parsed = parseFlags(rest, {
    value: {
      "--remote": "remote",
      "--protected": "protected",
      "--base": "base",
      "--title": "title",
      "--body": "body",
    },
    bool: { "--pr": "pr", "--dry-run": "dryRun" },
  });
  if (parsed.error) return usageError(parsed.error);

  const protectedBranches = parsed.values.protected
    ? parsed.values.protected.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    : undefined;

  const pr = parsed.bools.has("pr")
    ? { base: parsed.values.base ?? "main", title: parsed.values.title ?? "", body: parsed.values.body ?? "" }
    : undefined;

  const result = gatedPush({
    git: seam,
    policy,
    remote: parsed.values.remote,
    protectedBranches,
    dryRun: parsed.bools.has("dryRun"),
    pr,
  });
  return toOutput(result);
}

function runMerge(rest: string[], seam: GitSeam, policy: ResolvedPolicy): RailCliOutput {
  const parsed = parseFlags(rest, {
    value: {
      "--branch": "branch",
      "--base": "base",
      "--class": "class",
      "--findings": "findings",
      "--gate": "gate",
    },
    bool: { "--allow-risky": "allowRisky", "--dry-run": "dryRun" },
  });
  if (parsed.error) return usageError(parsed.error);
  const branch = parsed.values.branch;
  if (!branch) return usageError("merge: --branch обязателен");

  const result = gatedMerge({
    git: seam,
    policy,
    branch,
    base: parsed.values.base,
    klass: parsed.values.class,
    findingsPath: parsed.values.findings,
    gateCmd: parsed.values.gate,
    allowRisky: parsed.bools.has("allowRisky"),
    dryRun: parsed.bools.has("dryRun"),
  });
  return toOutput(result);
}

// ---------------------------------------------------------------------------
// runRailCli (pure core, contract L-4)
// ---------------------------------------------------------------------------

export function runRailCli(argv: string[], deps: RailCliDeps): RailCliOutput {
  const sub = argv[0];
  const rest = argv.slice(1);

  if (sub !== "commit" && sub !== "push" && sub !== "merge") {
    return usageError(`неизвестная subcommand: ${sub ?? "(нет)"}`);
  }

  const { policy } = deps.loadPolicy(deps.cwd);
  const interactive = resolveInteractive({ isTTY: deps.isTTY });
  const { resolved } = buildPolicy({ policy, interactive });
  const seam = deps.makeSeam(deps.cwd);

  if (sub === "commit") {
    const zoneLoad = (deps.loadZone ?? loadActiveZoneForCommit)(deps.cwd);
    return runCommit(rest, seam, resolved, deps.cwd, zoneLoad);
  }
  if (sub === "push") return runPush(rest, seam, resolved);
  return runMerge(rest, seam, resolved);
}

// ---------------------------------------------------------------------------
// main — thin I/O shell (NOT unit-tested, contract: тонкая оболочка)
// ---------------------------------------------------------------------------

function prodDeps(): RailCliDeps {
  return {
    loadPolicy: (cwd) => loadPolicyFile((cwd || ".") + "/policy.yml"),
    makeSeam: (cwd) => nodeGitSeam(cwd),
    cwd: process.cwd(),
    isTTY: process.stdout.isTTY === true,
  };
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const { stdout, exitCode } = runRailCli(argv, prodDeps());
  if (stdout) process.stdout.write(stdout + "\n");
  process.exit(exitCode);
}

// Direct-run guard (`node core/src/rails/cli.ts commit -m ...`) — inert under
// `node --test` / plain `import` (same pattern as `command-hook.ts`: test
// files import the named exports above, they never execute this module as
// the process entry point).
if (process.argv[1]) {
  let isDirectRun = false;
  try {
    isDirectRun = fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    isDirectRun = false;
  }
  if (isDirectRun) {
    main();
  }
}
