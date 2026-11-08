import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { nodeGitSeam, type GitSeam } from "../src/rails/git-seam.ts";
import { runRailCli, type RailCliDeps } from "../src/rails/cli.ts";
import type { Policy } from "../src/policy/policy.ts";

// ---------------------------------------------------------------------------
// Fixtures — real temp git repos (same pattern as rails.test.ts: prefer a
// real git tmp-repo over a mock). Every test creates its own repo/dirs and
// cleans up in a `finally`.
// ---------------------------------------------------------------------------

function mkRepoDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** Init a repo on branch `main` with one commit (`README.md`). */
function initRepo(): { dir: string; git: GitSeam } {
  const dir = mkRepoDir("rails-cli-repo-");
  const git = nodeGitSeam(dir);
  assert.equal(git.run(["git", "init", "-q", "-b", "main"]).code, 0);
  git.run(["git", "config", "user.email", "test@example.com"]);
  git.run(["git", "config", "user.name", "Rails CLI Test"]);
  writeFileSync(path.join(dir, "README.md"), "init\n");
  git.run(["git", "add", "-A"]);
  assert.equal(git.run(["git", "commit", "-q", "-m", "init"]).code, 0);
  return { dir, git };
}

function initBareRemote(): string {
  const dir = mkRepoDir("rails-cli-bare-");
  const git = nodeGitSeam(dir);
  assert.equal(git.run(["git", "init", "-q", "--bare"]).code, 0);
  return dir;
}

function cleanup(...dirs: string[]): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

function writeFindings(content: string): { path: string; dir: string } {
  const findingsDir = mkRepoDir("rails-cli-findings-");
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

/** Injectable RailCliDeps — `loadPolicy` stubbed with a fixed `Policy`, `makeSeam` bound to the tmp-repo. */
function makeDeps(dir: string, policy: Policy): RailCliDeps {
  return {
    loadPolicy: () => ({ policy, warnings: [] }),
    makeSeam: (cwd) => nodeGitSeam(cwd),
    cwd: dir,
    isTTY: false,
  };
}

// ---------------------------------------------------------------------------
// subcommand routing / usage errors
// ---------------------------------------------------------------------------

test("runRailCli: unknown subcommand -> exit 2", () => {
  const { dir } = initRepo();
  try {
    const result = runRailCli(["frobnicate"], makeDeps(dir, {}));
    assert.equal(result.exitCode, 2);
    assert.match(result.stdout, /usage/);
  } finally {
    cleanup(dir);
  }
});

test("runRailCli: no subcommand -> exit 2", () => {
  const { dir } = initRepo();
  try {
    const result = runRailCli([], makeDeps(dir, {}));
    assert.equal(result.exitCode, 2);
  } finally {
    cleanup(dir);
  }
});

test("runRailCli commit: missing -m/--message -> exit 2", () => {
  const { dir } = initRepo();
  try {
    const policy: Policy = { profile: "autonomous" };
    const result = runRailCli(["commit"], makeDeps(dir, policy));
    assert.equal(result.exitCode, 2);
  } finally {
    cleanup(dir);
  }
});

test("runRailCli merge: missing --branch -> exit 2", () => {
  const { dir } = initRepo();
  try {
    const policy: Policy = { profile: "autonomous" };
    const result = runRailCli(["merge"], makeDeps(dir, policy));
    assert.equal(result.exitCode, 2);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// commit
// ---------------------------------------------------------------------------

test("runRailCli commit: green gate -> exit 0, committed", () => {
  const { dir, git } = initRepo();
  try {
    writeFileSync(path.join(dir, "a.txt"), "hi\n");
    const policy: Policy = { profile: "autonomous", quality_gate: { cmd: "exit 0" } };
    const result = runRailCli(["commit", "-m", "add a"], makeDeps(dir, policy));
    assert.equal(result.exitCode, 0);
    const log = git.run(["git", "log", "--oneline", "-1"]).stdout;
    assert.match(log, /add a/);
  } finally {
    cleanup(dir);
  }
});

test("runRailCli commit: gate-red -> exit 1, no commit, working tree intact", () => {
  const { dir, git } = initRepo();
  try {
    writeFileSync(path.join(dir, "b.txt"), "x\n");
    const before = git.run(["git", "rev-parse", "HEAD"]).stdout.trim();
    const policy: Policy = { profile: "autonomous", quality_gate: { cmd: "exit 1" } };
    const result = runRailCli(["commit", "-m", "add b"], makeDeps(dir, policy));
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /gate-red/);
    assert.equal(git.run(["git", "rev-parse", "HEAD"]).stdout.trim(), before);
    assert.equal(existsSync(path.join(dir, "b.txt")), true);
  } finally {
    cleanup(dir);
  }
});

test("runRailCli commit: zone-violation (operator_zone protected) -> exit 1, no commit", () => {
  const { dir, git } = initRepo();
  try {
    writeFileSync(path.join(dir, "secret.txt"), "x\n");
    const before = git.run(["git", "rev-parse", "HEAD"]).stdout.trim();
    const policy: Policy = {
      profile: "autonomous",
      quality_gate: { cmd: "exit 0" },
      operator_zone: { enabled: true, protected: ["secret.txt"] },
    };
    const result = runRailCli(["commit", "-m", "add secret"], makeDeps(dir, policy));
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /zone-violation/);
    assert.equal(git.run(["git", "rev-parse", "HEAD"]).stdout.trim(), before);
  } finally {
    cleanup(dir);
  }
});

test("runRailCli commit: rail.level=none (profile off) -> exit 1, rail-disabled", () => {
  const { dir } = initRepo();
  try {
    const policy: Policy = { profile: "off" };
    const result = runRailCli(["commit", "-m", "x"], makeDeps(dir, policy));
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /rail-disabled/);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// push
// ---------------------------------------------------------------------------

test("runRailCli push: reach-guard — guarded profile (rail=commit) does not reach push -> exit 1", () => {
  const { dir } = initRepo();
  try {
    const policy: Policy = { profile: "guarded" };
    const result = runRailCli(["push"], makeDeps(dir, policy));
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /beyond-reach/);
  } finally {
    cleanup(dir);
  }
});

test("runRailCli push: protected branch (main) -> exit 1, guard-fail", () => {
  const { dir, git } = initRepo();
  const bare = initBareRemote();
  try {
    git.run(["git", "remote", "add", "origin", bare]);
    const policy: Policy = { profile: "autonomous" };
    const result = runRailCli(["push"], makeDeps(dir, policy));
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /guard-fail/);
  } finally {
    cleanup(dir, bare);
  }
});

test("runRailCli push: --dry-run on feature branch + bare remote -> exit 0, dry-run", () => {
  const { dir, git } = initRepo();
  const bare = initBareRemote();
  try {
    git.run(["git", "checkout", "-q", "-b", "feature"]);
    git.run(["git", "remote", "add", "origin", bare]);
    const policy: Policy = { profile: "autonomous" };
    const result = runRailCli(["push", "--dry-run"], makeDeps(dir, policy));
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /feature/);
  } finally {
    cleanup(dir, bare);
  }
});

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

test("runRailCli merge: reach-guard — guarded profile (rail=commit) does not reach merge -> exit 1", () => {
  const { dir, git } = initRepo();
  try {
    makeFeatureBranch(dir, git, "feat.txt");
    const policy: Policy = { profile: "guarded" };
    const result = runRailCli(["merge", "--branch", "feature", "--base", "main"], makeDeps(dir, policy));
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /beyond-reach/);
  } finally {
    cleanup(dir);
  }
});

