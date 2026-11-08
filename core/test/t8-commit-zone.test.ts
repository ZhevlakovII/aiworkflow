/**
 * T8 H2/H3 (`.workflow/tasks/t8-status-quo-holes.md`) — L1 commit rail vs an
 * active worker zone (`.workflow/active-zone.json`): staged paths checked,
 * broken file fail-closed, `--gate` override refused while the zone is active.
 * Real temp git repos (same pattern as rails-cli.test.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { nodeGitSeam, type GitSeam } from "../src/rails/git-seam.ts";
import { runRailCli, type RailCliDeps } from "../src/rails/cli.ts";
import { parseActiveZone, loadActiveZoneForCommit } from "../src/rails/active-zone.ts";
import type { Policy } from "../src/policy/policy.ts";

function initRepo(): { dir: string; git: GitSeam } {
  const dir = mkdtempSync(path.join(tmpdir(), "t8-commit-zone-"));
  const git = nodeGitSeam(dir);
  assert.equal(git.run(["git", "init", "-q", "-b", "main"]).code, 0);
  git.run(["git", "config", "user.email", "test@example.com"]);
  git.run(["git", "config", "user.name", "T8 Test"]);
  // Mirrors the real repo: `.workflow/` is runtime state, never staged.
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

/**
 * A5a (post-security-review): an active zone naming a task-file MUST have a
 * real, parseable task-file behind it now (missing/broken -> `zone-invalid`,
 * no policy fallback) — every H2/H3 fixture below using `task: "t"` needs one
 * so it keeps exercising ITS OWN scenario (zone-check / --gate) rather than
 * incidentally tripping the new task-file gate-resolution check instead. No
 * `test-cmd` here -> gate falls through to whatever `POLICY`/inline policy
 * the test passes, same as the pre-A5a fixtures intended.
 */
function writeTaskFile(dir: string, task: string): void {
  mkdirSync(path.join(dir, ".workflow", "tasks"), { recursive: true });
  writeFileSync(path.join(dir, ".workflow", "tasks", `${task}.md`), `---\nzone:\n  allow: ["core/**"]\n---\nbody\n`);
}

function deps(dir: string, policy: Policy): RailCliDeps {
  // No `loadZone` injected -> the real fs loader is used (production path).
  return { loadPolicy: () => ({ policy, warnings: [] }), makeSeam: (cwd) => nodeGitSeam(cwd), cwd: dir, isTTY: false };
}

const POLICY: Policy = { profile: "autonomous", quality_gate: { cmd: "exit 0" } };

function head(git: GitSeam): string {
  return git.run(["git", "rev-parse", "HEAD"]).stdout.trim();
}

function stagedCount(git: GitSeam): number {
  return git.run(["git", "diff", "--cached", "--name-only"]).stdout.split(/\r?\n/).filter((s) => s.trim()).length;
}

// --- H2 ---------------------------------------------------------------------

