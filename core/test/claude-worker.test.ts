import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

import {
  stripFrontmatter,
  buildTaskPrompt,
  runClaudeWorker,
  type ClaudeSeam,
  type ClaudeRunArgs,
} from "../src/design/claude-worker.ts";

// ---------------------------------------------------------------------------
// stripFrontmatter (verbatim Python `role_prompt`'s frontmatter-strip)
// ---------------------------------------------------------------------------

test("stripFrontmatter: no leading '---' -> returns whole text, trimmed", () => {
  assert.equal(stripFrontmatter("  hello world  "), "hello world");
});

test("stripFrontmatter: exactly 2 '---' markers -> body between them, trimmed", () => {
  const text = "---\nid: producer\n---\n\nYou are the producer.\n";
  assert.equal(stripFrontmatter(text), "You are the producer.");
});

test("stripFrontmatter: only 1 '---' marker -> whole original text kept (Python maxsplit<3 quirk)", () => {
  const text = "---\nno closing marker here";
  assert.equal(stripFrontmatter(text), text.trim());
});

test("stripFrontmatter: 3+ '---' markers (a body '---' rule) -> body between FIRST two, remainder kept verbatim", () => {
  const text = "---\nid: x\n---\n\nprose\n\n---\n\nmore prose after a markdown hr\n";
  assert.equal(stripFrontmatter(text), "prose\n\n---\n\nmore prose after a markdown hr".trim());
});

// ---------------------------------------------------------------------------
// buildTaskPrompt (verbatim Python `build_task_prompt`)
// ---------------------------------------------------------------------------

test("buildTaskPrompt: producer — no notes -> no ИСПРАВЬ block, mentions spec/adr/task paths, allowedTools", () => {
  const r = buildTaskPrompt("producer", "t.md", "s.md", "a.md", undefined, "");
  assert.equal(r.kind, "producer");
  assert.equal(r.allowedTools, "Read,Write,Glob,Grep");
  assert.match(r.userPrompt, /Locked task-file \(ЕДИНСТВЕННЫЙ источник контракта\): t\.md/);
  assert.match(r.userPrompt, /spec → s\.md/);
  assert.match(r.userPrompt, /ADR {2}→ a\.md/);
  assert.doesNotMatch(r.userPrompt, /ИСПРАВЬ по замечаниям/);
});

test("buildTaskPrompt: producer — with notes -> appends ИСПРАВЬ block with the notes text", () => {
  const r = buildTaskPrompt("producer", "t.md", "s.md", "a.md", undefined, "G1 SP-a: bad source-ref");
  assert.match(r.userPrompt, /ИСПРАВЬ по замечаниям прошлого прохода \(перепиши артефакты\):\nG1 SP-a: bad source-ref$/);
});

test("buildTaskPrompt: critic — mentions task/spec/adr/findings paths, no ИСПРАВЬ block without notes", () => {
  const r = buildTaskPrompt("critic", "t.md", "s.md", "a.md", "f.md", "");
  assert.equal(r.kind, "critic");
  assert.match(r.userPrompt, /Свежий критический проход/);
  assert.match(r.userPrompt, /task-file \(источник\): t\.md/);
  assert.match(r.userPrompt, /Запиши findings через Write в f\.md/);
  assert.doesNotMatch(r.userPrompt, /ИСПРАВЬ по замечаниям/);
});

// ---------------------------------------------------------------------------
// runClaudeWorker — orchestration with a stub ClaudeSeam (NEVER a real
// `claude -p` call, contract: do not run real claude).
// ---------------------------------------------------------------------------

function mkRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "claude-worker-"));
}

function cleanup(...dirs: string[]): void {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

const deps = (repoRoot: string, seam: ClaudeSeam) => ({
  seam,
  exists: fs.existsSync,
  readFile: (p: string) => fs.readFileSync(p, "utf-8"),
  mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }),
  repoRoot,
});

