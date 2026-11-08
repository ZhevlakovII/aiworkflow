import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { parseGitLog, classifyCommits, buildGuardRow, renderText, renderJson, type CommitLogEntry } from "../src/ops/audit-commits.ts";
import { nodeGitSeam, type GitSeam } from "../src/rails/git-seam.ts";
import { runAuditCommitsCli, type AuditCommitsCliDeps } from "../src/ops/audit-commits-cli.ts";
import { gatedCommit } from "../src/rails/commit.ts";
import type { ResolvedPolicy } from "../src/policy/policy.ts";

// ---------------------------------------------------------------------------
// parseGitLog (NUL/RS-delimited `git log --format` parsing)
// ---------------------------------------------------------------------------

const NUL = "\u0000";
const REC = "\u001e";

function fmt(sha: string, author: string, subject: string, body: string): string {
  return `${sha}${NUL}${author}${NUL}${subject}${NUL}${body}${REC}`;
}

test("parseGitLog: parses NUL-split fields per RS-split record, sha truncated to 9 chars", () => {
  const raw = fmt("abcdef0123456789", "Ilia", "feat: x", "body text") + fmt("f00dcafe000000", "Ilia", "fix: y", "");
  const rows = parseGitLog(raw);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].sha, "abcdef012");
  assert.equal(rows[0].author, "Ilia");
  assert.equal(rows[0].subject, "feat: x");
  assert.equal(rows[0].body, "body text");
  assert.equal(rows[1].sha, "f00dcafe0");
});

test("parseGitLog: blank/short records skipped", () => {
  const raw = REC + `only${NUL}two${REC}` + fmt("aaaaaaaaa", "a", "s", "b");
  const rows = parseGitLog(raw);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sha, "aaaaaaaaa");
});

// ---------------------------------------------------------------------------
// classifyCommits (contract L-3: RAIL trailer / LEGACY pattern -> signed)
// ---------------------------------------------------------------------------

function entry(subject: string, body = ""): CommitLogEntry {
  return { sha: "deadbeef1", author: "A", subject, body };
}

test("classifyCommits: [omp-rail:tool] trailer (anywhere in subject+body) -> signed", () => {
  const r = classifyCommits([entry("feat(x): thing", "[omp-rail:queue_batch]")]);
  assert.equal(r.signedCount, 1);
  assert.equal(r.suspect.length, 0);
});

test("classifyCommits: 'via execute_worker'/'via codex_worker' legacy pattern -> signed", () => {
  const r = classifyCommits([entry("feat(x): via execute_worker"), entry("feat(y): via codex_worker")]);
  assert.equal(r.signedCount, 2);
});

test("classifyCommits: 'design(<tid>): spec+ADR locked' at subject START -> signed", () => {
  const r = classifyCommits([entry("design(t7-5): spec+ADR locked (gate PASS, critic clean)")]);
  assert.equal(r.signedCount, 1);
});

test("classifyCommits: 'design(...): spec+ADR locked' NOT at start -> NOT matched by the anchored legacy pattern", () => {
  const r = classifyCommits([entry("chore: design(t7-5): spec+ADR locked")]);
  assert.equal(r.signedCount, 0);
  assert.equal(r.suspect.length, 1);
});

test("classifyCommits: plain manual commit -> suspect, {sha,author,subject} only (no body)", () => {
  const r = classifyCommits([entry("wip: quick fix", "some body")]);
  assert.equal(r.suspect.length, 1);
  assert.deepEqual(r.suspect[0], { sha: "deadbeef1", author: "A", subject: "wip: quick fix" });
});

test("classifyCommits: total = signedCount + suspect.length", () => {
  const r = classifyCommits([entry("[omp-rail:x]"), entry("manual"), entry("manual2")]);
  assert.equal(r.total, 3);
  assert.equal(r.signedCount + r.suspect.length, 3);
});

// ---------------------------------------------------------------------------
// buildGuardRow / renderText / renderJson
// ---------------------------------------------------------------------------

test("buildGuardRow: shape + subject truncated to 120 chars", () => {
  const row = buildGuardRow("abc1234", "x".repeat(150), "2026-01-01T00:00:00Z");
  assert.equal(row.kind, "guard");
  assert.equal(row.event, "bypass-suspected");
  assert.equal(row.tool, "audit_commits");
  assert.equal(row.detail, `abc1234 ${"x".repeat(120)}`);
});

test("renderText: all signed -> checkmark line, no suspect list", () => {
  const text = renderText({ total: 2, signedCount: 2, suspect: [] });
  assert.match(text, /^== BYPASS AUDIT == total=2 rail-signed=2 suspect=0$/m);
  assert.match(text, /все коммиты несут rail-подпись/);
});

test("renderText: suspects listed with sha/author/subject", () => {
  const text = renderText({ total: 2, signedCount: 1, suspect: [{ sha: "abc1234", author: "Ilia", subject: "wip" }] });
  assert.match(text, /-- НЕ через рельс \(bypass-suspected \/ ручные\) --/);
  assert.match(text, /abc1234 {2}Ilia {8} {2}wip/);
});

test("renderJson: {total, signed, suspect}", () => {
  const j = renderJson({ total: 2, signedCount: 1, suspect: [{ sha: "a", author: "b", subject: "c" }] });
  assert.deepEqual(j, { total: 2, signed: 1, suspect: [{ sha: "a", author: "b", subject: "c" }] });
});