test("H2: active zone, all staged paths in allow -> committed", () => {
  const { dir, git } = initRepo();
  try {
    writeZone(dir, JSON.stringify({ task: "t", allow: ["core/**"] }));
    writeTaskFile(dir, "t");
    mkdirSync(path.join(dir, "core"));
    writeFileSync(path.join(dir, "core", "a.ts"), "x\n");
    const res = runRailCli(["commit", "-m", "in zone"], deps(dir, POLICY));
    assert.equal(res.exitCode, 0, res.stdout);
    assert.match(git.run(["git", "log", "--oneline", "-1"]).stdout, /in zone/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("H2: active zone, a staged path outside allow -> zone-violation, no commit, index reset", () => {
  const { dir, git } = initRepo();
  try {
    writeZone(dir, JSON.stringify({ task: "t", allow: ["core/**"] }));
    writeTaskFile(dir, "t");
    mkdirSync(path.join(dir, "core"));
    writeFileSync(path.join(dir, "core", "a.ts"), "x\n");
    writeFileSync(path.join(dir, "outside.md"), "x\n");
    const before = head(git);
    const res = runRailCli(["commit", "-m", "leak"], deps(dir, POLICY));
    assert.equal(res.exitCode, 1);
    assert.match(res.stdout, /zone-violation/);
    assert.match(res.stdout, /outside\.md/);
    assert.equal(head(git), before);
    assert.equal(stagedCount(git), 0);
    assert.ok(existsSync(path.join(dir, "outside.md")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("H2: active zone, staged path in allow but also in deny -> zone-violation", () => {
  const { dir, git } = initRepo();
  try {
    writeZone(dir, JSON.stringify({ task: "t", allow: ["core/**"], deny: ["core/secret"] }));
    writeTaskFile(dir, "t");
    mkdirSync(path.join(dir, "core", "secret"), { recursive: true });
    writeFileSync(path.join(dir, "core", "secret", "k.txt"), "x\n");
    const before = head(git);
    const res = runRailCli(["commit", "-m", "deny"], deps(dir, POLICY));
    assert.equal(res.exitCode, 1);
    assert.match(res.stdout, /zone-violation/);
    assert.equal(head(git), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("H2: no zone file -> previous behaviour (any path committed)", () => {
  const { dir, git } = initRepo();
  try {
    writeFileSync(path.join(dir, "anywhere.md"), "x\n");
    const res = runRailCli(["commit", "-m", "free"], deps(dir, POLICY));
    assert.equal(res.exitCode, 0, res.stdout);
    assert.match(git.run(["git", "log", "--oneline", "-1"]).stdout, /free/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [label, content] of [
  ["not JSON", "{not json"],
  ["no task", JSON.stringify({ allow: ["core/**"] })],
  ["allow not string[]", JSON.stringify({ task: "t", allow: "core/**" })],
  ["deny not string[]", JSON.stringify({ task: "t", allow: ["core/**"], deny: [1] })],
  ["array", "[]"],
] as const) {
  test(`H2: broken zone file (${label}) -> zone-invalid, commit refused (fail-closed)`, () => {
    const { dir, git } = initRepo();
    try {
      writeZone(dir, content);
      writeFileSync(path.join(dir, "a.md"), "x\n");
      const before = head(git);
      const res = runRailCli(["commit", "-m", "broken"], deps(dir, POLICY));
      assert.equal(res.exitCode, 1);
      assert.match(res.stdout, /zone-invalid/);
      assert.equal(head(git), before);
      assert.equal(stagedCount(git), 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("H2: parseActiveZone tolerates a UTF-8 BOM and floors the zone file itself into deny", () => {
  const res = parseActiveZone("﻿" + JSON.stringify({ task: "t", allow: ["**"] }));
  assert.equal(res.kind, "zone");
  if (res.kind === "zone") assert.ok(res.zone.deny.includes(".workflow/active-zone.json"));
});

test("H2: loadActiveZoneForCommit — missing file -> none", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "t8-nozone-"));
  try {
    assert.equal(loadActiveZoneForCommit(dir).kind, "none");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- H3 ---------------------------------------------------------------------

test("H3: --gate override with an active zone -> refused, no commit", () => {
  const { dir, git } = initRepo();
  try {
    writeZone(dir, JSON.stringify({ task: "t", allow: ["core/**"] }));
    writeTaskFile(dir, "t");
    mkdirSync(path.join(dir, "core"));
    writeFileSync(path.join(dir, "core", "a.ts"), "x\n");
    const before = head(git);
    const res = runRailCli(["commit", "-m", "override", "--gate", "exit 0"], deps(dir, { profile: "autonomous", quality_gate: { cmd: "exit 1" } }));
    assert.equal(res.exitCode, 1);
    assert.match(res.stdout, /gate-override-denied/);
    assert.equal(head(git), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("H3: active zone, no --gate -> policy gate is what runs (red policy gate blocks)", () => {
  const { dir, git } = initRepo();
  try {
    writeZone(dir, JSON.stringify({ task: "t", allow: ["core/**"] }));
    writeTaskFile(dir, "t");
    mkdirSync(path.join(dir, "core"));
    writeFileSync(path.join(dir, "core", "a.ts"), "x\n");
    const before = head(git);
    const res = runRailCli(["commit", "-m", "policy gate"], deps(dir, { profile: "autonomous", quality_gate: { cmd: "exit 1" } }));
    assert.equal(res.exitCode, 1);
    assert.match(res.stdout, /gate-red/);
    assert.equal(head(git), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("H3: no zone file -> --gate override still works (overrides a red policy gate)", () => {
  const { dir, git } = initRepo();
  try {
    writeFileSync(path.join(dir, "a.md"), "x\n");
    const res = runRailCli(["commit", "-m", "override ok", "--gate", "exit 0"], deps(dir, { profile: "autonomous", quality_gate: { cmd: "exit 1" } }));
    assert.equal(res.exitCode, 0, res.stdout);
    assert.match(git.run(["git", "log", "--oneline", "-1"]).stdout, /override ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
