/**
 * A5a (`.workflow/tasks/a5a-cc-execute-rail-gate.md`) — effective quality-gate
 * resolution for the L1 commit rail while a worker zone is active: task-file
 * `test-cmd` first, `policy.quality_gate.cmd` fallback, `zone-invalid` for a
 * task-file that exists but fails to parse. Real temp git repos (same pattern
 * as `t8-commit-zone.test.ts`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { nodeGitSeam, type GitSeam } from "../src/rails/git-seam.ts";
import { runRailCli, type RailCliDeps } from "../src/rails/cli.ts";
import { resolveTaskGateCmd } from "../src/rails/task-gate.ts";
import type { Policy } from "../src/policy/policy.ts";

function initRepo(): { dir: string; git: GitSeam } {
  const dir = mkdtempSync(path.join(tmpdir(), "a5a-task-gate-"));
  const git = nodeGitSeam(dir);
  assert.equal(git.run(["git", "init", "-q", "-b", "main"]).code, 0);
  git.run(["git", "config", "user.email", "test@example.com"]);
  git.run(["git", "config", "user.name", "A5a Test"]);
  writeFileSync(path.join(dir, ".gitignore"), "/.workflow/\n");
  writeFileSync(path.join(dir, "README.md"), "init\n");
  git.run(["git", "add", "-A"]);
  assert.equal(git.run(["git", "commit", "-q", "-m", "init"]).code, 0);
  return { dir, git };
}

function writeZone(dir: string, content: string): void {
  mkdirSync(path.join(dir, ".workflow"), { recursive: true });
  writeFileSync(path.join(dir, ".workflow", "active-zone.json"), content);
}

function writeTaskFile(dir: string, id: string, body: string): void {
  mkdirSync(path.join(dir, ".workflow", "tasks"), { recursive: true });
  writeFileSync(path.join(dir, ".workflow", "tasks", `${id}.md`), body);
}

function deps(dir: string, policy: Policy): RailCliDeps {
  return { loadPolicy: () => ({ policy, warnings: [] }), makeSeam: (cwd) => nodeGitSeam(cwd), cwd: dir, isTTY: false };
}

const AUTONOMOUS_NO_POLICY_CMD: Policy = { profile: "autonomous", quality_gate: {} };

function head(git: GitSeam): string {
  return git.run(["git", "rev-parse", "HEAD"]).stdout.trim();
}

// ---------------------------------------------------------------------------
// resolveTaskGateCmd — unit
// ---------------------------------------------------------------------------

test("resolveTaskGateCmd: task-file with test-cmd -> kind cmd", () => {
  const { dir } = initRepo();
  try {
    writeTaskFile(dir, "t1", `---\nzone:\n  allow: ["a/**"]\ntest-cmd: "exit 0"\n---\nbody\n`);
    const r = resolveTaskGateCmd(dir, "t1");
    assert.deepEqual(r, { kind: "cmd", cmd: "exit 0" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveTaskGateCmd: task-file without test-cmd -> kind none", () => {
  const { dir } = initRepo();
  try {
    writeTaskFile(dir, "t2", `---\nzone:\n  allow: ["a/**"]\n---\nbody\n`);
    const r = resolveTaskGateCmd(dir, "t2");
    assert.deepEqual(r, { kind: "none" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveTaskGateCmd: task-file missing entirely -> kind invalid (fail-closed, lead decision post-review)", () => {
  const { dir } = initRepo();
  try {
    const r = resolveTaskGateCmd(dir, "nope");
    assert.equal(r.kind, "invalid");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveTaskGateCmd: test-cmd is a blank/whitespace-only string -> kind invalid (not a silent no-op green gate)", () => {
  const { dir } = initRepo();
  try {
    writeTaskFile(dir, "t5", `---\nzone:\n  allow: ["a/**"]\ntest-cmd: "   "\n---\nbody\n`);
    const r = resolveTaskGateCmd(dir, "t5");
    assert.equal(r.kind, "invalid");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveTaskGateCmd: test-cmd is an empty string -> kind invalid", () => {
  const { dir } = initRepo();
  try {
    writeTaskFile(dir, "t6", `---\nzone:\n  allow: ["a/**"]\ntest-cmd: ""\n---\nbody\n`);
    const r = resolveTaskGateCmd(dir, "t6");
    assert.equal(r.kind, "invalid");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveTaskGateCmd: test-cmd with incidental surrounding whitespace -> trimmed cmd", () => {
  const { dir } = initRepo();
  try {
    writeTaskFile(dir, "t7", `---\nzone:\n  allow: ["a/**"]\ntest-cmd: "  exit 0  "\n---\nbody\n`);
    const r = resolveTaskGateCmd(dir, "t7");
    assert.deepEqual(r, { kind: "cmd", cmd: "exit 0" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveTaskGateCmd: task-file exists but no zone block -> kind invalid", () => {
  const { dir } = initRepo();
  try {
    writeTaskFile(dir, "t3", `---\nid: t3\n---\nbody\n`);
    const r = resolveTaskGateCmd(dir, "t3");
    assert.equal(r.kind, "invalid");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveTaskGateCmd: task-file exists but zone.allow missing -> kind invalid", () => {
  const { dir } = initRepo();
  try {
    writeTaskFile(dir, "t4", `---\nzone:\n  deny: ["x/**"]\ntest-cmd: "exit 0"\n---\nbody\n`);
    const r = resolveTaskGateCmd(dir, "t4");
    assert.equal(r.kind, "invalid");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// runRailCli commit — end-to-end gate resolution
// ---------------------------------------------------------------------------

test("commit: active zone + task-file test-cmd green -> committed, gate source = task", () => {
  const { dir, git } = initRepo();
  try {
    writeZone(dir, JSON.stringify({ task: "gt-green", allow: ["core/**"] }));
    writeTaskFile(dir, "gt-green", `---\nzone:\n  allow: ["core/**"]\ntest-cmd: "exit 0"\n---\nbody\n`);
    mkdirSync(path.join(dir, "core"));
    writeFileSync(path.join(dir, "core", "a.ts"), "x\n");
    const res = runRailCli(["commit", "-m", "in zone green"], deps(dir, AUTONOMOUS_NO_POLICY_CMD));
    assert.equal(res.exitCode, 0, res.stdout);
    assert.match(res.stdout, /gate: task/);
    assert.match(git.run(["git", "log", "--oneline", "-1"]).stdout, /in zone green/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commit: active zone + task-file test-cmd red -> gate-red, no commit", () => {
  const { dir, git } = initRepo();
  try {
    writeZone(dir, JSON.stringify({ task: "gt-red", allow: ["core/**"] }));
    writeTaskFile(dir, "gt-red", `---\nzone:\n  allow: ["core/**"]\ntest-cmd: "exit 1"\n---\nbody\n`);
    mkdirSync(path.join(dir, "core"));
    writeFileSync(path.join(dir, "core", "a.ts"), "x\n");
    const before = head(git);
    const res = runRailCli(["commit", "-m", "in zone red"], deps(dir, AUTONOMOUS_NO_POLICY_CMD));
    assert.equal(res.exitCode, 1);
    assert.match(res.stdout, /gate-red/);
    assert.equal(head(git), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commit: active zone + task-file without test-cmd -> falls back to policy.quality_gate.cmd", () => {
  const { dir, git } = initRepo();
  try {
    writeZone(dir, JSON.stringify({ task: "gt-notestcmd", allow: ["core/**"] }));
    writeTaskFile(dir, "gt-notestcmd", `---\nzone:\n  allow: ["core/**"]\n---\nbody\n`);
    mkdirSync(path.join(dir, "core"));
    writeFileSync(path.join(dir, "core", "a.ts"), "x\n");
    const before = head(git);
    const res = runRailCli(
      ["commit", "-m", "policy fallback"],
      deps(dir, { profile: "autonomous", quality_gate: { cmd: "exit 1" } })
    );
    assert.equal(res.exitCode, 1);
    assert.match(res.stdout, /gate-red/);
    assert.match(res.stdout, /gate: policy/);
    assert.equal(head(git), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commit: active zone, task-file exists but broken zone block -> zone-invalid, no commit", () => {
  const { dir, git } = initRepo();
  try {
    writeZone(dir, JSON.stringify({ task: "gt-broken", allow: ["core/**"] }));
    writeTaskFile(dir, "gt-broken", `---\nid: gt-broken\n---\nno zone block\n`);
    mkdirSync(path.join(dir, "core"));
    writeFileSync(path.join(dir, "core", "a.ts"), "x\n");
    const before = head(git);
    const res = runRailCli(["commit", "-m", "broken task"], deps(dir, AUTONOMOUS_NO_POLICY_CMD));
    assert.equal(res.exitCode, 1);
    assert.match(res.stdout, /zone-invalid/);
    assert.equal(head(git), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commit: active zone, task-file missing entirely -> zone-invalid, no commit (lead decision post-review)", () => {
  const { dir, git } = initRepo();
  try {
    writeZone(dir, JSON.stringify({ task: "gt-missing", allow: ["core/**"] }));
    mkdirSync(path.join(dir, "core"));
    writeFileSync(path.join(dir, "core", "a.ts"), "x\n");
    const before = head(git);
    const res = runRailCli(["commit", "-m", "no task file"], deps(dir, AUTONOMOUS_NO_POLICY_CMD));
    assert.equal(res.exitCode, 1);
    assert.match(res.stdout, /zone-invalid/);
    assert.equal(head(git), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commit: active zone, task-file with blank test-cmd -> zone-invalid, no commit (not a silent green)", () => {
  const { dir, git } = initRepo();
  try {
    writeZone(dir, JSON.stringify({ task: "gt-blank", allow: ["core/**"] }));
    writeTaskFile(dir, "gt-blank", `---\nzone:\n  allow: ["core/**"]\ntest-cmd: "   "\n---\nbody\n`);
    mkdirSync(path.join(dir, "core"));
    writeFileSync(path.join(dir, "core", "a.ts"), "x\n");
    const before = head(git);
    const res = runRailCli(["commit", "-m", "blank test-cmd"], deps(dir, AUTONOMOUS_NO_POLICY_CMD));
    assert.equal(res.exitCode, 1);
    assert.match(res.stdout, /zone-invalid/);
    assert.equal(head(git), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commit: active zone + task test-cmd resolved, but policy.quality_gate disabled -> gate never runs, source labelled 'none (disabled)'", () => {
  const { dir, git } = initRepo();
  try {
    writeZone(dir, JSON.stringify({ task: "gt-disabled", allow: ["core/**"] }));
    // test-cmd would be red if it ran — proves the gate genuinely never executes.
    writeTaskFile(dir, "gt-disabled", `---\nzone:\n  allow: ["core/**"]\ntest-cmd: "exit 1"\n---\nbody\n`);
    mkdirSync(path.join(dir, "core"));
    writeFileSync(path.join(dir, "core", "a.ts"), "x\n");
    // `profile: "off"` -> quality_gate.enabled=false (not user-overridable);
    // explicit `rail.level: "commit"` reaches the commit rail anyway (rail
    // and quality_gate are orthogonal concerns, SP-concerns-orthogonal) — the
    // one realistic way to get a resolved task test-cmd whose gate concern is
    // disabled.
    const res = runRailCli(["commit", "-m", "disabled gate"], deps(dir, { profile: "off", rail: { level: "commit" } }));
    assert.equal(res.exitCode, 0, res.stdout);
    assert.match(res.stdout, /gate: none \(disabled\)/);
    assert.match(git.run(["git", "log", "--oneline", "-1"]).stdout, /disabled gate/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commit: active zone + --gate override -> still refused (gate-override-denied), independent of task test-cmd", () => {
  const { dir, git } = initRepo();
  try {
    writeZone(dir, JSON.stringify({ task: "gt-override", allow: ["core/**"] }));
    writeTaskFile(dir, "gt-override", `---\nzone:\n  allow: ["core/**"]\ntest-cmd: "exit 1"\n---\nbody\n`);
    mkdirSync(path.join(dir, "core"));
    writeFileSync(path.join(dir, "core", "a.ts"), "x\n");
    const before = head(git);
    const res = runRailCli(
      ["commit", "-m", "override", "--gate", "exit 0"],
      deps(dir, AUTONOMOUS_NO_POLICY_CMD)
    );
    assert.equal(res.exitCode, 1);
    assert.match(res.stdout, /gate-override-denied/);
    assert.equal(head(git), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
