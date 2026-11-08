/**
 * gatedMerge (T4) — TS port of `tools/gated_merge.py`, re-modeled under the
 * rail-reach concern (contract §Rail-концерн семантика) instead of the
 * Python original's always-on behaviour. L-2: port the CAPABILITY-PROBE
 * algorithm verbatim, only the outer reach-gate is new.
 *
 * Ported behaviour (contract §Что портируется):
 *  1. git-repo check.
 *  2. base auto-detect (`main`/`master`) unless given explicitly.
 *  3. both branches exist.
 *  4. CLASS-GATE: RISKY (`security`/`migration`) refused without `allowRisky`.
 *  5. CAPABILITY-PROBE (all required capabilities must be present, else
 *     `insufficient` — autonomy capped, no silent blind-merge):
 *       - green-gate:   a gate cmd resolves (`policy.quality_gate` concern,
 *         or an explicit override — same enabled+cmd rule as the commit-rail).
 *       - clean-rebase: `git merge-tree --write-tree base branch` exit 0.
 *       - forced-critic (class feature/refactor): findings file exists and
 *         has no `[blocker]`-prefixed line (case-insensitive).
 *       - rollback (class migration): always available (pre-ref + reset).
 *  6. working tree clean -> checkout base -> `merge --no-ff --no-edit` ->
 *     amend the merge-commit message to append a `[omp-rail:merge]` trailer
 *     (contract L-1, T7-6; unless already signed) -> fresh quality-gate on
 *     the merge RESULT -> red -> `reset --hard base_ref` + checkout back +
 *     fail; green -> keep the merge.
 * `dryRun` stops right after a passing probe (contract: "не мутировать").
 */
import { existsSync, readFileSync } from "node:fs";
import { RAIL_REACH } from "../classify/git.ts";
import type { ResolvedPolicy } from "../policy/policy.ts";
import { GATE_SHELL_MISSING, railTrailerArgs, tailOutput, type GitSeam, type RailResult } from "./git-seam.ts";

export type { RailResult };

const RISKY = new Set(["security", "migration"]);

export interface GatedMergeOptions {
  git: GitSeam;
  policy: ResolvedPolicy;
  branch: string;
  /** Base branch — auto-detected (`main`/`master`) when omitted. */
  base?: string;
  /** Task class: `feature|refactor|trivial|security|migration` (default `"feature"`). */
  klass?: string;
  /** critic findings-file path (forced-critic for feature/refactor). */
  findingsPath?: string;
  /** Override for the quality-gate command. */
  gateCmd?: string;
  /** Explicitly allow L3 for RISKY classes (security/migration). */
  allowRisky?: boolean;
  dryRun?: boolean;
}

function criticOk(findingsPath: string | undefined): { ok: boolean; detail: string } {
  if (!findingsPath || !existsSync(findingsPath)) {
    return { ok: false, detail: "нет critic-evidence (findings-файла)" };
  }
  const content = readFileSync(findingsPath, "utf-8");
  const blockers = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.toLowerCase().startsWith("[blocker]"));
  if (blockers.length > 0) {
    return { ok: false, detail: `critic нашёл ${blockers.length} blocker(ов)` };
  }
  return { ok: true, detail: "critic clean (0 blocker)" };
}

