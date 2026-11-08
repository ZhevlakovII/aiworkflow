import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { nodeGitSeam, resolveShPath, GATE_SHELL_MISSING, type GitSeam } from "../src/rails/git-seam.ts";
import { gatedCommit } from "../src/rails/commit.ts";
import { gatedPush } from "../src/rails/push.ts";
import { gatedMerge } from "../src/rails/merge.ts";
import type { ResolvedPolicy } from "../src/policy/policy.ts";
import type { RailLevel } from "../src/policy/profile.ts";

// ---------------------------------------------------------------------------
// Fixtures — real temp git repos (contract §git-seam: "предпочтительно
// реальный git на tmp-репо, не мок"). Every test creates its own repo and
// cleans it up in a `finally` (contract L-3, cleanup обязателен).
// ---------------------------------------------------------------------------

function makePolicy(
  overrides: Partial<{
    rail: RailLevel;
    qualityGateEnabled: boolean;
    qualityGateCmd: string | null;
  }> = {}
): ResolvedPolicy {
  return {
    profile: "guarded",
    quality_gate: {
      enabled: overrides.qualityGateEnabled ?? true,
      cmd: overrides.qualityGateCmd ?? null,
    },
    operator_zone: { enabled: false, protected: [] },
    rail: { level: overrides.rail ?? "commit", merge_needs_human: true },
    security_floor: { enabled: true },
  };
}

function mkRepoDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** Init a repo on branch `main` with one commit (`README.md`). */
function initRepo(): { dir: string; git: GitSeam } {
  const dir = mkRepoDir("rails-t4-repo-");
  const git = nodeGitSeam(dir);
  assert.equal(git.run(["git", "init", "-q", "-b", "main"]).code, 0);
  git.run(["git", "config", "user.email", "test@example.com"]);
  git.run(["git", "config", "user.name", "Rails Test"]);
  writeFileSync(path.join(dir, "README.md"), "init\n");
  git.run(["git", "add", "-A"]);
  assert.equal(git.run(["git", "commit", "-q", "-m", "init"]).code, 0);
  return { dir, git };
}

function initBareRemote(): string {
  const dir = mkRepoDir("rails-t4-bare-");
  const git = nodeGitSeam(dir);
  assert.equal(git.run(["git", "init", "-q", "--bare"]).code, 0);
  return dir;
}

function cleanup(...dirs: string[]): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// gatedCommit
// ---------------------------------------------------------------------------

test("gatedCommit: green gate -> committed", () => {
  const { dir, git } = initRepo();
  try {
    writeFileSync(path.join(dir, "a.txt"), "hi\n");
    const policy = makePolicy({ rail: "commit", qualityGateEnabled: true, qualityGateCmd: "exit 0" });
    const result = gatedCommit({ git, policy, message: "add a", actor: "operator" });
    assert.equal(result.ok, true);
    assert.equal(result.status, "committed");
    const log = git.run(["git", "log", "--oneline", "-1"]).stdout;
    assert.match(log, /add a/);
    assert.equal(git.run(["git", "status", "--porcelain"]).stdout.trim(), "");
  } finally {
    cleanup(dir);
  }
});

test("gatedCommit: gate-red -> reset (unstage), working tree intact, no commit", () => {
  const { dir, git } = initRepo();
  try {
    writeFileSync(path.join(dir, "b.txt"), "x\n");
    const before = git.run(["git", "rev-parse", "HEAD"]).stdout.trim();
    const policy = makePolicy({ rail: "commit", qualityGateEnabled: true, qualityGateCmd: "exit 1" });
    const result = gatedCommit({ git, policy, message: "add b", actor: "operator" });
    assert.equal(result.ok, false);
    assert.equal(result.status, "gate-red");
    assert.equal(git.run(["git", "rev-parse", "HEAD"]).stdout.trim(), before, "no commit happened");
    assert.equal(existsSync(path.join(dir, "b.txt")), true, "working tree file survives");
    const status = git.run(["git", "status", "--porcelain"]).stdout;
    assert.match(status, /\?\? b\.txt/, "unstaged back to untracked (reset -q)");
  } finally {
    cleanup(dir);
  }
});