function writeRoleFile(repoRoot: string, role: string): void {
  fs.mkdirSync(path.join(repoRoot, ".omp", "agents"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, ".omp", "agents", `${role}.md`), `---\nid: ${role}\n---\n\nYou are the ${role}.\n`);
}

test("runClaudeWorker: task-file missing -> exit 2, ERROR", () => {
  const repo = mkRepo();
  try {
    const seam: ClaudeSeam = { run: () => ({ code: 0, stdout: "", stderr: "" }) };
    const r = runClaudeWorker(
      { role: "producer", task: path.join(repo, "nope.md"), spec: path.join(repo, "s.md"), adr: path.join(repo, "a.md"), model: "sonnet", timeout: 10 },
      deps(repo, seam),
    );
    assert.equal(r.exitCode, 2);
    assert.match(r.stderrLines.join("\n"), /task-file не найден/);
  } finally {
    cleanup(repo);
  }
});

test("runClaudeWorker: role=critic without --findings -> exit 2, ERROR", () => {
  const repo = mkRepo();
  try {
    fs.writeFileSync(path.join(repo, "t.md"), "# task\n");
    const seam: ClaudeSeam = { run: () => ({ code: 0, stdout: "", stderr: "" }) };
    const r = runClaudeWorker(
      { role: "critic", task: path.join(repo, "t.md"), spec: path.join(repo, "s.md"), adr: path.join(repo, "a.md"), model: "sonnet", timeout: 10 },
      deps(repo, seam),
    );
    assert.equal(r.exitCode, 2);
    assert.match(r.stderrLines.join("\n"), /--findings обязателен/);
  } finally {
    cleanup(repo);
  }
});

test("runClaudeWorker: artefact path outside repo -> exit 2, ERROR (zone-check containment)", () => {
  const repo = mkRepo();
  const outside = mkRepo();
  try {
    fs.writeFileSync(path.join(repo, "t.md"), "# task\n");
    const seam: ClaudeSeam = { run: () => ({ code: 0, stdout: "", stderr: "" }) };
    const r = runClaudeWorker(
      { role: "producer", task: path.join(repo, "t.md"), spec: path.join(outside, "s.md"), adr: path.join(repo, "a.md"), model: "sonnet", timeout: 10 },
      deps(repo, seam),
    );
    assert.equal(r.exitCode, 2);
    assert.match(r.stderrLines.join("\n"), /путь вне репо/);
  } finally {
    cleanup(repo, outside);
  }
});

test("runClaudeWorker: role-spec file (.omp/agents/<role>.md) missing -> exit 2, ERROR", () => {
  const repo = mkRepo();
  try {
    fs.writeFileSync(path.join(repo, "t.md"), "# task\n");
    const seam: ClaudeSeam = { run: () => ({ code: 0, stdout: "", stderr: "" }) };
    const r = runClaudeWorker(
      { role: "producer", task: path.join(repo, "t.md"), spec: path.join(repo, "s.md"), adr: path.join(repo, "a.md"), model: "sonnet", timeout: 10 },
      deps(repo, seam),
    );
    assert.equal(r.exitCode, 2);
    assert.match(r.stderrLines.join("\n"), /role-spec не найден/);
  } finally {
    cleanup(repo);
  }
});

test("runClaudeWorker: producer happy path — seam writes spec+adr -> exit 0, files reported", () => {
  const repo = mkRepo();
  try {
    fs.writeFileSync(path.join(repo, "t.md"), "# task\n");
    writeRoleFile(repo, "producer");
    const specPath = path.join(repo, "out", "spec.md");
    const adrPath = path.join(repo, "out", "adr.md");
    const seam: ClaudeSeam = {
      run: (args: ClaudeRunArgs) => {
        assert.equal(args.model, "sonnet");
        assert.equal(args.sysPrompt, "You are the producer.");
        fs.writeFileSync(specPath, "```spec\nid: SP-a\n```\n");
        fs.writeFileSync(adrPath, "```adr\nid: AD-a\n```\n");
        return { code: 0, stdout: JSON.stringify({ total_cost_usd: 0.05 }), stderr: "" };
      },
    };
    const r = runClaudeWorker(
      { role: "producer", task: path.join(repo, "t.md"), spec: specPath, adr: adrPath, model: "sonnet", timeout: 10 },
      deps(repo, seam),
    );
    assert.equal(r.exitCode, 0);
    const last = JSON.parse(r.stdoutLines[r.stdoutLines.length - 1] as string);
    assert.deepEqual(last.files.sort(), ["out/adr.md", "out/spec.md"]);
    assert.equal(last.missing.length, 0);
    assert.equal(last.cost_usd, 0.05);
  } finally {
    cleanup(repo);
  }
});