// ---------------------------------------------------------------------------
// runAuditCommitsCli (real temp git repo — same pattern as rails-cli.test.ts)
// ---------------------------------------------------------------------------

function mkRepoDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function initRepo(): { dir: string; git: GitSeam } {
  const dir = mkRepoDir("audit-commits-repo-");
  const git = nodeGitSeam(dir);
  assert.equal(git.run(["git", "init", "-q", "-b", "main"]).code, 0);
  git.run(["git", "config", "user.email", "test@example.com"]);
  git.run(["git", "config", "user.name", "Audit CLI Test"]);
  return { dir, git };
}

function commit(dir: string, git: GitSeam, filename: string, message: string): void {
  writeFileSync(path.join(dir, filename), `${filename}\n`);
  git.run(["git", "add", "-A"]);
  assert.equal(git.run(["git", "commit", "-q", "-m", message]).code, 0);
}

function fakeCliDeps(git: GitSeam, cwd: string, homedir: string): { deps: AuditCommitsCliDeps; emitted: Map<string, string[]> } {
  const emitted = new Map<string, string[]>();
  const deps: AuditCommitsCliDeps = {
    git,
    cwd,
    homedir,
    mkdirp: () => {
      /* no real dirs needed — emitted is in-memory */
    },
    appendLine: (p, line) => {
      const arr = emitted.get(p) ?? [];
      arr.push(line);
      emitted.set(p, arr);
    },
    now: () => "2026-01-01T00:00:00.000Z",
  };
  return { deps, emitted };
}

test("runAuditCommitsCli: all rail-signed -> exit 0, text output", () => {
  const { dir, git } = initRepo();
  try {
    commit(dir, git, "a.md", "feat(x): via execute_worker");
    const { deps } = fakeCliDeps(git, dir, path.join(dir, "home"));
    const out = runAuditCommitsCli([], deps);
    assert.equal(out.exitCode, 0);
    assert.match(out.stdout, /rail-signed=1 suspect=0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runAuditCommitsCli: manual commit -> exit 1, listed as suspect", () => {
  const { dir, git } = initRepo();
  try {
    commit(dir, git, "a.md", "wip: manual edit");
    const { deps } = fakeCliDeps(git, dir, path.join(dir, "home"));
    const out = runAuditCommitsCli(["--json"], deps);
    assert.equal(out.exitCode, 1);
    const parsed = JSON.parse(out.stdout);
    assert.equal(parsed.suspect.length, 1);
    assert.equal(parsed.suspect[0].subject, "wip: manual edit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runAuditCommitsCli: --emit writes a bypass-suspected guard line to repo + home telemetry.ndjson", () => {
  const { dir, git } = initRepo();
  try {
    commit(dir, git, "a.md", "wip: manual edit");
    const home = path.join(dir, "home");
    const { deps, emitted } = fakeCliDeps(git, dir, home);
    const out = runAuditCommitsCli(["--emit"], deps);
    assert.equal(out.exitCode, 1);
    const repoTarget = path.join(dir, ".workflow", "telemetry.ndjson");
    const homeTarget = path.join(home, ".omp", "agent", "telemetry.ndjson");
    assert.equal(emitted.get(repoTarget)?.length, 1);
    assert.equal(emitted.get(homeTarget)?.length, 1);
    const row = JSON.parse(emitted.get(repoTarget)![0]);
    assert.equal(row.event, "bypass-suspected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runAuditCommitsCli: --since narrows the log range", () => {
  const { dir, git } = initRepo();
  try {
    commit(dir, git, "a.md", "feat(x): via execute_worker");
    const sinceSha = git.run(["git", "rev-parse", "HEAD"]).stdout.trim();
    commit(dir, git, "b.md", "wip: manual edit");
    const { deps } = fakeCliDeps(git, dir, path.join(dir, "home"));
    const out = runAuditCommitsCli(["--since", sinceSha, "--json"], deps);
    const parsed = JSON.parse(out.stdout);
    assert.equal(parsed.total, 1); // only the commit AFTER sinceSha
    assert.equal(parsed.suspect[0].subject, "wip: manual edit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runAuditCommitsCli: a gatedCommit-made commit (rail-signature trailer, contract L-1) -> classified as signed", () => {
  const { dir, git } = initRepo();
  try {
    writeFileSync(path.join(dir, "railed.md"), "x\n");
    const policy: ResolvedPolicy = {
      profile: "guarded",
      quality_gate: { enabled: false, cmd: null },
      operator_zone: { enabled: false, protected: [] },
      rail: { level: "commit", merge_needs_human: true },
      security_floor: { enabled: true },
    };
    const commitResult = gatedCommit({ git, policy, message: "feat: railed commit", actor: "operator" });
    assert.equal(commitResult.ok, true);
    const { deps } = fakeCliDeps(git, dir, path.join(dir, "home"));
    const out = runAuditCommitsCli([], deps);
    assert.equal(out.exitCode, 0);
    assert.match(out.stdout, /rail-signed=1 suspect=0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runAuditCommitsCli: git log failure (bad --repo) -> exit 2", () => {
  const notARepo = mkRepoDir("audit-commits-norepo-");
  try {
    const { deps } = fakeCliDeps(nodeGitSeam(), notARepo, path.join(notARepo, "home"));
    const out = runAuditCommitsCli(["--repo", notARepo], deps);
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /git log failed/);
  } finally {
    rmSync(notARepo, { recursive: true, force: true });
  }
});