test("gatedCommit: gate cmd is a POSIX-path script, run via sh -c on every OS; exit!=0 -> gate-red, cyrillic output readable", () => {
  const { dir, git } = initRepo();
  try {
    writeFileSync(path.join(dir, "gate.sh"), "#!/bin/sh\nprintf 'ошибка\\n' 1>&2\nexit 3\n");
    writeFileSync(path.join(dir, "e.txt"), "x\n");
    const policy = makePolicy({ rail: "commit", qualityGateEnabled: true, qualityGateCmd: "./gate.sh" });
    const result = gatedCommit({ git, policy, message: "add e", actor: "operator" });
    assert.equal(result.ok, false);
    assert.equal(result.status, "gate-red");
    assert.match(result.detail ?? "", /exit 3/);
    assert.match(result.detail ?? "", /ошибка/, "cyrillic gate output must be readable, not mojibake");
  } finally {
    cleanup(dir);
  }
});

test("nodeGitSeam.runShell: sh not resolvable (empty PATH) -> gate-shell-missing, no silent cmd.exe fallback", () => {
  const savedPath = process.env.PATH;
  const emptyPathDir = mkRepoDir("rails-t4-empty-path-");
  try {
    process.env.PATH = emptyPathDir;
    assert.equal(resolveShPath(), null, "no sh, no git -> nothing to resolve");
    const res = nodeGitSeam().runShell("exit 0");
    assert.equal(res.code, 127);
    assert.match(res.stderr, new RegExp(`^${GATE_SHELL_MISSING}:`));
  } finally {
    process.env.PATH = savedPath;
    cleanup(emptyPathDir);
  }
});

test("gatedCommit: runShell reports gate-shell-missing -> surfaced as its own status, not folded into gate-red", () => {
  const { dir, git } = initRepo();
  try {
    writeFileSync(path.join(dir, "g.txt"), "x\n");
    const seam: GitSeam = {
      run: (args) => git.run(args),
      runShell: () => ({ code: 127, stdout: "", stderr: `${GATE_SHELL_MISSING}: sh не найден` }),
    };
    const policy = makePolicy({ rail: "commit", qualityGateEnabled: true, qualityGateCmd: "exit 0" });
    const result = gatedCommit({ git: seam, policy, message: "add g", actor: "operator" });
    assert.equal(result.ok, false);
    assert.equal(result.status, GATE_SHELL_MISSING);
  } finally {
    cleanup(dir);
  }
});

