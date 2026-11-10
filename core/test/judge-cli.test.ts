import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { resolvePolicy, type ResolvedPolicy } from "../src/policy/policy.ts";
import { runJudgeCli, type JudgeCliDeps } from "../src/stage/judge-cli.ts";
import { appendEvent, artifactHash, contractKey12, readJournal, resolveContractKey } from "../src/stage/journal.ts";

function makeTmp(): string {
  return mkdtempSync(nodePath.join(tmpdir(), "aiwf-judge-cli-"));
}

function depsFor(dir: string): JudgeCliDeps {
  return {
    cwd: dir,
    exists: existsSync,
    readFile: (p) => readFileSync(p, "utf-8"),
    now: () => "2026-09-24T12:00:00.000Z",
  };
}

function ck12Of(dir: string, taskPath: string): string {
  const text = readFileSync(taskPath, "utf-8");
  const r = resolveContractKey(text, {
    repoRoot: dir,
    taskPath,
    exists: existsSync,
    readFile: (p) => readFileSync(p, "utf-8"),
  });
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  return r.ok ? r.ck12 : "";
}


/** Task body line "# Judge test" — source line depends on frontmatter length. */
function writeTask(dir: string, name = "task.md", extraFm: string[] = []): string {
  const p = nodePath.join(dir, name);
  const lines = [
    "---",
    "id: jtest",
    "stage: design",
    "class: feature",
    ...extraFm,
    "---",
    "",
    "# Judge test",
    "",
  ];
  writeFileSync(p, lines.join("\n"), "utf-8");
  return p;
}

function judgeSourceLine(extraFm: string[] = []): number {
  // 1:--- 2:id 3:stage 4:class + extras + ---: + blank + "# Judge test"
  return 4 + extraFm.length + 1 + 1 + 1; // --- after extras, blank, body
}

function writeValidArtifacts(
  dir: string,
  taskRel = "task.md",
  extraFm: string[] = [],
  opts?: { badSource?: boolean },
): { spec: string; adr: string; specRel: string; adrRel: string } {
  const srcLine = opts?.badSource ? 999 : judgeSourceLine(extraFm);
  const spec = [
    "```spec",
    "id: SP-j",
    `source: ${taskRel}#L${srcLine}`,
    "statement: judge requirement",
    "```",
    "",
  ].join("\n");
  const adr = [
    "```adr",
    "id: AD-j",
    "covers: SP-j",
    "statement: judge decision",
    "```",
    "",
  ].join("\n");
  mkdirSync(nodePath.join(dir, "docs", "design"), { recursive: true });
  const specRel = "docs/design/jtest-spec.md";
  const adrRel = "docs/design/jtest-adr.md";
  writeFileSync(nodePath.join(dir, specRel), spec, "utf-8");
  writeFileSync(nodePath.join(dir, adrRel), adr, "utf-8");
  return { spec, adr, specRel, adrRel };
}

