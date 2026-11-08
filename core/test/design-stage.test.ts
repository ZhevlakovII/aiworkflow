import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

import { runDesignStage, type DesignStageDeps } from "../src/design/design-stage.ts";
import type { ClaudeSeam, ClaudeRunArgs, ClaudeRunResult } from "../src/design/claude-worker.ts";
import { nodeGitSeam, type GitSeam } from "../src/rails/git-seam.ts";
import type { ResolvedPolicy } from "../src/policy/policy.ts";
import type { RailLevel } from "../src/policy/profile.ts";

// ---------------------------------------------------------------------------
// Fixtures — real tmp git repo (same convention as rails.test.ts/rails-cli.
// test.ts: real git preferred over a mock). operator_zone/quality_gate are
// disabled in the test policy so `gatedCommit`'s internal zone-check/shell-
// gate never actually runs the generated `zone-check-cli.ts` line (that line
// assumes cwd=the real AIWorkflow repo, not an isolated tmp-repo — its OWN
// correctness is covered by `zone-check.test.ts` / `gate-setup.test.ts`,
// not re-tested here). This test file's scope is `runDesignStage`'s OWN
// orchestration: producer/gate_lint/[opt-in critic]/ledger/commit sequence
// and PASS/BOUNCE/blocker/claude-failure reactions (AD-critic-default-off-opt-in).
// ---------------------------------------------------------------------------

function mkRepoDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initRepo(): { dir: string; git: GitSeam } {
  const dir = mkRepoDir("design-stage-repo-");
  const git = nodeGitSeam(dir);
  assert.equal(git.run(["git", "init", "-q", "-b", "main"]).code, 0);
  git.run(["git", "config", "user.email", "test@example.com"]);
  git.run(["git", "config", "user.name", "Design Stage Test"]);
  fs.writeFileSync(path.join(dir, "README.md"), "init\n");
  // role-spec files (`.claude/agents/<role>.md` — `runDesignStage`'s default `portDir`, A1: this
  // driver is CC-native, `.claude/agents/` is the project overlay `resolveRolePrompt` looks up
  // first; a tmp-repo fixture is not the real repo's `.claude/`, so this does not touch it).
  fs.mkdirSync(path.join(dir, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", "agents", "producer.md"), "---\nid: producer\n---\n\nYou are the producer.\n");
  fs.writeFileSync(path.join(dir, ".claude", "agents", "critic.md"), "---\nid: critic\n---\n\nYou are the critic.\n");
  git.run(["git", "add", "-A"]);
  assert.equal(git.run(["git", "commit", "-q", "-m", "init"]).code, 0);
  return { dir, git };
}

function cleanup(...dirs: string[]): void {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

function makePolicy(overrides: Partial<{ rail: RailLevel }> = {}): ResolvedPolicy {
  return {
    profile: "guarded",
    quality_gate: { enabled: false, cmd: null },
    operator_zone: { enabled: false, protected: [] },
    rail: { level: overrides.rail ?? "commit", merge_needs_human: true },
    security_floor: { enabled: true },
  };
}

// task-file with an EXACT source line for the producer's SP source-ref: line 11.
const TASK_LINES = [
  "---",
  "id: dtest",
  "stage: design",
  "class: feature",
  "design-model: sonnet",
  'allow: ["docs/design/**"]',
  "---",
  "",
  "# Design Test Task",
  "",
  "THE SYSTEM SHALL do the thing.",
  "",
];
const TASK_TEXT = TASK_LINES.join("\n");
const SP_SOURCE_LINE = 11;

const TASK_OPT_IN_LINES = [
  "---",
  "id: dtest",
  "stage: design",
  "class: feature",
  "design-model: sonnet",
  "critic-opt-in: true",
  'allow: ["docs/design/**"]',
  "---",
  "",
  "# Design Test Task",
  "",
  "THE SYSTEM SHALL do the thing.",
  "",
];
const TASK_OPT_IN_TEXT = TASK_OPT_IN_LINES.join("\n");
const SP_SOURCE_LINE_OPT_IN = 12;

function writeTask(dir: string, text: string = TASK_TEXT): string {
  const taskPath = path.join(dir, "task.md");
  fs.writeFileSync(taskPath, text);
  return taskPath;
}

function validSpecAdr(taskRel: string, sourceLine: number = SP_SOURCE_LINE): { spec: string; adr: string } {
  return {
    spec: `\`\`\`spec\nid: SP-a\nsource: ${taskRel}#L${sourceLine}\nstatement: ok\n\`\`\`\n`,
    adr: `\`\`\`adr\nid: AD-a\ncovers: SP-a\nstatement: decision\n\`\`\`\n`,
  };
}

const BAD_SPEC = `\`\`\`spec\nid: SP-bad\nsource: task.md#L999\nstatement: bad ref\n\`\`\`\n`;
const BAD_ADR = `\`\`\`adr\nid: AD-bad\ncovers: SP-bad\nstatement: decision\n\`\`\`\n`;

// Fixed clock seam (contract: injectable `now()` -> deterministic ledger `date:` in tests).
const FIXED_DATE = "2030-01-02";

function deps(dir: string, git: GitSeam, claude: ClaudeSeam, policy: ResolvedPolicy): DesignStageDeps {
  return {
    repoRoot: dir,
    exists: fs.existsSync,
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
    claude,
    git,
    policy,
    now: () => FIXED_DATE,
  };
}

/** Stub ClaudeSeam: dispatches on the verbatim-ported prompt prefixes (producer vs critic). */
function makeSeam(opts: {
  producer: Array<(args: ClaudeRunArgs) => ClaudeRunResult>;
  critic?: (args: ClaudeRunArgs) => ClaudeRunResult;
}): { seam: ClaudeSeam; producerCalls: () => number; criticCalls: () => number } {
  let producerCount = 0;
  let criticCount = 0;
  const seam: ClaudeSeam = {
    run(args: ClaudeRunArgs): ClaudeRunResult {
      if (args.userPrompt.startsWith("Locked task-file")) {
        const idx = Math.min(producerCount, opts.producer.length - 1);
        producerCount++;
        return (opts.producer[idx] as (a: ClaudeRunArgs) => ClaudeRunResult)(args);
      }
      criticCount++;
      if (!opts.critic) return { code: 0, stdout: "{}", stderr: "" };
      return opts.critic(args);
    },
  };
  return { seam, producerCalls: () => producerCount, criticCalls: () => criticCount };
}

function okResult(): ClaudeRunResult {
  return { code: 0, stdout: JSON.stringify({ total_cost_usd: 0.01 }), stderr: "" };
}

function writeValidArtifacts(dir: string, taskRel: string, sourceLine: number = SP_SOURCE_LINE): void {
  const { spec, adr } = validSpecAdr(taskRel, sourceLine);
  fs.mkdirSync(path.join(dir, "docs", "design"), { recursive: true });
  fs.writeFileSync(path.join(dir, "docs", "design", "dtest-spec.md"), spec);
  fs.writeFileSync(path.join(dir, "docs", "design", "dtest-adr.md"), adr);
}

function writeCleanFindings(dir: string): void {
  const findingsPath = path.join(dir, ".workflow", "ledger", "dtest-findings.md");
  fs.mkdirSync(path.dirname(findingsPath), { recursive: true });
  fs.writeFileSync(findingsPath, "[none] clean\n");
}

// ---------------------------------------------------------------------------
// Default path: gate PASS, critic skipped -> lock + commit
// ---------------------------------------------------------------------------

test("runDesignStage: default (no opt-in) gate PASS -> critic skipped, exit 0, locked, committed", () => {
  const { dir, git } = initRepo();
  try {
    const taskPath = writeTask(dir);
    git.run(["git", "add", "-A"]);
    git.run(["git", "commit", "-q", "-m", "add task"]);
    const taskRel = "task.md";

    const { seam, criticCalls } = makeSeam({
      producer: [
        () => {
          writeValidArtifacts(dir, taskRel);
          return okResult();
        },
      ],
      critic: () => {
        writeCleanFindings(dir);
        return okResult();
      },
    });

    const result = runDesignStage(
      { taskPath, timeout: 10 },
      deps(dir, git, seam, makePolicy()),
    );

    assert.equal(result.exitCode, 0);
    assert.equal(criticCalls(), 0);
    assert.match(result.stdoutLines.join("\n"), /critic=skipped/);
    assert.match(result.stdoutLines.join("\n"), /DESIGN LOCKED/);
    assert.match(result.stdoutLines.join("\n"), /DESIGN STAGE: locked \+ committed\./);

    const log = git.run(["git", "log", "--oneline", "-1"]).stdout;
    assert.match(log, /design\(dtest\): spec\+ADR locked/);
    assert.match(log, /critic skipped/);
    assert.doesNotMatch(log, /critic clean/);

    const ledgerText = fs.readFileSync(path.join(dir, ".workflow", "ledger", "dtest.md"), "utf-8");
    assert.match(ledgerText, /status: locked/);
    assert.match(ledgerText, /Вердикт: \*\*PASS\*\*/);
    assert.match(ledgerText, /critic=skipped/);
    assert.match(ledgerText, new RegExp(`date: ${FIXED_DATE}`));
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Opt-in via options.critic: critic runs, clean -> lock
// ---------------------------------------------------------------------------

test("runDesignStage: options.critic opt-in + gate PASS + critic clean -> exit 0, critic called", () => {
  const { dir, git } = initRepo();
  try {
    const taskPath = writeTask(dir);
    git.run(["git", "add", "-A"]);
    git.run(["git", "commit", "-q", "-m", "add task"]);
    const taskRel = "task.md";

    const { seam, criticCalls } = makeSeam({
      producer: [
        () => {
          writeValidArtifacts(dir, taskRel);
          return okResult();
        },
      ],
      critic: () => {
        writeCleanFindings(dir);
        return okResult();
      },
    });

    const result = runDesignStage(
      { taskPath, timeout: 10, critic: true },
      deps(dir, git, seam, makePolicy()),
    );

    assert.equal(result.exitCode, 0);
    assert.equal(criticCalls(), 1);
    assert.match(result.stdoutLines.join("\n"), /DESIGN LOCKED/);

    const log = git.run(["git", "log", "--oneline", "-1"]).stdout;
    assert.match(log, /critic clean/);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Opt-in via frontmatter: critic blocker -> exit 1
// ---------------------------------------------------------------------------

test("runDesignStage: frontmatter critic-opt-in + gate PASS but critic blocker -> exit 1, no commit", () => {
  const { dir, git } = initRepo();
  try {
    const taskPath = writeTask(dir, TASK_OPT_IN_TEXT);
    git.run(["git", "add", "-A"]);
    git.run(["git", "commit", "-q", "-m", "add task"]);
    const taskRel = "task.md";
    const before = git.run(["git", "rev-parse", "HEAD"]).stdout.trim();

    const { seam, criticCalls } = makeSeam({
      producer: [
        () => {
          writeValidArtifacts(dir, taskRel, SP_SOURCE_LINE_OPT_IN);
          return okResult();
        },
      ],
      critic: () => {
        const findingsPath = path.join(dir, ".workflow", "ledger", "dtest-findings.md");
        fs.mkdirSync(path.dirname(findingsPath), { recursive: true });
        fs.writeFileSync(findingsPath, "[blocker] spec.md: level-boundary leakage\n[minor] adr.md: nit\n");
        return okResult();
      },
    });

    const result = runDesignStage({ taskPath, timeout: 10 }, deps(dir, git, seam, makePolicy()));

    assert.equal(result.exitCode, 1);
    assert.equal(criticCalls(), 1);
    assert.match(result.stdoutLines.join("\n"), /DESIGN BLOCKED: gate=PASS, blocking=1, minor=1/);
    assert.equal(git.run(["git", "rev-parse", "HEAD"]).stdout.trim(), before);

    const ledgerText = fs.readFileSync(path.join(dir, ".workflow", "ledger", "dtest.md"), "utf-8");
    assert.match(ledgerText, /status: blocked/);
    assert.match(ledgerText, /Blocking \(blocker\/major\):/);
    assert.match(ledgerText, /Non-blocking \(minor\):/);
    assert.match(ledgerText, new RegExp(`date: ${FIXED_DATE}`));
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// BOUNCE -> retry -> PASS (default: critic skipped)
// ---------------------------------------------------------------------------

test("runDesignStage: BOUNCE on attempt 1, PASS on retry with notes -> exit 0, committed", () => {
  const { dir, git } = initRepo();
  try {
    const taskPath = writeTask(dir);
    git.run(["git", "add", "-A"]);
    git.run(["git", "commit", "-q", "-m", "add task"]);
    const taskRel = "task.md";
    const specPath = path.join(dir, "docs", "design", "dtest-spec.md");
    const adrPath = path.join(dir, "docs", "design", "dtest-adr.md");

    const { seam, criticCalls } = makeSeam({
      producer: [
        (args) => {
          assert.doesNotMatch(args.userPrompt, /ИСПРАВЬ по замечаниям/);
          fs.mkdirSync(path.dirname(specPath), { recursive: true });
          fs.writeFileSync(specPath, BAD_SPEC);
          fs.writeFileSync(adrPath, BAD_ADR);
          return okResult();
        },
        (args) => {
          assert.match(args.userPrompt, /ИСПРАВЬ по замечаниям прошлого прохода/);
          const { spec, adr } = validSpecAdr(taskRel);
          fs.writeFileSync(specPath, spec);
          fs.writeFileSync(adrPath, adr);
          return okResult();
        },
      ],
    });

    const result = runDesignStage({ taskPath, timeout: 10 }, deps(dir, git, seam, makePolicy()));

    assert.equal(result.exitCode, 0);
    assert.equal(criticCalls(), 0);
    assert.match(result.stdoutLines.join("\n"), /BOUNCE \(попытка 1\)/);
    const log = git.run(["git", "log", "--oneline", "-1"]).stdout;
    assert.match(log, /design\(dtest\)/);
    assert.match(log, /critic skipped/);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// BOUNCE x2 exhausted -> exit 1, no commit (critic still skipped)
// ---------------------------------------------------------------------------

test("runDesignStage: BOUNCE on both attempts -> exit 1, blocked, no commit", () => {
  const { dir, git } = initRepo();
  try {
    const taskPath = writeTask(dir);
    git.run(["git", "add", "-A"]);
    git.run(["git", "commit", "-q", "-m", "add task"]);
    const specPath = path.join(dir, "docs", "design", "dtest-spec.md");
    const adrPath = path.join(dir, "docs", "design", "dtest-adr.md");
    const before = git.run(["git", "rev-parse", "HEAD"]).stdout.trim();

    const alwaysBad = (): ClaudeRunResult => {
      fs.mkdirSync(path.dirname(specPath), { recursive: true });
      fs.writeFileSync(specPath, BAD_SPEC);
      fs.writeFileSync(adrPath, BAD_ADR);
      return okResult();
    };
    const { seam, criticCalls } = makeSeam({
      producer: [alwaysBad, alwaysBad],
    });

    const result = runDesignStage({ taskPath, timeout: 10 }, deps(dir, git, seam, makePolicy()));

    assert.equal(result.exitCode, 1);
    assert.equal(criticCalls(), 0);
    assert.match(result.stdoutLines.join("\n"), /BOUNCE \(попытка 1\) → retry producer с findings/);
    assert.match(result.stdoutLines.join("\n"), /BOUNCE \(попытка 2\) → исчерпано/);
    assert.match(result.stdoutLines.join("\n"), /DESIGN BLOCKED/);
    assert.equal(git.run(["git", "rev-parse", "HEAD"]).stdout.trim(), before);

    const ledgerText = fs.readFileSync(path.join(dir, ".workflow", "ledger", "dtest.md"), "utf-8");
    assert.match(ledgerText, /status: blocked/);
    assert.match(ledgerText, /critic=skipped/);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Opt-in bounce path: BOUNCE then PASS then critic clean
// ---------------------------------------------------------------------------

test("runDesignStage: opt-in + BOUNCE then PASS + critic clean -> exit 0", () => {
  const { dir, git } = initRepo();
  try {
    const taskPath = writeTask(dir, TASK_OPT_IN_TEXT);
    git.run(["git", "add", "-A"]);
    git.run(["git", "commit", "-q", "-m", "add task"]);
    const taskRel = "task.md";
    const specPath = path.join(dir, "docs", "design", "dtest-spec.md");
    const adrPath = path.join(dir, "docs", "design", "dtest-adr.md");

    const { seam, criticCalls } = makeSeam({
      producer: [
        () => {
          fs.mkdirSync(path.dirname(specPath), { recursive: true });
          fs.writeFileSync(specPath, BAD_SPEC);
          fs.writeFileSync(adrPath, BAD_ADR);
          return okResult();
        },
        () => {
          const { spec, adr } = validSpecAdr(taskRel, SP_SOURCE_LINE_OPT_IN);
          fs.writeFileSync(specPath, spec);
          fs.writeFileSync(adrPath, adr);
          return okResult();
        },
      ],
      critic: () => {
        writeCleanFindings(dir);
        return okResult();
      },
    });

    const result = runDesignStage({ taskPath, timeout: 10 }, deps(dir, git, seam, makePolicy()));

    assert.equal(result.exitCode, 0);
    assert.equal(criticCalls(), 1);
    assert.match(result.stdoutLines.join("\n"), /BOUNCE \(попытка 1\)/);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// claude failure -> exit 2, critic never invoked, no ledger
// ---------------------------------------------------------------------------

test("runDesignStage: producer worker fails to launch (claude not found) -> exit 2, no critic, no ledger", () => {
  const { dir, git } = initRepo();
  try {
    const taskPath = writeTask(dir);
    git.run(["git", "add", "-A"]);
    git.run(["git", "commit", "-q", "-m", "add task"]);

    const { seam, criticCalls } = makeSeam({
      producer: [() => ({ code: 2, stdout: "", stderr: "ERROR: `claude` не найден в PATH" })],
    });

    const result = runDesignStage({ taskPath, timeout: 10 }, deps(dir, git, seam, makePolicy()));

    assert.equal(result.exitCode, 2);
    assert.equal(criticCalls(), 0);
    assert.equal(fs.existsSync(path.join(dir, ".workflow", "ledger", "dtest.md")), false);
  } finally {
    cleanup(dir);
  }
});