test("gatedCommit: zone-violation (worker outside allow-lane) -> reset + fail, no commit", () => {
  const { dir, git } = initRepo();
  try {
    writeFileSync(path.join(dir, "secret.txt"), "x\n");
    const before = git.run(["git", "rev-parse", "HEAD"]).stdout.trim();
    const policy = makePolicy({ rail: "commit" });
    const result = gatedCommit({
      git,
      policy,
      message: "add secret",
      actor: "worker",
      zone: { allow: ["docs/**"] },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, "zone-violation");
    assert.match(result.detail ?? "", /secret\.txt/);
    assert.equal(git.run(["git", "rev-parse", "HEAD"]).stdout.trim(), before);
    assert.match(git.run(["git", "status", "--porcelain"]).stdout, /\?\? secret\.txt/);
  } finally {
    cleanup(dir);
  }
});

test("gatedCommit: rail.level=none -> rail-disabled, no git mutation attempted", () => {
  const policy = makePolicy({ rail: "none" });
  const result = gatedCommit({ git: nodeGitSeam(), policy, message: "x", actor: "operator" });
  assert.equal(result.ok, false);
  assert.equal(result.status, "rail-disabled");
});

test("gatedCommit: rail-signature — [omp-rail:commit] trailer appended as its own paragraph", () => {
  const { dir, git } = initRepo();
  try {
    writeFileSync(path.join(dir, "trailer.txt"), "hi\n");
    const policy = makePolicy({ rail: "commit", qualityGateEnabled: true, qualityGateCmd: "exit 0" });
    const result = gatedCommit({ git, policy, message: "add trailer.txt", actor: "operator" });
    assert.equal(result.ok, true);
    const body = git.run(["git", "log", "-1", "--pretty=%B"]).stdout;
    assert.match(body, /^add trailer\.txt\n\n\[omp-rail:commit\]\s*$/);
  } finally {
    cleanup(dir);
  }
});

test("gatedCommit: message already carries a [omp-rail:...] trailer -> not duplicated", () => {
  const { dir, git } = initRepo();
  try {
    writeFileSync(path.join(dir, "nodup.txt"), "hi\n");
    const policy = makePolicy({ rail: "commit", qualityGateEnabled: true, qualityGateCmd: "exit 0" });
    const message = "add nodup.txt\n\n[omp-rail:queue_batch]";
    const result = gatedCommit({ git, policy, message, actor: "operator" });
    assert.equal(result.ok, true);
    const body = git.run(["git", "log", "-1", "--pretty=%B"]).stdout;
    assert.equal((body.match(/\[omp-rail:/g) ?? []).length, 1, "trailer not duplicated");
  } finally {
    cleanup(dir);
  }
});

test("gatedCommit: quality_gate concern OFF -> gate-optional PASS -> committed", () => {
  const { dir, git } = initRepo();
  try {
    writeFileSync(path.join(dir, "c.txt"), "x\n");
    const policy = makePolicy({ rail: "commit", qualityGateEnabled: false, qualityGateCmd: null });
    const result = gatedCommit({ git, policy, message: "add c", actor: "operator" });
    assert.equal(result.ok, true);
    assert.equal(result.status, "committed");
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// gatedPush
// ---------------------------------------------------------------------------

test("gatedPush: protected branch (main) -> guard-fail", () => {
  const { dir, git } = initRepo();
  const bare = initBareRemote();
  try {
    git.run(["git", "remote", "add", "origin", bare]);
    const policy = makePolicy({ rail: "push" });
    const result = gatedPush({ git, policy });
    assert.equal(result.ok, false);
    assert.equal(result.status, "guard-fail");
    assert.match(result.detail ?? "", /protected/);
  } finally {
    cleanup(dir, bare);
  }
});

test("gatedPush: dirty working tree -> guard-fail", () => {
  const { dir, git } = initRepo();
  const bare = initBareRemote();
  try {
    git.run(["git", "checkout", "-q", "-b", "feature"]);
    git.run(["git", "remote", "add", "origin", bare]);
    writeFileSync(path.join(dir, "dirty.txt"), "x\n");
    const policy = makePolicy({ rail: "push" });
    const result = gatedPush({ git, policy });
    assert.equal(result.ok, false);
    assert.equal(result.status, "guard-fail");
    assert.match(result.detail ?? "", /грязн/);
  } finally {
    cleanup(dir, bare);
  }
});

test("gatedPush: clean + new branch -> push to bare remote", () => {
  const { dir, git } = initRepo();
  const bare = initBareRemote();
  try {
    git.run(["git", "checkout", "-q", "-b", "feature"]);
    git.run(["git", "remote", "add", "origin", bare]);
    const policy = makePolicy({ rail: "push" });
    const result = gatedPush({ git, policy });
    assert.equal(result.ok, true);
    assert.equal(result.status, "pushed");
    const lsRemote = git.run(["git", "ls-remote", "origin", "refs/heads/feature"]).stdout;
    assert.match(lsRemote, /feature/);
  } finally {
    cleanup(dir, bare);
  }
});

test("gatedPush: reach-guard — rail.level=commit does not reach push -> beyond-reach", () => {
  const policy = makePolicy({ rail: "commit" });
  const result = gatedPush({ git: nodeGitSeam(), policy });
  assert.equal(result.ok, false);
  assert.equal(result.status, "beyond-reach");
});

// ---------------------------------------------------------------------------
// gatedMerge
// ---------------------------------------------------------------------------

/** Findings file MUST live outside the repo working tree — inside it, it would show up
 *  as an untracked file and trip the merge-rail's own dirty-tree guard. */
function writeFindings(content: string): { path: string; dir: string } {
  const findingsDir = mkRepoDir("rails-t4-findings-");
  const findingsPath = path.join(findingsDir, "findings.md");
  writeFileSync(findingsPath, content);
  return { path: findingsPath, dir: findingsDir };
}

function makeFeatureBranch(dir: string, git: GitSeam, filename: string): void {
  git.run(["git", "checkout", "-q", "-b", "feature"]);
  writeFileSync(path.join(dir, filename), "feature content\n");
  git.run(["git", "add", "-A"]);
  git.run(["git", "commit", "-q", "-m", `add ${filename}`]);
  git.run(["git", "checkout", "-q", "main"]);
}

test("gatedMerge: RISKY class (security) without allowRisky -> class-blocked", () => {
  const { dir, git } = initRepo();
  try {
    makeFeatureBranch(dir, git, "risky.txt");
    const policy = makePolicy({ rail: "merge", qualityGateEnabled: true, qualityGateCmd: "exit 0" });
    const result = gatedMerge({ git, policy, branch: "feature", base: "main", klass: "security" });
    assert.equal(result.ok, false);
    assert.equal(result.status, "class-blocked");
  } finally {
    cleanup(dir);
  }
});

test("gatedMerge: clean feature + findings-clean -> capability-probe PASS (dry-run, no mutation)", () => {
  const { dir, git } = initRepo();
  const findings = writeFindings("no issues found\n");
  try {
    makeFeatureBranch(dir, git, "feat.txt");
    const before = git.run(["git", "rev-parse", "HEAD"]).stdout.trim();
    const policy = makePolicy({ rail: "merge", qualityGateEnabled: true, qualityGateCmd: "exit 0" });
    const result = gatedMerge({
      git,
      policy,
      branch: "feature",
      base: "main",
      klass: "feature",
      findingsPath: findings.path,
      dryRun: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, "dry-run");
    assert.equal(git.run(["git", "rev-parse", "HEAD"]).stdout.trim(), before, "dry-run must not mutate");
  } finally {
    cleanup(dir, findings.dir);
  }
});

test("gatedMerge: insufficient — no gate command resolves -> refuse (autonomy capped)", () => {
  const { dir, git } = initRepo();
  const findings = writeFindings("no issues found\n");
  try {
    makeFeatureBranch(dir, git, "feat2.txt");
    const policy = makePolicy({ rail: "merge", qualityGateEnabled: false, qualityGateCmd: null });
    const result = gatedMerge({
      git,
      policy,
      branch: "feature",
      base: "main",
      klass: "feature",
      findingsPath: findings.path,
      dryRun: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, "insufficient");
    assert.match(result.detail ?? "", /green-gate/);
  } finally {
    cleanup(dir, findings.dir);
  }
});

test("gatedMerge: reach-guard — rail.level=push does not reach merge -> beyond-reach", () => {
  const policy = makePolicy({ rail: "push" });
  const result = gatedMerge({ git: nodeGitSeam(), policy, branch: "feature" });
  assert.equal(result.ok, false);
  assert.equal(result.status, "beyond-reach");
});

test("gatedMerge: rail.level=none -> rail-disabled", () => {
  const policy = makePolicy({ rail: "none" });
  const result = gatedMerge({ git: nodeGitSeam(), policy, branch: "feature" });
  assert.equal(result.ok, false);
  assert.equal(result.status, "rail-disabled");
});

test("gatedMerge: real merge on green gate -> merged, result checked out on base", () => {
  const { dir, git } = initRepo();
  const findings = writeFindings("clean\n");
  try {
    makeFeatureBranch(dir, git, "feat3.txt");
    const policy = makePolicy({ rail: "merge", qualityGateEnabled: true, qualityGateCmd: "exit 0" });
    const result = gatedMerge({
      git,
      policy,
      branch: "feature",
      base: "main",
      klass: "feature",
      findingsPath: findings.path,
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, "merged");
    assert.equal(existsSync(path.join(dir, "feat3.txt")), true);
    assert.equal(git.run(["git", "rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim(), "main");
  } finally {
    cleanup(dir, findings.dir);
  }
});

test("gatedMerge: rail-signature — [omp-rail:merge] trailer appended to the merge commit", () => {
  const { dir, git } = initRepo();
  const findings = writeFindings("clean\n");
  try {
    makeFeatureBranch(dir, git, "feat5.txt");
    const policy = makePolicy({ rail: "merge", qualityGateEnabled: true, qualityGateCmd: "exit 0" });
    const result = gatedMerge({
      git,
      policy,
      branch: "feature",
      base: "main",
      klass: "feature",
      findingsPath: findings.path,
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, "merged");
    const body = git.run(["git", "log", "-1", "--pretty=%B"]).stdout;
    assert.match(body, /\[omp-rail:merge\]/);
    assert.equal((body.match(/\[omp-rail:/g) ?? []).length, 1, "trailer not duplicated");
  } finally {
    cleanup(dir, findings.dir);
  }
});

test("gatedMerge: fresh post-merge gate red -> rolled back to base, tree restored", () => {
  const { dir, git } = initRepo();
  const findings = writeFindings("clean\n");
  try {
    makeFeatureBranch(dir, git, "feat4.txt");
    const baseBefore = git.run(["git", "rev-parse", "HEAD"]).stdout.trim();
    const policy = makePolicy({ rail: "merge", qualityGateEnabled: true, qualityGateCmd: "exit 1" });
    const result = gatedMerge({
      git,
      policy,
      branch: "feature",
      base: "main",
      klass: "feature",
      findingsPath: findings.path,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, "rolled-back");
    assert.equal(git.run(["git", "rev-parse", "HEAD"]).stdout.trim(), baseBefore, "reset --hard base_ref undid the merge");
    assert.equal(existsSync(path.join(dir, "feat4.txt")), false, "merge content rolled back");
    assert.equal(git.run(["git", "rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim(), "main");
  } finally {
    cleanup(dir, findings.dir);
  }
});