test("judge --help / no-args -> usage exit 2", () => {
  const dir = makeTmp();
  try {
    const deps = depsFor(dir);
    assert.equal(runJudgeCli([], deps).exitCode, 2);
    assert.equal(runJudgeCli(["--help"], deps).exitCode, 2);
    assert.match(runJudgeCli(["--help"], deps).stdout, /design-begin/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("default off: begin → gate PASS → lock succeeds without critic event", () => {
  const dir = makeTmp();
  try {
    const task = writeTask(dir);
    const arts = writeValidArtifacts(dir);
    const deps = depsFor(dir);
    const relTask = "task.md";

    const begin = runJudgeCli(["design-begin", "--task", relTask], deps);
    assert.equal(begin.exitCode, 0, begin.stderr);

    const gate = runJudgeCli(
      ["design-gate-record", "--task", relTask, "--verdict", "PASS"],
      deps,
    );
    assert.equal(gate.exitCode, 0, gate.stderr);

    const lock = runJudgeCli(["design-lock", "--task", relTask], deps);
    assert.equal(lock.exitCode, 0, lock.stderr);
    assert.match(lock.stdout, /design-lock ok/);

    const ck12 = contractKey12(deps.readFile(task));
    const events = readJournal(dir, ck12, "design");
    assert.deepEqual(
      events.map((e) => e.type),
      ["design-begin", "design-gate", "design-lock"],
    );
    assert.equal(events[0]!.critic_opt_in, false);
    // B3/B3.1: design-lock records posix spec+adr + hashes.
    const lockEv = events[2]!;
    assert.equal(lockEv.spec, "docs/design/jtest-spec.md");
    assert.equal(lockEv.adr, "docs/design/jtest-adr.md");
    assert.equal(lockEv.specHash, artifactHash(arts.spec));
    assert.equal(lockEv.adrHash, artifactHash(arts.adr));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("happy path with critic record still locks when default off", () => {
  const dir = makeTmp();
  try {
    const task = writeTask(dir);
    writeValidArtifacts(dir);
    const findings = nodePath.join(dir, "findings.md");
    writeFileSync(findings, "[none] clean\n", "utf-8");
    const deps = depsFor(dir);
    const relTask = "task.md";

    assert.equal(runJudgeCli(["design-begin", "--task", relTask], deps).exitCode, 0);
    assert.equal(
      runJudgeCli(["design-gate-record", "--task", relTask, "--verdict", "PASS"], deps).exitCode,
      0,
    );
    assert.equal(
      runJudgeCli(
        ["design-critic-record", "--task", relTask, "--findings", "findings.md"],
        deps,
      ).exitCode,
      0,
    );

    const lock = runJudgeCli(["design-lock", "--task", relTask], deps);
    assert.equal(lock.exitCode, 0, lock.stderr);

    const ck12 = contractKey12(deps.readFile(task));
    const events = readJournal(dir, ck12, "design");
    assert.deepEqual(
      events.map((e) => e.type),
      ["design-begin", "design-gate", "design-critic", "design-lock"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opt-in task without critic-record → design-lock blocked", () => {
  const dir = makeTmp();
  try {
    writeTask(dir, "task.md", ["critic-opt-in: true"]);
    const deps = depsFor(dir);
    assert.equal(runJudgeCli(["design-begin", "--task", "task.md"], deps).exitCode, 0);
    assert.equal(
      runJudgeCli(["design-gate-record", "--task", "task.md", "--verdict", "PASS"], deps).exitCode,
      0,
    );
    const lock = runJudgeCli(["design-lock", "--task", "task.md"], deps);
    assert.equal(lock.exitCode, 1);
    assert.match(lock.stderr, /critic opted-in but no design-critic/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opt-in + critic clean → design-lock succeeds", () => {
  const dir = makeTmp();
  try {
    const extra = ["critic: on"];
    const task = writeTask(dir, "task.md", extra);
    writeValidArtifacts(dir, "task.md", extra);
    writeFileSync(nodePath.join(dir, "findings.md"), "[none] clean\n", "utf-8");
    const deps = depsFor(dir);

    assert.equal(runJudgeCli(["design-begin", "--task", "task.md"], deps).exitCode, 0);
    const ck12 = contractKey12(deps.readFile(task));
    const beginEv = readJournal(dir, ck12, "design")[0]!;
    assert.equal(beginEv.critic_opt_in, true);

    assert.equal(
      runJudgeCli(["design-gate-record", "--task", "task.md", "--verdict", "PASS"], deps).exitCode,
      0,
    );
    assert.equal(
      runJudgeCli(
        ["design-critic-record", "--task", "task.md", "--findings", "findings.md"],
        deps,
      ).exitCode,
      0,
    );
    const lock = runJudgeCli(["design-lock", "--task", "task.md"], deps);
    assert.equal(lock.exitCode, 0, lock.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("design-lock records specHash/adrHash matching current files", () => {
  const dir = makeTmp();
  try {
    const task = writeTask(dir);
    const arts = writeValidArtifacts(dir);
    const deps = depsFor(dir);
    assert.equal(runJudgeCli(["design-begin", "--task", "task.md"], deps).exitCode, 0);
    assert.equal(
      runJudgeCli(["design-gate-record", "--task", "task.md", "--verdict", "PASS"], deps).exitCode,
      0,
    );
    const lock = runJudgeCli(["design-lock", "--task", "task.md"], deps);
    assert.equal(lock.exitCode, 0, lock.stderr);

    const ck12 = contractKey12(deps.readFile(task));
    const lockEv = readJournal(dir, ck12, "design").find((e) => e.type === "design-lock")!;
    assert.equal(typeof lockEv.specHash, "string");
    assert.equal(typeof lockEv.adrHash, "string");
    assert.equal(lockEv.specHash, artifactHash(arts.spec));
    assert.equal(lockEv.adrHash, artifactHash(arts.adr));
    assert.match(lockEv.specHash as string, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("design-lock blocked if current files fail gateLint even when journal has PASS", () => {
  const dir = makeTmp();
  try {
    writeTask(dir);
    writeValidArtifacts(dir, "task.md", [], { badSource: true });
    const deps = depsFor(dir);
    assert.equal(runJudgeCli(["design-begin", "--task", "task.md"], deps).exitCode, 0);
    assert.equal(
      runJudgeCli(["design-gate-record", "--task", "task.md", "--verdict", "PASS"], deps).exitCode,
      0,
    );
    const lock = runJudgeCli(["design-lock", "--task", "task.md"], deps);
    assert.equal(lock.exitCode, 1);
    assert.match(lock.stderr, /design-lock blocked: gate recount/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bounce without PASS → design-lock fails (exit 1)", () => {
  const dir = makeTmp();
  try {
    writeTask(dir);
    const deps = depsFor(dir);
    assert.equal(runJudgeCli(["design-begin", "--task", "task.md"], deps).exitCode, 0);
    assert.equal(
      runJudgeCli(["design-gate-record", "--task", "task.md", "--verdict", "BOUNCE"], deps)
        .exitCode,
      0,
    );
    const lock = runJudgeCli(["design-lock", "--task", "task.md"], deps);
    assert.equal(lock.exitCode, 1);
    assert.match(lock.stderr, /no design-gate PASS/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("blocking critic findings → design-lock fails (exit 1) even when default off", () => {
  const dir = makeTmp();
  try {
    writeTask(dir);
    mkdirSync(nodePath.join(dir, "out"), { recursive: true });
    writeFileSync(nodePath.join(dir, "out", "findings.md"), "[blocker] hole\n", "utf-8");
    const deps = depsFor(dir);
    assert.equal(runJudgeCli(["design-begin", "--task", "task.md"], deps).exitCode, 0);
    assert.equal(
      runJudgeCli(["design-gate-record", "--task", "task.md", "--verdict", "PASS"], deps).exitCode,
      0,
    );
    assert.equal(
      runJudgeCli(
        ["design-critic-record", "--task", "task.md", "--findings", "out/findings.md"],
        deps,
      ).exitCode,
      0,
    );
    const lock = runJudgeCli(["design-lock", "--task", "task.md"], deps);
    assert.equal(lock.exitCode, 1);
    assert.match(lock.stderr, /blocking findings/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opt-in + blocking critic → design-lock fails", () => {
  const dir = makeTmp();
  try {
    writeTask(dir, "task.md", ["critic-opt-in: true"]);
    mkdirSync(nodePath.join(dir, "out"), { recursive: true });
    writeFileSync(nodePath.join(dir, "out", "findings.md"), "[major] gap\n", "utf-8");
    const deps = depsFor(dir);
    assert.equal(runJudgeCli(["design-begin", "--task", "task.md"], deps).exitCode, 0);
    assert.equal(
      runJudgeCli(["design-gate-record", "--task", "task.md", "--verdict", "PASS"], deps).exitCode,
      0,
    );
    assert.equal(
      runJudgeCli(
        ["design-critic-record", "--task", "task.md", "--findings", "out/findings.md"],
        deps,
      ).exitCode,
      0,
    );
    const lock = runJudgeCli(["design-lock", "--task", "task.md"], deps);
    assert.equal(lock.exitCode, 1);
    assert.match(lock.stderr, /blocking findings/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing --task / unknown command → exit 2", () => {
  const dir = makeTmp();
  try {
    const deps = depsFor(dir);
    assert.equal(runJudgeCli(["design-begin"], deps).exitCode, 2);
    assert.equal(runJudgeCli(["nope", "--task", "x"], deps).exitCode, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeExecuteTask(
  dir: string,
  name = "exec.md",
  extraFm: string[] = [],
): string {
  const p = nodePath.join(dir, name);
  writeFileSync(
    p,
    ["---", "id: etest", "stage: execute", "class: feature", ...extraFm, "---", "", "# Exec judge test", ""].join(
      "\n",
    ),
    "utf-8",
  );
  return p;
}

function writeScaffoldTask(
  dir: string,
  name = "scaffold.md",
  extraFm: string[] = [],
): string {
  const p = nodePath.join(dir, name);
  writeFileSync(
    p,
    [
      "---",
      "id: stest",
      "stage: scaffold",
      "class: feature",
      "scaffold: on",
      ...extraFm,
      "---",
      "",
      "# Scaffold judge test",
      "",
    ].join("\n"),
    "utf-8",
  );
  return p;
}

/** Seed design-lock (+ optional scaffold-done ok) for the task's resolved ck12. */
function seedDesignLock(
  dir: string,
  taskPath: string,
  ts = "2026-09-24T12:00:00.000Z",
): string {
  const ck12 = ck12Of(dir, taskPath);
  appendEvent(dir, ck12, "design", { type: "design-lock", ts });
  return ck12;
}

function seedLockAndScaffoldOk(
  dir: string,
  taskPath: string,
  ts = "2026-09-24T12:00:00.000Z",
): string {
  const ck12 = seedDesignLock(dir, taskPath, ts);
  appendEvent(dir, ck12, "scaffold", {
    type: "scaffold-started",
    task: nodePath.basename(taskPath),
    contract_key: ck12,
    ts,
  });
  appendEvent(dir, ck12, "scaffold", { type: "scaffold-done", outcome: "ok", ts });
  return ck12;
}

function lockViaJudge(dir: string, relTask = "task.md"): void {
  writeValidArtifacts(dir, relTask);
  const deps = depsFor(dir);
  assert.equal(runJudgeCli(["design-begin", "--task", relTask], deps).exitCode, 0);
  assert.equal(
    runJudgeCli(["design-gate-record", "--task", relTask, "--verdict", "PASS"], deps).exitCode,
    0,
  );
  const lock = runJudgeCli(["design-lock", "--task", relTask], deps);
  assert.equal(lock.exitCode, 0, lock.stderr);
}

test("judge --help lists scaffold + execute commands", () => {
  const dir = makeTmp();
  try {
    const help = runJudgeCli(["--help"], depsFor(dir));
    assert.equal(help.exitCode, 2);
    assert.match(help.stdout, /scaffold-begin/);
    assert.match(help.stdout, /scaffold-done/);
    assert.match(help.stdout, /execute-begin/);
    assert.match(help.stdout, /execute-done/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scaffold-begin wrong stage MISROUTE", () => {
  const dir = makeTmp();
  try {
    writeTask(dir);
    const begin = runJudgeCli(["scaffold-begin", "--task", "task.md"], depsFor(dir));
    assert.equal(begin.exitCode, 1);
    assert.match(begin.stderr, /MISROUTE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scaffold-begin lever off refuses and writes nothing", () => {
  const dir = makeTmp();
  try {
    writeTask(dir);
    lockViaJudge(dir);
    const sc = nodePath.join(dir, "scaffold.md");
    writeFileSync(
      sc,
      ["---", "id: s", "stage: scaffold", "class: feature", "binds: task.md", "---", "", "# S", ""].join("\n"),
      "utf-8",
    );
    const begin = runJudgeCli(["scaffold-begin", "--task", "scaffold.md"], depsFor(dir));
    assert.equal(begin.exitCode, 1);
    assert.match(begin.stderr, /scaffold lever is off/);
    const ck = ck12Of(dir, sc);
    assert.deepEqual(readJournal(dir, ck, "scaffold"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scaffold-begin without design-lock is blocked (exit 1)", () => {
  const dir = makeTmp();
  try {
    writeTask(dir);
    writeScaffoldTask(dir, "scaffold.md", ["binds: task.md"]);
    const deps = depsFor(dir);
    const begin = runJudgeCli(["scaffold-begin", "--task", "scaffold.md"], deps);
    assert.equal(begin.exitCode, 1);
    assert.match(begin.stderr, /no design-lock/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("execute-begin wrong stage MISROUTE", () => {
  const dir = makeTmp();
  try {
    writeTask(dir);
    const begin = runJudgeCli(["execute-begin", "--task", "task.md"], depsFor(dir));
    assert.equal(begin.exitCode, 1);
    assert.match(begin.stderr, /MISROUTE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("execute-begin scaffold off without design-lock is blocked", () => {
  const dir = makeTmp();
  try {
    writeExecuteTask(dir);
    const deps = depsFor(dir);
    const begin = runJudgeCli(["execute-begin", "--task", "exec.md"], deps);
    assert.equal(begin.exitCode, 1);
    assert.match(begin.stderr, /no design-lock/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("execute-begin scaffold off with design-lock does not require scaffold-done", () => {
  const dir = makeTmp();
  try {
    writeTask(dir);
    lockViaJudge(dir);
    writeExecuteTask(dir, "exec.md", ["binds: task.md"]);
    const deps = depsFor(dir);
    const begin = runJudgeCli(["execute-begin", "--task", "exec.md"], deps);
    assert.equal(begin.exitCode, 0, begin.stderr);
    const ck = ck12Of(dir, nodePath.join(dir, "exec.md"));
    assert.equal(readJournal(dir, ck, "execute")[0]!.type, "exec-started");
    // no fabricated scaffold journal
    assert.deepEqual(readJournal(dir, ck, "scaffold"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("execute-begin scaffold on without scaffold-done ok is blocked", () => {
  const dir = makeTmp();
  try {
    writeTask(dir);
    lockViaJudge(dir);
    writeExecuteTask(dir, "exec.md", ["binds: task.md", "scaffold: on"]);
    const begin = runJudgeCli(["execute-begin", "--task", "exec.md"], depsFor(dir));
    assert.equal(begin.exitCode, 1);
    assert.match(begin.stderr, /no scaffold-done outcome=ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("execute-begin blocked when scaffold-done outcome=violation", () => {
  const dir = makeTmp();
  try {
    writeTask(dir);
    lockViaJudge(dir);
    const task = writeExecuteTask(dir, "exec.md", ["binds: task.md", "scaffold: on"]);
    const ck12 = ck12Of(dir, task);
    appendEvent(dir, ck12, "scaffold", {
      type: "scaffold-started",
      ts: "2026-09-24T12:00:00.000Z",
    });
    appendEvent(dir, ck12, "scaffold", {
      type: "scaffold-done",
      outcome: "violation",
      ts: "2026-09-24T12:00:00.000Z",
    });
    const begin = runJudgeCli(["execute-begin", "--task", "exec.md"], depsFor(dir));
    assert.equal(begin.exitCode, 1);
    assert.match(begin.stderr, /no scaffold-done outcome=ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("happy path: design-lock → scaffold → execute (shared binds key)", () => {
  const dir = makeTmp();
  try {
    writeTask(dir);
    lockViaJudge(dir);
    writeScaffoldTask(dir, "scaffold.md", ["binds: task.md"]);
    writeExecuteTask(dir, "exec.md", ["binds: task.md", "scaffold: on"]);
    const deps = depsFor(dir);

    const sBegin = runJudgeCli(["scaffold-begin", "--task", "scaffold.md"], deps);
    assert.equal(sBegin.exitCode, 0, sBegin.stderr);
    assert.match(sBegin.stdout, /scaffold-begin ok/);

    const sDone = runJudgeCli(["scaffold-done", "--task", "scaffold.md", "--outcome", "ok"], deps);
    assert.equal(sDone.exitCode, 0, sDone.stderr);
    assert.match(sDone.stdout, /scaffold-done ok outcome=ok/);

    const eBegin = runJudgeCli(["execute-begin", "--task", "exec.md"], deps);
    assert.equal(eBegin.exitCode, 0, eBegin.stderr);
    assert.match(eBegin.stdout, /execute-begin ok/);

    const eDone = runJudgeCli(["execute-done", "--task", "exec.md", "--outcome", "ok"], deps);
    assert.equal(eDone.exitCode, 0, eDone.stderr);

    const ck12 = ck12Of(dir, nodePath.join(dir, "exec.md"));
    assert.equal(ck12, ck12Of(dir, nodePath.join(dir, "task.md")));
    assert.deepEqual(
      readJournal(dir, ck12, "scaffold").map((e) => e.type),
      ["scaffold-started", "scaffold-done"],
    );
    assert.equal(readJournal(dir, ck12, "scaffold")[1]!.outcome, "ok");
    assert.deepEqual(
      readJournal(dir, ck12, "execute").map((e) => e.type),
      ["exec-started", "exec-done"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scaffold-done without scaffold-started is blocked (exit 1)", () => {
  const dir = makeTmp();
  try {
    writeTask(dir);
    lockViaJudge(dir);
    writeScaffoldTask(dir, "scaffold.md", ["binds: task.md"]);
    const deps = depsFor(dir);
    const done = runJudgeCli(["scaffold-done", "--task", "scaffold.md", "--outcome", "ok"], deps);
    assert.equal(done.exitCode, 1);
    assert.match(done.stderr, /no scaffold-started/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("execute-begin appends exec-started on execute journal (not design)", () => {
  const dir = makeTmp();
  try {
    writeTask(dir);
    lockViaJudge(dir);
    const task = writeExecuteTask(dir, "exec.md", ["binds: task.md", "scaffold: on"]);
    seedLockAndScaffoldOk(dir, task);
    const deps = depsFor(dir);
    const begin = runJudgeCli(["execute-begin", "--task", "exec.md"], deps);
    assert.equal(begin.exitCode, 0, begin.stderr);
    assert.match(begin.stdout, /execute-begin ok/);

    const ck12 = ck12Of(dir, task);
    const execEvents = readJournal(dir, ck12, "execute");
    assert.equal(execEvents.length, 1);
    assert.equal(execEvents[0]!.type, "exec-started");
    assert.equal(execEvents[0]!.task, "exec.md");
    assert.equal(execEvents[0]!.contract_key, ck12);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("execute-done without exec-started is blocked (exit 1)", () => {
  const dir = makeTmp();
  try {
    writeExecuteTask(dir);
    const deps = depsFor(dir);
    const done = runJudgeCli(["execute-done", "--task", "exec.md", "--outcome", "ok"], deps);
    assert.equal(done.exitCode, 1);
    assert.match(done.stderr, /no exec-started/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("execute-begin → execute-done ok records exec-done", () => {
  const dir = makeTmp();
  try {
    writeTask(dir);
    lockViaJudge(dir);
    const task = writeExecuteTask(dir, "exec.md", ["binds: task.md"]);
    seedDesignLock(dir, task);
    const deps = depsFor(dir);
    assert.equal(runJudgeCli(["execute-begin", "--task", "exec.md"], deps).exitCode, 0);
    const done = runJudgeCli(["execute-done", "--task", "exec.md", "--outcome", "ok"], deps);
    assert.equal(done.exitCode, 0, done.stderr);
    const ck12 = ck12Of(dir, task);
    const events = readJournal(dir, ck12, "execute");
    assert.deepEqual(
      events.map((e) => e.type),
      ["exec-started", "exec-done"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("execute-done outcome=violation is recorded", () => {
  const dir = makeTmp();
  try {
    writeTask(dir);
    lockViaJudge(dir);
    const task = writeExecuteTask(dir, "exec.md", ["binds: task.md"]);
    seedDesignLock(dir, task);
    const deps = depsFor(dir);
    assert.equal(runJudgeCli(["execute-begin", "--task", "exec.md"], deps).exitCode, 0);
    const done = runJudgeCli(["execute-done", "--task", "exec.md", "--outcome", "violation"], deps);
    assert.equal(done.exitCode, 0, done.stderr);
    assert.match(done.stdout, /outcome=violation/);
    const ck12 = ck12Of(dir, task);
    const events = readJournal(dir, ck12, "execute");
    assert.equal(events[1]!.type, "exec-done");
    assert.equal(events[1]!.outcome, "violation");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("execute-done missing / invalid --outcome → exit 2", () => {
  const dir = makeTmp();
  try {
    writeExecuteTask(dir);
    const deps = depsFor(dir);
    assert.equal(runJudgeCli(["execute-done", "--task", "exec.md"], deps).exitCode, 2);
    assert.equal(
      runJudgeCli(["execute-done", "--task", "exec.md", "--outcome", "nope"], deps).exitCode,
      2,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("execute-begin class trivial scaffold off skips design-lock", () => {
  const dir = makeTmp();
  try {
    const p = nodePath.join(dir, "exec.md");
    writeFileSync(
      p,
      ["---", "id: t", "stage: execute", "class: trivial", "---", "", "# T", ""].join("\n"),
      "utf-8",
    );
    const begin = runJudgeCli(["execute-begin", "--task", "exec.md"], depsFor(dir));
    assert.equal(begin.exitCode, 0, begin.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("execute-begin class trivial scaffold on still requires design-lock", () => {
  const dir = makeTmp();
  try {
    const p = nodePath.join(dir, "exec.md");
    writeFileSync(
      p,
      ["---", "id: t", "stage: execute", "class: trivial", "scaffold: on", "---", "", "# T", ""].join("\n"),
      "utf-8",
    );
    const begin = runJudgeCli(["execute-begin", "--task", "exec.md"], depsFor(dir));
    assert.equal(begin.exitCode, 1);
    assert.match(begin.stderr, /no design-lock/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Contract B — by:judge mutual exclusion on scaffold/execute begin
// ---------------------------------------------------------------------------

function writeActiveZone(
  dir: string,
  body: { task: string; allow: string[]; deny?: string[]; by?: string },
): void {
  mkdirSync(nodePath.join(dir, ".workflow"), { recursive: true });
  writeFileSync(
    nodePath.join(dir, ".workflow", "active-zone.json"),
    JSON.stringify(body),
    "utf-8",
  );
}

test("scaffold-begin blocked on legacy lead zone (by absent)", () => {
  const dir = makeTmp();
  try {
    writeTask(dir);
    lockViaJudge(dir);
    writeScaffoldTask(dir, "scaffold.md", ["binds: task.md"]);
    writeActiveZone(dir, { task: "jtest", allow: ["core/**"] });
    const begin = runJudgeCli(["scaffold-begin", "--task", "scaffold.md"], depsFor(dir));
    assert.equal(begin.exitCode, 1);
    assert.match(begin.stderr, /legacy lead zone|by≠judge|by!=judge/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scaffold-begin allowed on by:judge zone", () => {
  const dir = makeTmp();
  try {
    writeTask(dir);
    lockViaJudge(dir);
    writeScaffoldTask(dir, "scaffold.md", ["binds: task.md"]);
    writeActiveZone(dir, { task: "jtest", allow: ["core/**"], by: "judge" });
    const begin = runJudgeCli(["scaffold-begin", "--task", "scaffold.md"], depsFor(dir));
    assert.equal(begin.exitCode, 0, begin.stderr);
    assert.match(begin.stdout, /scaffold-begin ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scaffold-begin allowed when active-zone absent", () => {
  const dir = makeTmp();
  try {
    writeTask(dir);
    lockViaJudge(dir);
    writeScaffoldTask(dir, "scaffold.md", ["binds: task.md"]);
    const begin = runJudgeCli(["scaffold-begin", "--task", "scaffold.md"], depsFor(dir));
    assert.equal(begin.exitCode, 0, begin.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("execute-begin blocked on legacy lead zone", () => {
  const dir = makeTmp();
  try {
    writeTask(dir);
    lockViaJudge(dir);
    writeExecuteTask(dir, "exec.md", ["binds: task.md"]);
    writeActiveZone(dir, { task: "jtest", allow: ["core/**"], by: "lead" });
    const begin = runJudgeCli(["execute-begin", "--task", "exec.md"], depsFor(dir));
    assert.equal(begin.exitCode, 1);
    assert.match(begin.stderr, /legacy lead zone|by≠judge|by!=judge/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("execute-begin allowed on by:judge zone", () => {
  const dir = makeTmp();
  try {
    writeTask(dir);
    lockViaJudge(dir);
    writeExecuteTask(dir, "exec.md", ["binds: task.md"]);
    writeActiveZone(dir, { task: "jtest", allow: ["core/**"], by: "judge" });
    const begin = runJudgeCli(["execute-begin", "--task", "exec.md"], depsFor(dir));
    assert.equal(begin.exitCode, 0, begin.stderr);
    assert.match(begin.stdout, /execute-begin ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("design-needs-human records reason; unknown reason exit 2", () => {
  const dir = makeTmp();
  try {
    writeTask(dir);
    const deps = depsFor(dir);
    const ok = runJudgeCli(
      ["design-needs-human", "--task", "task.md", "--reason", "gate"],
      deps,
    );
    assert.equal(ok.exitCode, 0, ok.stderr);
    const ck12 = contractKey12(readFileSync(nodePath.join(dir, "task.md"), "utf-8"));
    const events = readJournal(dir, ck12, "design");
    const nh = events.find((e) => e.type === "needs-human");
    assert.equal(nh?.reason, "gate");

    const bad = runJudgeCli(
      ["design-needs-human", "--task", "task.md", "--reason", "nope"],
      deps,
    );
    assert.equal(bad.exitCode, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("judge entry applies matching grant once when NH open; wrong kind no-op", () => {
  const dir = makeTmp();
  try {
    writeTask(dir);
    const taskText = readFileSync(nodePath.join(dir, "task.md"), "utf-8");
    const ck12 = contractKey12(taskText);

    const policyWithBounce = (): ResolvedPolicy =>
      resolvePolicy({
        interactive: false,
        policy: { stage: { grants: { [ck12]: { g1: { bounce: 1 } } } } },
      });

    const deps: JudgeCliDeps = {
      ...depsFor(dir),
      loadResolvedPolicy: policyWithBounce,
    };

    assert.equal(
      runJudgeCli(["design-needs-human", "--task", "task.md", "--reason", "gate"], deps)
        .exitCode,
      0,
    );

    // Next command entry applies grant then continues (design-begin still ok).
    const begin = runJudgeCli(["design-begin", "--task", "task.md"], deps);
    assert.equal(begin.exitCode, 0, begin.stderr);
    const after = readJournal(dir, ck12, "design");
    const applied = after.filter((e) => e.type === "grant-applied");
    assert.equal(applied.length, 1);
    assert.equal(applied[0]!.grant_id, "g1");
    assert.equal(applied[0]!.kind, "bounce");
    assert.equal(applied[0]!.n, 1);

    // Same grant_id not re-applied on later entry (even with fresh NH).
    assert.equal(
      runJudgeCli(["design-needs-human", "--task", "task.md", "--reason", "gate"], deps)
        .exitCode,
      0,
    );
    assert.equal(runJudgeCli(["design-begin", "--task", "task.md"], deps).exitCode, 0);
    assert.equal(
      readJournal(dir, ck12, "design").filter((e) => e.type === "grant-applied").length,
      1,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("judge entry: wrong-kind grant leaves NH; non-NH ignores grants", () => {
  const dir = makeTmp();
  try {
    writeTask(dir);
    const taskText = readFileSync(nodePath.join(dir, "task.md"), "utf-8");
    const ck12 = contractKey12(taskText);

    const deps: JudgeCliDeps = {
      ...depsFor(dir),
      loadResolvedPolicy: () =>
        resolvePolicy({
          interactive: false,
          policy: { stage: { grants: { [ck12]: { g1: { resume: true } } } } },
        }),
    };

    assert.equal(
      runJudgeCli(["design-needs-human", "--task", "task.md", "--reason", "gate"], deps)
        .exitCode,
      0,
    );
    assert.equal(runJudgeCli(["design-begin", "--task", "task.md"], deps).exitCode, 0);
    const mid = readJournal(dir, ck12, "design");
    assert.equal(mid.filter((e) => e.type === "grant-applied").length, 0);
    assert.ok(mid.some((e) => e.type === "needs-human" && e.reason === "gate"));

    // Fresh dir state without NH: grants present but ignored.
    const dir2 = makeTmp();
    try {
      writeTask(dir2);
      const ck2 = contractKey12(readFileSync(nodePath.join(dir2, "task.md"), "utf-8"));
      const deps2: JudgeCliDeps = {
        ...depsFor(dir2),
        loadResolvedPolicy: () =>
          resolvePolicy({
            interactive: false,
            policy: { stage: { grants: { [ck2]: { g1: { bounce: 1 } } } } },
          }),
      };
      assert.equal(runJudgeCli(["design-begin", "--task", "task.md"], deps2).exitCode, 0);
      assert.equal(
        readJournal(dir2, ck2, "design").filter((e) => e.type === "grant-applied").length,
        0,
      );
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("judge --help lists design-needs-human", () => {
  const dir = makeTmp();
  try {
    const help = runJudgeCli(["--help"], depsFor(dir));
    assert.match(help.stdout, /design-needs-human/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