test("runClaudeWorker: producer did not write spec/adr -> exit 1, missing reported", () => {
  const repo = mkRepo();
  try {
    fs.writeFileSync(path.join(repo, "t.md"), "# task\n");
    writeRoleFile(repo, "producer");
    const seam: ClaudeSeam = { run: () => ({ code: 0, stdout: "{}", stderr: "" }) };
    const r = runClaudeWorker(
      { role: "producer", task: path.join(repo, "t.md"), spec: path.join(repo, "spec.md"), adr: path.join(repo, "adr.md"), model: "sonnet", timeout: 10 },
      deps(repo, seam),
    );
    assert.equal(r.exitCode, 1);
    assert.match(r.stderrLines.join("\n"), /ВОРКЕР не создал/);
  } finally {
    cleanup(repo);
  }
});

test("runClaudeWorker: claude binary not found (seam code=2) -> exit 2", () => {
  const repo = mkRepo();
  try {
    fs.writeFileSync(path.join(repo, "t.md"), "# task\n");
    writeRoleFile(repo, "producer");
    const seam: ClaudeSeam = { run: () => ({ code: 2, stdout: "", stderr: "ERROR: `claude` не найден в PATH" }) };
    const r = runClaudeWorker(
      { role: "producer", task: path.join(repo, "t.md"), spec: path.join(repo, "spec.md"), adr: path.join(repo, "adr.md"), model: "sonnet", timeout: 10 },
      deps(repo, seam),
    );
    assert.equal(r.exitCode, 2);
  } finally {
    cleanup(repo);
  }
});

test("runClaudeWorker: claude timeout (seam code=124) -> exit 2", () => {
  const repo = mkRepo();
  try {
    fs.writeFileSync(path.join(repo, "t.md"), "# task\n");
    writeRoleFile(repo, "producer");
    const seam: ClaudeSeam = { run: () => ({ code: 124, stdout: "", stderr: "ERROR: claude timeout (10s)" }) };
    const r = runClaudeWorker(
      { role: "producer", task: path.join(repo, "t.md"), spec: path.join(repo, "spec.md"), adr: path.join(repo, "adr.md"), model: "sonnet", timeout: 10 },
      deps(repo, seam),
    );
    assert.equal(r.exitCode, 2);
  } finally {
    cleanup(repo);
  }
});

test("runClaudeWorker: critic happy path — seam writes findings -> exit 0", () => {
  const repo = mkRepo();
  try {
    fs.writeFileSync(path.join(repo, "t.md"), "# task\n");
    writeRoleFile(repo, "critic");
    const findingsPath = path.join(repo, ".workflow", "ledger", "f.md");
    const seam: ClaudeSeam = {
      run: () => {
        fs.mkdirSync(path.dirname(findingsPath), { recursive: true });
        fs.writeFileSync(findingsPath, "[none] clean\n");
        return { code: 0, stdout: "{}", stderr: "" };
      },
    };
    const r = runClaudeWorker(
      { role: "critic", task: path.join(repo, "t.md"), spec: path.join(repo, "s.md"), adr: path.join(repo, "a.md"), findings: findingsPath, model: "sonnet", timeout: 10 },
      deps(repo, seam),
    );
    assert.equal(r.exitCode, 0);
  } finally {
    cleanup(repo);
  }
});
