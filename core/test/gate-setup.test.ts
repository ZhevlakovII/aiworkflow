import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

import { buildGateSetup } from "../src/design/gate-setup.ts";
import { runGateSetupCli, type GateSetupCliDeps } from "../src/design/gate-setup-cli.ts";

// ---------------------------------------------------------------------------
// buildGateSetup (pure core) — gate.cmd generation (contract L-4: allow/deny/
// test-cmd/gate-optional), ported from `tools/gate_setup.py`.
// ---------------------------------------------------------------------------

function fm(body: string): string {
  return `---\n${body}\n---\n\n# task\n`;
}

test("buildGateSetup: empty zone.allow -> error (зона обязательна, Q4)", () => {
  const r = buildGateSetup(fm(`id: x`));
  assert.equal(r.gateCmd, "");
  assert.match(r.error as string, /zone\.allow/);
});

test("buildGateSetup: allow only -> auto-appends .workflow/** + WARN echo (no test-cmd, not gate-optional)", () => {
  const r = buildGateSetup(fm(`allow: ["core/**"]`));
  assert.equal(r.error, undefined);
  assert.equal(
    r.gateCmd,
    'node core/src/zone/zone-check-cli.ts --staged --allow "core/**,.workflow/**" && echo "WARN: нет test-cmd; гейт = только zone_check"',
  );
});

test("buildGateSetup: allow already includes .workflow/** -> not duplicated", () => {
  const r = buildGateSetup(fm(`allow: ["core/**", ".workflow/**"]`));
  assert.match(r.gateCmd, /--allow "core\/\*\*,\.workflow\/\*\*"/);
  // exactly one occurrence of .workflow/** in the allow csv
  const allowCsv = /--allow "([^"]*)"/.exec(r.gateCmd)?.[1] ?? "";
  assert.equal(allowCsv.split(",").filter((s) => s === ".workflow/**").length, 1);
});

test("buildGateSetup: deny strips .workflow/** / .workflow/* / .workflow (auto-allow always wins)", () => {
  const r = buildGateSetup(fm(`allow: ["core/**"]\ndeny: [".git/**", ".workflow/**", ".workflow/*", ".workflow"]`));
  assert.match(r.gateCmd, /--deny "\.git\/\*\*"/);
  const denyCsv = /--deny "([^"]*)"/.exec(r.gateCmd)?.[1] ?? "";
  assert.equal(denyCsv.includes(".workflow"), false);
});

test("buildGateSetup: test-cmd present -> appended instead of WARN echo", () => {
  const r = buildGateSetup(fm(`allow: ["core/**"]\ntest-cmd: "cd core && node --test test/*.test.ts"`));
  assert.equal(
    r.gateCmd,
    'node core/src/zone/zone-check-cli.ts --staged --allow "core/**,.workflow/**" && cd core && node --test test/*.test.ts',
  );
});

test("buildGateSetup: gate-optional=true + no test-cmd -> no WARN echo appended", () => {
  const r = buildGateSetup(fm(`allow: ["core/**"]\ngate-optional: true`));
  assert.equal(r.gateCmd, 'node core/src/zone/zone-check-cli.ts --staged --allow "core/**,.workflow/**"');
});

test("buildGateSetup: allow+deny+test-cmd all present -> zone-check && deny && test-cmd, one shell line", () => {
  const r = buildGateSetup(
    fm(`allow: ["core/**", "docs/**"]\ndeny: [".git/**", ".omp/**"]\ntest-cmd: "npm test"`),
  );
  assert.equal(
    r.gateCmd,
    'node core/src/zone/zone-check-cli.ts --staged --allow "core/**,docs/**,.workflow/**" --deny ".git/**,.omp/**" && npm test',
  );
});

// ---------------------------------------------------------------------------
// gate-setup-cli — argv/fs wiring, --print dry-run, write path
// ---------------------------------------------------------------------------

function mkTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeDeps(cwd: string): GateSetupCliDeps {
  return {
    exists: fs.existsSync,
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
    cwd,
  };
}

test("gate-setup-cli: missing --task -> exit 2 usage error", () => {
  const cwd = mkTmpDir("gate-setup-cli-");
  try {
    const r = runGateSetupCli([], makeDeps(cwd));
    assert.equal(r.exitCode, 2);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("gate-setup-cli: task-file not found -> exit 2, ERROR", () => {
  const cwd = mkTmpDir("gate-setup-cli-");
  try {
    const r = runGateSetupCli(["--task", path.join(cwd, "nope.md")], makeDeps(cwd));
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /ERROR: task-file не найден/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("gate-setup-cli: task-file without zone.allow -> exit 2, ERROR (Python-parity for markdown-style task-files)", () => {
  const cwd = mkTmpDir("gate-setup-cli-");
  try {
    const taskPath = path.join(cwd, "t.md");
    fs.writeFileSync(taskPath, "# T7-2 — some task\n\n## Zone (allow)\n`core/**`\n");
    const r = runGateSetupCli(["--task", taskPath], makeDeps(cwd));
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /zone\.allow/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("gate-setup-cli: --print -> stdout=gate.cmd content, exit 0, NO file written", () => {
  const cwd = mkTmpDir("gate-setup-cli-");
  try {
    const taskPath = path.join(cwd, "t.md");
    fs.writeFileSync(taskPath, fm(`allow: ["core/**"]`));
    const r = runGateSetupCli(["--task", taskPath, "--print"], makeDeps(cwd));
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /zone-check-cli\.ts --staged --allow/);
    assert.equal(fs.existsSync(path.join(cwd, ".workflow", "gate.cmd")), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("gate-setup-cli: writes .workflow/gate.cmd, prints 'gate.cmd записан (<name>):' + line, exit 0", () => {
  const cwd = mkTmpDir("gate-setup-cli-");
  try {
    const taskPath = path.join(cwd, "t7-2-zone-check-ts.md");
    fs.writeFileSync(taskPath, fm(`allow: ["core/**"]`));
    const r = runGateSetupCli(["--task", taskPath], makeDeps(cwd));
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /gate\.cmd записан \(t7-2-zone-check-ts\.md\):/);
    const written = fs.readFileSync(path.join(cwd, ".workflow", "gate.cmd"), "utf-8");
    assert.match(written, /zone-check-cli\.ts --staged --allow "core\/\*\*,\.workflow\/\*\*"/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
