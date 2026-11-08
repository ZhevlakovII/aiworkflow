import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";

import { frTrace, frIdsFromSpec, isTestFile } from "../src/design/fr-trace.ts";
import { runFrTraceCli } from "../src/design/fr-trace-cli.ts";
import type { GitSeam, GitRunResult } from "../src/rails/git-seam.ts";

const FX = path.resolve(import.meta.dirname, "fixtures/design/frtrace");
const SPEC = path.join(FX, "spec.md");
const COVERED = path.join(FX, "MoneyTest.kt");
const PARTIAL = path.join(FX, "PartialTest.kt");
const IMPL = path.join(FX, "Money.kt");
const NOFR_SPEC = path.resolve(import.meta.dirname, "fixtures/design/ears/task.md"); // no ```fr blocks

// ---------------------------------------------------------------------------
// frTrace (pure core) — B.1b regression, ported from tools/tests/test_fr_trace.py
// ---------------------------------------------------------------------------

test("frTrace: covering test file -> PASS (0 findings), both FR covered", () => {
  const r = frTrace(SPEC, [COVERED], FX);
  assert.deepEqual(r.findings, []);
  assert.equal(r.frIds.length, 2);
  assert.deepEqual(r.covered.sort(), ["FR-add-positive", "FR-reject-negative"].sort());
});

test("frTrace: partial test file -> 1 finding (FR-reject-negative uncovered)", () => {
  const r = frTrace(SPEC, [PARTIAL], FX);
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0], /FR-reject-negative/);
});

test("frTrace: non-test impl file only -> 1 finding (no test-files, FR>0)", () => {
  const r = frTrace(SPEC, [IMPL], FX);
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0], /ни одного тест-файла/);
});

test("frTrace: 0-FR spec -> PASS regardless of files (FR conditional)", () => {
  const r = frTrace(NOFR_SPEC, [COVERED], FX);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.frIds, []);
});

test("isTestFile: kotlin/py/ts test-file basenames recognized, impl file not", () => {
  assert.equal(isTestFile("MoneyTest.kt"), true);
  assert.equal(isTestFile("test_foo.py"), true);
  assert.equal(isTestFile("foo.test.ts"), true);
  assert.equal(isTestFile("Money.kt"), false);
});

test("frIdsFromSpec: extracts FR ids in document order", () => {
  assert.deepEqual(frIdsFromSpec(SPEC), ["FR-add-positive", "FR-reject-negative"]);
});

test("frIdsFromSpec: missing spec file -> []", () => {
  assert.deepEqual(frIdsFromSpec(path.join(FX, "nope.md")), []);
});

// ---------------------------------------------------------------------------
// runFrTraceCli (argv/git-seam shell, output/exit parity with tools/fr_trace.py)
// ---------------------------------------------------------------------------

function fakeGit(result: GitRunResult): GitSeam {
  return { run: () => result, runShell: () => result };
}

test("CLI: covering test file via --files -> exit 0, FR-TRACE: PASS", () => {
  const out = runFrTraceCli(["--spec", SPEC, "--files", COVERED, "--repo-root", FX], {
    git: fakeGit({ code: 0, stdout: "", stderr: "" }),
    exists: fs.existsSync,
  });
  assert.equal(out.exitCode, 0);
  assert.match(out.stdout, /^FR: 2 \| covered: 2 \| test-files: 1 \| findings: 0/);
  assert.match(out.stdout, /FR-TRACE: PASS$/);
});

test("CLI: partial test file -> exit 1, FR-TRACE: FAIL, one [x] line", () => {
  const out = runFrTraceCli(["--spec", SPEC, "--files", PARTIAL, "--repo-root", FX], {
    git: fakeGit({ code: 0, stdout: "", stderr: "" }),
    exists: fs.existsSync,
  });
  assert.equal(out.exitCode, 1);
  assert.equal(out.stdout.split("\n").filter((l) => l.startsWith("  [x] ")).length, 1);
  assert.match(out.stdout, /FR-TRACE: FAIL$/);
});

test("CLI: --staged appends `git diff --cached --name-only` output to --files", () => {
  let calledArgs: readonly string[] | undefined;
  const git: GitSeam = {
    run: (args) => { calledArgs = args; return { code: 0, stdout: `${COVERED}\n`, stderr: "" }; },
    runShell: () => ({ code: 0, stdout: "", stderr: "" }),
  };
  const out = runFrTraceCli(["--spec", SPEC, "--staged", "--repo-root", FX], { git, exists: fs.existsSync });
  assert.deepEqual(calledArgs, ["git", "diff", "--cached", "--name-only"]);
  assert.equal(out.exitCode, 0);
});

test("CLI: missing --spec file -> exit 2, stderr 'spec не найден'", () => {
  const out = runFrTraceCli(["--spec", path.join(FX, "nope.md")], {
    git: fakeGit({ code: 0, stdout: "", stderr: "" }),
    exists: fs.existsSync,
  });
  assert.equal(out.exitCode, 2);
  assert.match(out.stderr, /spec не найден/);
});

test("CLI: unknown flag -> exit 2 usage error", () => {
  const out = runFrTraceCli(["--bogus"], { git: fakeGit({ code: 0, stdout: "", stderr: "" }), exists: () => true });
  assert.equal(out.exitCode, 2);
  assert.match(out.stderr, /неизвестный аргумент/);
});
