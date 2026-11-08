/**
 * gatedPush (T4) — TS port of `tools/gated_push.py`, re-modeled under the
 * rail-reach concern (contract §Rail-концерн семантика) instead of the
 * Python original's always-on behaviour.
 *
 * Ported behaviour (contract §Что портируется, L-2):
 *  1. git-repo check.
 *  2. remote exists.
 *  3. branch NOT protected (default `["main", "master"]`, overridable).
 *  4. not detached HEAD.
 *  5. working tree clean (dirty = ungated content that never passed the
 *     commit-rail -> refuse).
 *  6. commits ahead of upstream (or branch has no upstream yet at all) ->
 *     `git push -u remote branch`.
 * Optional PR step via `gh` (contract: `seam.run(["gh", ...])` — same
 * `GitSeam.run`, argv[0] is simply a different binary; marked external, not
 * exercised by the default test-path). `--dry-run` equivalent via `dryRun`.
 */
import { RAIL_REACH } from "../classify/git.ts";
import type { ResolvedPolicy } from "../policy/policy.ts";
import type { GitSeam, RailResult } from "./git-seam.ts";

export type { RailResult };

export interface GatedPushPrOptions {
  base?: string;
  title?: string;
  body?: string;
}

export interface GatedPushOptions {
  git: GitSeam;
  policy: ResolvedPolicy;
  remote?: string;
  /** Protected branches — autonomous push forbidden (default `["main", "master"]`). */
  protectedBranches?: string[];
  dryRun?: boolean;
  /** Open a PR via `gh` after a successful push. */
  pr?: GatedPushPrOptions;
}

export function gatedPush(options: GatedPushOptions): RailResult {
  const { git, policy } = options;
  const remote = options.remote ?? "origin";
  const protectedBranches = options.protectedBranches ?? ["main", "master"];

  if (policy.rail.level === "none") {
    return { ok: false, status: "rail-disabled", detail: "rail.level=none — рельсы выключены (raw git — разрешённый путь)." };
  }
  if (!RAIL_REACH[policy.rail.level].includes("push")) {
    return {
      ok: false,
      status: "beyond-reach",
      detail: `gatedPush требует reach>=push, rail.level=${policy.rail.level} не покрывает push.`,
    };
  }

  if (git.run(["git", "rev-parse", "--git-dir"]).code !== 0) {
    return { ok: false, status: "guard-fail", detail: "не git-репо" };
  }

  const remotes = git.run(["git", "remote"]).stdout.split(/\s+/).filter(Boolean);
  if (!remotes.includes(remote)) {
    return { ok: false, status: "guard-fail", detail: `remote '${remote}' не настроен (remotes: ${remotes.join(", ") || "нет"})` };
  }

  const branch = git.run(["git", "rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  if (protectedBranches.includes(branch)) {
    return { ok: false, status: "guard-fail", detail: `ветка '${branch}' protected — автономный push запрещён` };
  }
  if (branch === "HEAD" || branch === "") {
    return { ok: false, status: "guard-fail", detail: "detached HEAD — нет ветки для push" };
  }

  const porcelain = git.run(["git", "status", "--porcelain"]).stdout.trim();
  if (porcelain) {
    return { ok: false, status: "guard-fail", detail: "рабочее дерево грязное (ungated-изменения не прошли commit-рельс)" };
  }

  const upstream = git.run(["git", "rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
  let aheadDetail: string;
  if (upstream.code === 0) {
    const upstreamName = upstream.stdout.trim();
    const ahead = git.run(["git", "rev-list", "--count", `${upstreamName}..HEAD`]).stdout.trim();
    if (ahead === "0") {
      return { ok: false, status: "guard-fail", detail: `нет коммитов вперёд ${upstreamName} — нечего пушить` };
    }
    aheadDetail = `${branch} +${ahead} -> ${remote}`;
  } else {
    aheadDetail = `новая ветка ${branch} -> ${remote} (upstream ещё нет)`;
  }

  if (options.dryRun) {
    return { ok: true, status: "dry-run", detail: aheadDetail };
  }

  const push = git.run(["git", "push", "-u", remote, branch]);
  if (push.code !== 0) {
    return { ok: false, status: "push-failed", detail: push.stderr };
  }

  if (options.pr) {
    const base = options.pr.base ?? "main";
    const title = options.pr.title || `${branch}: automated change (L2, human approves merge)`;
    const body = options.pr.body || "";
    const pr = git.run(["gh", "pr", "create", "--base", base, "--head", branch, "--title", title, "--body", body]);
    if (pr.code !== 0) {
      return { ok: true, status: "pushed", detail: `PUSHED; PR create failed: ${pr.stderr}` };
    }
    return { ok: true, status: "pushed", detail: `PUSHED + PR opened: ${pr.stdout}` };
  }

  return { ok: true, status: "pushed", detail: aheadDetail };
}