test("runRailCli merge: RISKY class without --allow-risky -> exit 1, class-blocked", () => {
  const { dir, git } = initRepo();
  try {
    makeFeatureBranch(dir, git, "risky.txt");
    const policy: Policy = { profile: "autonomous", quality_gate: { cmd: "exit 0" } };
    const result = runRailCli(
      ["merge", "--branch", "feature", "--base", "main", "--class", "security"],
      makeDeps(dir, policy)
    );
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /class-blocked/);
  } finally {
    cleanup(dir);
  }
});

test("runRailCli merge: clean feature + findings-clean --dry-run -> exit 0, no mutation", () => {
  const { dir, git } = initRepo();
  const findings = writeFindings("no issues found\n");
  try {
    makeFeatureBranch(dir, git, "feat2.txt");
    const before = git.run(["git", "rev-parse", "HEAD"]).stdout.trim();
    const policy: Policy = { profile: "autonomous", quality_gate: { cmd: "exit 0" } };
    const result = runRailCli(
      [
        "merge",
        "--branch",
        "feature",
        "--base",
        "main",
        "--class",
        "feature",
        "--findings",
        findings.path,
        "--dry-run",
      ],
      makeDeps(dir, policy)
    );
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /probe PASS/);
    assert.equal(git.run(["git", "rev-parse", "HEAD"]).stdout.trim(), before);
  } finally {
    cleanup(dir, findings.dir);
  }
});

test("runRailCli merge: real merge on green gate -> exit 0, merged onto base", () => {
  const { dir, git } = initRepo();
  const findings = writeFindings("clean\n");
  try {
    makeFeatureBranch(dir, git, "feat3.txt");
    const policy: Policy = { profile: "autonomous", quality_gate: { cmd: "exit 0" } };
    const result = runRailCli(
      ["merge", "--branch", "feature", "--base", "main", "--class", "feature", "--findings", findings.path],
      makeDeps(dir, policy)
    );
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /feature -> main/);
    assert.equal(existsSync(path.join(dir, "feat3.txt")), true);
  } finally {
    cleanup(dir, findings.dir);
  }
});
