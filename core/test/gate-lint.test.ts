import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

import { gateLint } from "../src/design/gate-lint.ts";
import { runGateLintCli } from "../src/design/gate-lint-cli.ts";

const FX = path.resolve(import.meta.dirname, "fixtures/design/ears");
const TASK = path.join(FX, "task.md");
const SPEC = path.join(FX, "spec.md");
const ADR = path.join(FX, "adr.md");

// ---------------------------------------------------------------------------
// gateLint (pure core) — B.1a EARS regression, ported from tools/tests/test_ears_gate.py
// ---------------------------------------------------------------------------

test("gateLint: ears fixture — 4 expected findings (noshall/empty-trigger/bad-pattern/bad-source), 3 valid FR clean", () => {
  const g = gateLint(TASK, SPEC, ADR, FX);
  assert.equal(g.nSp, 1);
  assert.equal(g.nAd, 1);
  assert.equal(g.nFr, 7);
  assert.equal(g.findings.length, 4);

  const expect: Array<[string, string]> = [
    ["FR-bad-noshall", 'нет "SHALL"'],
    ["FR-bad-emptytrigger", "пустой trigger"],
    ["FR-bad-pattern", "неизвестный pattern"],
    ["FR-bad-source", "L999"],
  ];
  for (const [fid, sub] of expect) {
    assert.ok(
      g.findings.some((f) => f.includes(fid) && f.includes(sub)),
      `missing finding for ${fid} containing '${sub}': ${JSON.stringify(g.findings)}`,
    );
  }
});

test("gateLint: fence-tag aliases sp/ad -> PASS (0 findings), counts 1/1/1", () => {
  const spec = `\`\`\`sp
id: SP-a
source: task.md#L9
statement: ok
\`\`\`

\`\`\`fr
id: FR-a
source: task.md#L9
pattern: event
statement: WHEN the user taps THE SYSTEM SHALL do a thing
\`\`\`
`;
  const adr = `\`\`\`ad
id: AD-a
covers: SP-a
statement: decision
\`\`\`
`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-lint-"));
  fs.writeFileSync(path.join(dir, "spec.md"), spec, "utf8");
  fs.writeFileSync(path.join(dir, "adr.md"), adr, "utf8");
  const g = gateLint(TASK, path.join(dir, "spec.md"), path.join(dir, "adr.md"), FX);
  assert.equal(g.findings.length, 0);
  assert.equal(g.nSp, 1);
  assert.equal(g.nAd, 1);
  assert.equal(g.nFr, 1);
});

test("gateLint: clean spec/adr (SP covered, valid FR only) -> PASS (0 findings)", () => {
  const spec = `\`\`\`spec
id: SP-a
source: task.md#L9
statement: ok
\`\`\`

\`\`\`fr
id: FR-a
source: task.md#L9
pattern: ubiquitous
statement: THE SYSTEM SHALL do a thing
\`\`\`
`;
  const adr = `\`\`\`adr
id: AD-a
covers: SP-a
statement: decision
\`\`\`
`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-lint-"));
  fs.writeFileSync(path.join(dir, "spec.md"), spec, "utf8");
  fs.writeFileSync(path.join(dir, "adr.md"), adr, "utf8");
  const g = gateLint(TASK, path.join(dir, "spec.md"), path.join(dir, "adr.md"), FX);
  assert.deepEqual(g.findings, []);
});

test("gateLint: missing spec/adr/task file -> single 'файл не найден' finding", () => {
  const g = gateLint(path.join(FX, "nope.md"), SPEC, ADR, FX);
  assert.equal(g.findings.length, 1);
  assert.match(g.findings[0], /файл не найден/);
});

test("gateLint: SP not covered and not gap:true -> G2 finding", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-lint-"));
  const spec = `\`\`\`spec\nid: SP-uncovered\nsource: task.md#L9\nstatement: x\n\`\`\`\n`;
  const adr = `\`\`\`adr\nid: AD-a\ncovers: \nstatement: y\n\`\`\`\n`;
  fs.writeFileSync(path.join(dir, "spec.md"), spec, "utf8");
  fs.writeFileSync(path.join(dir, "adr.md"), adr, "utf8");
  const g = gateLint(TASK, path.join(dir, "spec.md"), path.join(dir, "adr.md"), FX);
  assert.ok(g.findings.some((f) => f.includes("G2 AD-a: covers пуст")));
  assert.ok(g.findings.some((f) => f.includes("G2 SP-uncovered: не покрыт")));
});

test("gateLint: AD.covers references a phantom SP-id -> G2 finding", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-lint-"));
  const spec = `\`\`\`spec\nid: SP-real\nsource: task.md#L9\nstatement: x\ngap: true\n\`\`\`\n`;
  const adr = `\`\`\`adr\nid: AD-a\ncovers: SP-ghost\nstatement: y\n\`\`\`\n`;
  fs.writeFileSync(path.join(dir, "spec.md"), spec, "utf8");
  fs.writeFileSync(path.join(dir, "adr.md"), adr, "utf8");
  const g = gateLint(TASK, path.join(dir, "spec.md"), path.join(dir, "adr.md"), FX);
  assert.ok(g.findings.some((f) => f.includes("SP-ghost") && f.includes("фантом")));
});

// ---------------------------------------------------------------------------
// runGateLintCli (argv shell, output/exit parity with tools/gate_lint.py)
// ---------------------------------------------------------------------------

test("CLI: ears fixture -> exit 1, GATE: BOUNCE, header + 4 [x] lines", () => {
  const out = runGateLintCli(["--task", TASK, "--spec", SPEC, "--adr", ADR, "--repo-root", FX], {
    exists: (p) => fs.existsSync(p),
  });
  assert.equal(out.exitCode, 1);
  assert.match(out.stdout, /^SP-points: 1 \| AD-decisions: 1 \| FR-points: 7 \| findings: 4/);
  assert.equal(out.stdout.split("\n").filter((l) => l.startsWith("  [x] ")).length, 4);
  assert.match(out.stdout, /GATE: BOUNCE$/);
});

test("CLI: missing --spec file -> exit 2, stderr 'файл не найден', no stdout", () => {
  const out = runGateLintCli(["--task", TASK, "--spec", path.join(FX, "nope.md"), "--adr", ADR], {
    exists: (p) => fs.existsSync(p),
  });
  assert.equal(out.exitCode, 2);
  assert.match(out.stderr, /файл не найден/);
  assert.equal(out.stdout, "");
});

test("CLI: missing --task flag -> exit 2 usage error", () => {
  const out = runGateLintCli(["--spec", SPEC, "--adr", ADR], { exists: () => true });
  assert.equal(out.exitCode, 2);
  assert.match(out.stderr, /--task/);
});

test("CLI: unknown flag -> exit 2 usage error", () => {
  const out = runGateLintCli(["--bogus"], { exists: () => true });
  assert.equal(out.exitCode, 2);
  assert.match(out.stderr, /неизвестный аргумент/);
});
