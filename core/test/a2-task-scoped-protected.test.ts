/**
 * A2 (U13) — task-scoped exception to `operator_zone.protected` in the L1
 * commit rail (`.workflow/tasks/a2-u13-task-scoped-protected.md`).
 * Direct unit coverage of `evaluateTaskScopedProtectedException`
 * (`../src/rails/task-scoped-protected.ts`, every a/b/c condition + every
 * fail-closed parse/IO branch) plus a couple of end-to-end `runRailCli`
 * checks proving the exception actually flips a real commit's outcome
 * (same real-temp-git-repo pattern as `t8-commit-zone.test.ts`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { evaluateTaskScopedProtectedException } from "../src/rails/task-scoped-protected.ts";
import { nodeGitSeam, type GitSeam } from "../src/rails/git-seam.ts";
import { runRailCli, type RailCliDeps } from "../src/rails/cli.ts";
import { resolvePolicy, type Policy } from "../src/policy/policy.ts";
import { parseActiveZone, isValidTaskId } from "../src/rails/active-zone.ts";

const POLICY: Policy = {
  profile: "guarded",
  operator_zone: { enabled: true, protected: [".omp"] },
  quality_gate: { cmd: "exit 0" },
};
const RESOLVED = resolvePolicy({ policy: POLICY, interactive: false });

function tmpRoot(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function writeTask(repoRoot: string, id: string, content: string): void {
  const dir = path.join(repoRoot, ".workflow", "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${id}.md`), content);
}

const GOOD_TASK = [
  "---",
  "id: good",
  "stage: execute",
  "class: security",
  "zone:",
  '  allow: ["core/**", ".omp/agents/**"]',
  "  deny: []",
  "---",
  "",
  "# good task",
  "",
].join("\n");

const BROAD_GLOB_TASK = [
  "---",
  "id: broad",
  "zone:",
  '  allow: ["**"]',
  "  deny: []",
  "---",
].join("\n");

const DENY_OVERLAP_TASK = [
  "---",
  "id: denyoverlap",
  "zone:",
  '  allow: [".omp/agents/**"]',
  '  deny: [".omp/agents/secret.md"]',
  "---",
].join("\n");

const NO_FRONTMATTER_TASK = "# no frontmatter here\njust text\n";

const NO_ZONE_KEY_TASK = ["---", "id: nozonekey", 'allow: ["core/**"]', "---"].join("\n");

const SCALAR_ZONE_TASK = ["---", "id: scalarzone", "zone: none", "---"].join("\n");

const EMPTY_ALLOW_TASK = ["---", "id: emptyallow", "zone:", "  allow: []", "  deny: []", "---"].join("\n");

// Security review: a `reallow:` line BEFORE the `zone:` block. The shared
// `globList` (`../src/design/task-zone.ts`) has no anchor and would match
// this substring first (`"reallow: [...]"` contains the literal substring
// `"allow: [...]"`) — a task-scoped-protected.ts private parser must NOT.
const REALLOW_BEFORE_ZONE_TASK = [
  "---",
  "id: reallow",
  'reallow: [".omp/agents/**"]',
  "zone:",
  '  allow: ["core/**"]',
  "  deny: []",
  "---",
].join("\n");

const DUPLICATE_ALLOW_TASK = [
  "---",
  "id: dup",
  "zone:",
  '  allow: [".omp/agents/**"]',
  '  allow: ["core/**"]',
  "  deny: []",
  "---",
].join("\n");

const CRLF_BOM_TASK =
  "﻿" +
  ["---", "id: crlfbom", "zone:", '  allow: [".omp/agents/**"]', "  deny: []", "---", "", "# doc", ""].join("\r\n");

// --- direct: not-applicable (exception never even attempted) ---------------

test("not-applicable: actor !== operator", () => {
  const out = evaluateTaskScopedProtectedException({
    filePath: ".omp/agents/x.md",
    actor: "worker",
    policy: RESOLVED,
    repoRoot: tmpRoot("a2-na-"),
    workerZone: { allow: [".omp/**"] },
    workerZoneTask: "good",
  });
  assert.equal(out.kind, "not-applicable");
});

test("not-applicable: operator_zone disabled", () => {
  const off = resolvePolicy({ policy: { profile: "guarded", operator_zone: { enabled: false } }, interactive: false });
  const out = evaluateTaskScopedProtectedException({
    filePath: ".omp/agents/x.md",
    actor: "operator",
    policy: off,
    workerZone: { allow: [".omp/**"] },
    workerZoneTask: "good",
  });
  assert.equal(out.kind, "not-applicable");
});

test("not-applicable: `.git` is NEVER eligible, even with a matching task-file allow", () => {
  const dir = tmpRoot("a2-git-");
  try {
    writeTask(
      dir,
      "gitallow",
      ["---", "id: gitallow", "zone:", '  allow: [".git/**"]', "  deny: []", "---"].join("\n")
    );
    const out = evaluateTaskScopedProtectedException({
      filePath: ".git/hooks/pre-commit",
      actor: "operator",
      policy: RESOLVED,
      repoRoot: dir,
      workerZone: { allow: [".git/**"] },
      workerZoneTask: "gitallow",
    });
    // `.git` is DEFAULT_PROTECTED, not `operator_zone.protected` — the caller
    // (`commit.ts`) falls back to its own unconditional `.git` deny.
    assert.equal(out.kind, "not-applicable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("not-applicable: path not under any operator_zone.protected root", () => {
  const out = evaluateTaskScopedProtectedException({
    filePath: "core/src/x.ts",
    actor: "operator",
    policy: RESOLVED,
    workerZone: { allow: ["core/**"] },
    workerZoneTask: "good",
  });
  assert.equal(out.kind, "not-applicable");
});

// --- condition a: valid active zone -----------------------------------------

test("denied (condition a): no active zone at all -> zone-violation, names condition a", () => {
  const out = evaluateTaskScopedProtectedException({
    filePath: ".omp/agents/x.md",
    actor: "operator",
    policy: RESOLVED,
  });
  assert.equal(out.kind, "denied");
  assert.equal(out.status, "zone-violation");
  assert.match(out.reason, /условие a/);
});

// --- condition b: task-file --------------------------------------------------

test("denied (condition b, zone-invalid): task-file missing", () => {
  const dir = tmpRoot("a2-notask-");
  try {
    const out = evaluateTaskScopedProtectedException({
      filePath: ".omp/agents/x.md",
      actor: "operator",
      policy: RESOLVED,
      repoRoot: dir,
      workerZone: { allow: [".omp/**"] },
      workerZoneTask: "no-such-task",
    });
    assert.equal(out.kind, "denied");
    assert.equal(out.status, "zone-invalid");
    assert.match(out.reason, /не найден/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("denied (condition b, zone-invalid): task-file has no frontmatter block", () => {
  const dir = tmpRoot("a2-nofm-");
  try {
    writeTask(dir, "nofm", NO_FRONTMATTER_TASK);
    const out = evaluateTaskScopedProtectedException({
      filePath: ".omp/agents/x.md",
      actor: "operator",
      policy: RESOLVED,
      repoRoot: dir,
      workerZone: { allow: [".omp/**"] },
      workerZoneTask: "nofm",
    });
    assert.equal(out.kind, "denied");
    assert.equal(out.status, "zone-invalid");
    assert.match(out.reason, /frontmatter не найден/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("denied (condition b, zone-invalid): task-file frontmatter has no `zone` key", () => {
  const dir = tmpRoot("a2-nozonekey-");
  try {
    writeTask(dir, "nozonekey", NO_ZONE_KEY_TASK);
    const out = evaluateTaskScopedProtectedException({
      filePath: ".omp/agents/x.md",
      actor: "operator",
      policy: RESOLVED,
      repoRoot: dir,
      workerZone: { allow: [".omp/**"] },
      workerZoneTask: "nozonekey",
    });
    assert.equal(out.kind, "denied");
    assert.equal(out.status, "zone-invalid");
    assert.match(out.reason, /не содержит ключ `zone`/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("denied (condition b, zone-invalid): task-file `zone` is a scalar, not a block", () => {
  const dir = tmpRoot("a2-scalarzone-");
  try {
    writeTask(dir, "scalarzone", SCALAR_ZONE_TASK);
    const out = evaluateTaskScopedProtectedException({
      filePath: ".omp/agents/x.md",
      actor: "operator",
      policy: RESOLVED,
      repoRoot: dir,
      workerZone: { allow: [".omp/**"] },
      workerZoneTask: "scalarzone",
    });
    assert.equal(out.kind, "denied");
    assert.equal(out.status, "zone-invalid");
    assert.match(out.reason, /не блок/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("denied (condition b, zone-invalid): task-file `zone.allow` is empty", () => {
  const dir = tmpRoot("a2-emptyallow-");
  try {
    writeTask(dir, "emptyallow", EMPTY_ALLOW_TASK);
    const out = evaluateTaskScopedProtectedException({
      filePath: ".omp/agents/x.md",
      actor: "operator",
      policy: RESOLVED,
      repoRoot: dir,
      workerZone: { allow: [".omp/**"] },
      workerZoneTask: "emptyallow",
    });
    assert.equal(out.kind, "denied");
    assert.equal(out.status, "zone-invalid");
    assert.match(out.reason, /отсутствует или пуст/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("denied (condition b, zone-violation): task-file allow is a broad `**` -> not explicit", () => {
  const dir = tmpRoot("a2-broad-");
  try {
    writeTask(dir, "broad", BROAD_GLOB_TASK);
    const out = evaluateTaskScopedProtectedException({
      filePath: ".omp/agents/x.md",
      actor: "operator",
      policy: RESOLVED,
      repoRoot: dir,
      workerZone: { allow: [".omp/**"] },
      workerZoneTask: "broad",
    });
    assert.equal(out.kind, "denied");
    assert.equal(out.status, "zone-violation");
    assert.match(out.reason, /условие b/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("denied (condition b, zone-violation): task-file explicit allow, but path also in task-file zone.deny", () => {
  const dir = tmpRoot("a2-denyoverlap-");
  try {
    writeTask(dir, "denyoverlap", DENY_OVERLAP_TASK);
    const out = evaluateTaskScopedProtectedException({
      filePath: ".omp/agents/secret.md",
      actor: "operator",
      policy: RESOLVED,
      repoRoot: dir,
      workerZone: { allow: [".omp/**"] },
      workerZoneTask: "denyoverlap",
    });
    assert.equal(out.kind, "denied");
    assert.equal(out.status, "zone-violation");
    assert.match(out.reason, /условие b/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- condition c: active-zone.json's own allow/deny -------------------------

test("denied (condition c): task-file OK, but path outside active-zone.json allow", () => {
  const dir = tmpRoot("a2-outsidezone-");
  try {
    writeTask(dir, "good", GOOD_TASK);
    const out = evaluateTaskScopedProtectedException({
      filePath: ".omp/agents/x.md",
      actor: "operator",
      policy: RESOLVED,
      repoRoot: dir,
      workerZone: { allow: ["core/**"] }, // active zone never granted .omp
      workerZoneTask: "good",
    });
    assert.equal(out.kind, "denied");
    assert.equal(out.status, "zone-violation");
    assert.match(out.reason, /условие c/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("denied (condition c): task-file OK, active zone allows it broadly but its own deny covers the path", () => {
  const dir = tmpRoot("a2-zonedeny-");
  try {
    writeTask(dir, "good", GOOD_TASK);
    const out = evaluateTaskScopedProtectedException({
      filePath: ".omp/agents/x.md",
      actor: "operator",
      policy: RESOLVED,
      repoRoot: dir,
      workerZone: { allow: [".omp/**"], deny: [".omp/agents/**"] },
      workerZoneTask: "good",
    });
    assert.equal(out.kind, "denied");
    assert.equal(out.status, "zone-violation");
    assert.match(out.reason, /условие c/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- exempt: a+b+c all hold ---------------------------------------------------

test("exempt: a+b+c all hold", () => {
  const dir = tmpRoot("a2-exempt-");
  try {
    writeTask(dir, "good", GOOD_TASK);
    const out = evaluateTaskScopedProtectedException({
      filePath: ".omp/agents/x.md",
      actor: "operator",
      policy: RESOLVED,
      repoRoot: dir,
      workerZone: { allow: [".omp/agents/**"] },
      workerZoneTask: "good",
    });
    assert.equal(out.kind, "exempt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- end-to-end: runRailCli over a real temp git repo -----------------------

function initRepo(): { dir: string; git: GitSeam } {
  const dir = mkdtempSync(path.join(tmpdir(), "a2-e2e-"));
  const git = nodeGitSeam(dir);
  assert.equal(git.run(["git", "init", "-q", "-b", "main"]).code, 0);
  git.run(["git", "config", "user.email", "test@example.com"]);
  git.run(["git", "config", "user.name", "A2 Test"]);
  writeFileSync(path.join(dir, ".gitignore"), "/.workflow/\n");
  writeFileSync(path.join(dir, "README.md"), "init\n");
  git.run(["git", "add", "-A"]);
  assert.equal(git.run(["git", "commit", "-q", "-m", "init"]).code, 0);
  return { dir, git };
}

function writeActiveZone(dir: string, content: string): void {
  mkdirSync(path.join(dir, ".workflow"), { recursive: true });
  writeFileSync(path.join(dir, ".workflow", "active-zone.json"), content);
}

function deps(dir: string): RailCliDeps {
  return { loadPolicy: () => ({ policy: POLICY, warnings: [] }), makeSeam: (cwd) => nodeGitSeam(cwd), cwd: dir, isTTY: false };
}

function head(git: GitSeam): string {
  return git.run(["git", "rev-parse", "HEAD"]).stdout.trim();
}

test("e2e: no active zone -> .omp path denied same as before A2 (unaffected)", () => {
  const { dir, git } = initRepo();
  try {
    mkdirSync(path.join(dir, ".omp", "agents"), { recursive: true });
    writeFileSync(path.join(dir, ".omp", "agents", "go-developer.md"), "x\n");
    const before = head(git);
    const res = runRailCli(["commit", "-m", "no zone"], deps(dir));
    assert.equal(res.exitCode, 1);
    assert.match(res.stdout, /zone-violation/);
    assert.equal(head(git), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("e2e: active zone + matching task-file -> .omp path committed (task-scoped exception)", () => {
  const { dir, git } = initRepo();
  try {
    writeTask(dir, "good", GOOD_TASK);
    writeActiveZone(dir, JSON.stringify({ task: "good", allow: [".omp/agents/**", "core/**"] }));
    mkdirSync(path.join(dir, ".omp", "agents"), { recursive: true });
    writeFileSync(path.join(dir, ".omp", "agents", "go-developer.md"), "x\n");
    const res = runRailCli(["commit", "-m", "task-scoped omp edit"], deps(dir));
    assert.equal(res.exitCode, 0, res.stdout);
    assert.match(git.run(["git", "log", "--oneline", "-1"]).stdout, /task-scoped omp edit/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("e2e: active zone present but task-file allow is broad `**` -> still denied (zone-violation)", () => {
  const { dir, git } = initRepo();
  try {
    writeTask(dir, "broad", BROAD_GLOB_TASK);
    writeActiveZone(dir, JSON.stringify({ task: "broad", allow: [".omp/**", "core/**"] }));
    mkdirSync(path.join(dir, ".omp", "agents"), { recursive: true });
    writeFileSync(path.join(dir, ".omp", "agents", "go-developer.md"), "x\n");
    const before = head(git);
    const res = runRailCli(["commit", "-m", "broad task"], deps(dir));
    assert.equal(res.exitCode, 1);
    assert.match(res.stdout, /zone-violation/);
    assert.equal(head(git), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("e2e: non-protected path unaffected by A2 (plain H2 behaviour: outside active zone allow -> zone-violation)", () => {
  const { dir, git } = initRepo();
  try {
    // A5a: an active zone naming a task-file now needs a real one behind it
    // (missing -> zone-invalid, no policy fallback) — write it so this test
    // keeps exercising ITS OWN scenario (path outside active-zone allow).
    writeTask(dir, "good", GOOD_TASK);
    writeActiveZone(dir, JSON.stringify({ task: "good", allow: ["core/**"] }));
    writeFileSync(path.join(dir, "outside.md"), "x\n");
    const before = head(git);
    const res = runRailCli(["commit", "-m", "leak"], deps(dir));
    assert.equal(res.exitCode, 1);
    assert.match(res.stdout, /zone-violation/);
    assert.match(res.stdout, /outside\.md/);
    assert.equal(head(git), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- security review follow-up ----------------------------------------------
// 1) HIGH: task-id path traversal (`active-zone.json`'s `task` -> a
//    `path.join(repoRoot, ".workflow", "tasks", `${task}.md`)`).

test("isValidTaskId: accepts a normal task id", () => {
  assert.ok(isValidTaskId("a2-u13-task-scoped-protected"));
});

for (const bad of ["../x", "a/b", "a\\b", "..", "/etc/passwd", "C:/x", "a/../../x"]) {
  test(`parseActiveZone: task=${JSON.stringify(bad)} -> invalid (path-traversal guard)`, () => {
    const res = parseActiveZone(JSON.stringify({ task: bad, allow: ["core/**"] }));
    assert.equal(res.kind, "invalid");
  });
}

test("evaluateTaskScopedProtectedException: malicious workerZoneTask bypassing parseActiveZone -> zone-invalid (defence in depth)", () => {
  const dir = tmpRoot("a2-badtaskid-");
  try {
    const out = evaluateTaskScopedProtectedException({
      filePath: ".omp/agents/x.md",
      actor: "operator",
      policy: RESOLVED,
      repoRoot: dir,
      workerZone: { allow: [".omp/**"] },
      workerZoneTask: "../evil",
    });
    assert.equal(out.kind, "denied");
    assert.equal(out.status, "zone-invalid");
    assert.match(out.reason, /path traversal/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 2) MEDIUM: condition (b) must not use the shared, unanchored `globList`.

test("condition b security: a `reallow:` line BEFORE the zone block does not count as zone.allow", () => {
  const dir = tmpRoot("a2-reallow-");
  try {
    writeTask(dir, "reallow", REALLOW_BEFORE_ZONE_TASK);
    const out = evaluateTaskScopedProtectedException({
      filePath: ".omp/agents/x.md",
      actor: "operator",
      policy: RESOLVED,
      repoRoot: dir,
      // Real (nested) zone.allow is just ["core/**"] — no explicit `.omp/`
      // grant. A vulnerable parser picking up the `reallow:` line's
      // `.omp/agents/**` would have wrongly exempted this path.
      workerZone: { allow: [".omp/agents/**"] },
      workerZoneTask: "reallow",
    });
    assert.equal(out.kind, "denied");
    assert.equal(out.status, "zone-violation");
    assert.match(out.reason, /условие b/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("condition b security: duplicate `allow` key inside the zone block -> zone-invalid", () => {
  const dir = tmpRoot("a2-dupallow-");
  try {
    writeTask(dir, "dup", DUPLICATE_ALLOW_TASK);
    const out = evaluateTaskScopedProtectedException({
      filePath: ".omp/agents/x.md",
      actor: "operator",
      policy: RESOLVED,
      repoRoot: dir,
      workerZone: { allow: [".omp/agents/**"] },
      workerZoneTask: "dup",
    });
    assert.equal(out.kind, "denied");
    assert.equal(out.status, "zone-invalid");
    assert.match(out.reason, /дублирующ/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("condition b: CRLF + BOM frontmatter parses correctly (explicit `.omp` allow still honoured)", () => {
  const dir = tmpRoot("a2-crlfbom-");
  try {
    writeTask(dir, "crlfbom", CRLF_BOM_TASK);
    const out = evaluateTaskScopedProtectedException({
      filePath: ".omp/agents/x.md",
      actor: "operator",
      policy: RESOLVED,
      repoRoot: dir,
      workerZone: { allow: [".omp/agents/**"] },
      workerZoneTask: "crlfbom",
    });
    assert.equal(out.kind, "exempt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 3) LOW: an `operator_zone.protected` entry with glob metacharacters is
//    never eligible for the exception (skipped, not treated as a "root").

test("operator_zone.protected entry with glob metacharacters is never exempt (skipped in root lookup)", () => {
  const globProtectedPolicy = resolvePolicy({
    policy: { profile: "guarded", operator_zone: { enabled: true, protected: ["logs/*.secret"] }, quality_gate: { cmd: "exit 0" } },
    interactive: false,
  });
  const dir = tmpRoot("a2-globprotected-");
  try {
    writeTask(dir, "good", GOOD_TASK);
    const out = evaluateTaskScopedProtectedException({
      filePath: "logs/x.secret",
      actor: "operator",
      policy: globProtectedPolicy,
      repoRoot: dir,
      workerZone: { allow: ["logs/**"] },
      workerZoneTask: "good",
    });
    assert.equal(out.kind, "not-applicable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