export function gatedMerge(options: GatedMergeOptions): RailResult {
  const { git, policy } = options;
  const klass = (options.klass ?? "feature").toLowerCase();

  if (policy.rail.level === "none") {
    return { ok: false, status: "rail-disabled", detail: "rail.level=none — рельсы выключены (raw git — разрешённый путь)." };
  }
  if (!RAIL_REACH[policy.rail.level].includes("merge")) {
    return {
      ok: false,
      status: "beyond-reach",
      detail: `gatedMerge требует reach>=merge, rail.level=${policy.rail.level} не покрывает merge.`,
    };
  }

  if (git.run(["git", "rev-parse", "--git-dir"]).code !== 0) {
    return { ok: false, status: "guard-fail", detail: "не git-репо" };
  }

  let base = options.base;
  if (!base) {
    for (const candidate of ["main", "master"]) {
      if (git.run(["git", "rev-parse", "--verify", candidate]).code === 0) {
        base = candidate;
        break;
      }
    }
  }
  if (!base) {
    return { ok: false, status: "guard-fail", detail: "не найдена base-ветка (main/master); задай base явно" };
  }

  for (const ref of [base, options.branch]) {
    if (git.run(["git", "rev-parse", "--verify", ref]).code !== 0) {
      return { ok: false, status: "guard-fail", detail: `ветка не найдена: ${ref}` };
    }
  }

  if (RISKY.has(klass) && !options.allowRisky) {
    return { ok: false, status: "class-blocked", detail: `класс '${klass}' — L3 запрещён по умолчанию (нужен allowRisky)` };
  }

  // --- CAPABILITY-PROBE ---
  const caps: string[] = [];
  const insufficient: string[] = [];

  const gateCmd = options.gateCmd ?? policy.quality_gate.cmd ?? undefined;
  const gateResolved = policy.quality_gate.enabled && !!gateCmd;
  if (gateResolved) {
    caps.push("green-gate");
  } else {
    insufficient.push("green-gate: нет gate-команды (quality_gate concern off, либо cmd не задан)");
  }

  const mergeTree = git.run(["git", "merge-tree", "--write-tree", base, options.branch]);
  if (mergeTree.code === 0) {
    caps.push("clean-rebase");
  } else if (mergeTree.code === 1) {
    insufficient.push("clean-rebase: конфликты base<-branch (не чистый rebase)");
  } else {
    insufficient.push(`clean-rebase: merge-tree недоступен (rc=${mergeTree.code}) — probe не может доказать`);
  }

  if (klass === "feature" || klass === "refactor") {
    const critic = criticOk(options.findingsPath);
    if (critic.ok) {
      caps.push(`forced-critic (${critic.detail})`);
    } else {
      insufficient.push(`forced-critic: ${critic.detail}`);
    }
  }

  if (klass === "migration") {
    caps.push("rollback (git reset --hard pre-ref)");
  }

  if (insufficient.length > 0) {
    return { ok: false, status: "insufficient", detail: insufficient.join("; ") };
  }

  if (git.run(["git", "status", "--porcelain"]).stdout.trim()) {
    return { ok: false, status: "guard-fail", detail: "рабочее дерево грязное — очисти перед L3-merge" };
  }

  const preRef = git.run(["git", "rev-parse", "HEAD"]).stdout.trim();
  const cur = git.run(["git", "rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();

  if (options.dryRun) {
    return {
      ok: true,
      status: "dry-run",
      detail: `probe PASS для class=${klass} (caps: ${caps.join(", ")}) — pre-ref ${preRef.slice(0, 8)}`,
    };
  }

  if (git.run(["git", "checkout", base]).code !== 0) {
    return { ok: false, status: "guard-fail", detail: "checkout base не удался" };
  }
  const baseRef = git.run(["git", "rev-parse", "HEAD"]).stdout.trim();

  const merge = git.run(["git", "merge", "--no-ff", "--no-edit", options.branch]);
  if (merge.code !== 0) {
    git.run(["git", "merge", "--abort"]);
    git.run(["git", "checkout", cur]);
    return { ok: false, status: "guard-fail", detail: "MERGE конфликт (probe разошёлся с реальностью) -> abort" };
  }

  // Rail-signature trailer (contract L-1) — `--no-edit` keeps git's default
  // merge message; amend it to append `[omp-rail:merge]`, unless it already
  // carries a `[omp-rail:` trailer. Amending BEFORE the post-merge gate is
  // safe: on rollback the whole ref is `reset --hard`-ed away regardless.
  const mergeMsg = git.run(["git", "log", "-1", "--pretty=%B"]).stdout.replace(/\s+$/, "");
  const trailer = railTrailerArgs(mergeMsg, "merge");
  if (trailer.length > 0) {
    git.run(["git", "commit", "--amend", "-m", mergeMsg, ...trailer]);
  }

  if (gateResolved && gateCmd) {
    const gate = git.runShell(gateCmd);
    if (gate.code !== 0) {
      git.run(["git", "reset", "--hard", baseRef]);
      git.run(["git", "checkout", cur]);
      const shellMissing = gate.stderr.startsWith(GATE_SHELL_MISSING);
      return {
        ok: false,
        status: shellMissing ? GATE_SHELL_MISSING : "rolled-back",
        detail: `gate red (exit ${gate.code}) на merge-результате — reset к ${baseRef.slice(0, 8)}: ${tailOutput(gate.stderr || gate.stdout)}`,
      };
    }
  }

  const merged = git.run(["git", "rev-parse", "HEAD"]).stdout.trim();
  return {
    ok: true,
    status: "merged",
    detail: `${options.branch} -> ${base} (${merged.slice(0, 8)}), pre-ref был ${preRef.slice(0, 8)}`,
  };
}
