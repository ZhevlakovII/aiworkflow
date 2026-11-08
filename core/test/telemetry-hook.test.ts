import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildRecord, formatTs, MAX_BYTES } from "../src/ops/telemetry.ts";
import { runTelemetryHook, type TelemetryHookDeps } from "../src/ops/telemetry-hook.ts";

// ---------------------------------------------------------------------------
// telemetry.ts (pure core, contract L-1)
// ---------------------------------------------------------------------------

test("formatTs: local time, second precision, no timezone suffix (Python strftime parity)", () => {
  const d = new Date(2026, 0, 5, 9, 3, 7); // 2026-01-05 09:03:07 local
  assert.equal(formatTs(d), "2026-01-05T09:03:07");
});

test("buildRecord: no tool_response -> ok=true", () => {
  const r = buildRecord({ tool_name: "Bash" }, new Date(2026, 0, 1, 0, 0, 0));
  assert.deepEqual(r, { ts: "2026-01-01T00:00:00", kind: "tool", tool: "Bash", ok: true });
});

test("buildRecord: tool_response.is_error truthy -> ok=false", () => {
  const r = buildRecord({ tool_name: "Bash", tool_response: { is_error: true } }, new Date());
  assert.equal(r.ok, false);
});

test("buildRecord: tool_response.error truthy -> ok=false", () => {
  const r = buildRecord({ tool_name: "Bash", tool_response: { error: "boom" } }, new Date());
  assert.equal(r.ok, false);
});

test("buildRecord: tool_response dict without is_error/error -> ok=true", () => {
  const r = buildRecord({ tool_name: "Read", tool_response: { content: "x" } }, new Date());
  assert.equal(r.ok, true);
});

test("buildRecord: missing tool_name -> empty string tool", () => {
  const r = buildRecord({}, new Date());
  assert.equal(r.tool, "");
});

// ---------------------------------------------------------------------------
// runTelemetryHook (injectable orchestration, contract L-2) — real temp dirs
// (same "prefer real fs over a mock" preference as `rails-cli.test.ts`),
// except for the two cases that specifically need a controlled failure
// (mkdirp throws) or a pre-sized 20MB rotation file (kept in-memory there
// for speed/determinism).
// ---------------------------------------------------------------------------

function mkTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function realDeps(scriptDir: string, now: Date = new Date(2026, 0, 1, 12, 0, 0)): TelemetryHookDeps {
  return {
    exists: fs.existsSync,
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
    statSize: (p) => fs.statSync(p).size,
    rename: (a, b) => fs.renameSync(a, b),
    appendLine: (p, line) => fs.appendFileSync(p, line, "utf-8"),
    scriptDir,
    now: () => now,
  };
}

test("runTelemetryHook: AIWF_TELEMETRY_OFF=1 -> no-op, returns null, nothing created", () => {
  const prev = process.env.AIWF_TELEMETRY_OFF;
  process.env.AIWF_TELEMETRY_OFF = "1";
  const dir = mkTmpDir("aiwf-tel-off-");
  try {
    const result = runTelemetryHook(JSON.stringify({ cwd: dir, tool_name: "Bash" }), realDeps(dir));
    assert.equal(result, null);
    assert.equal(fs.existsSync(path.join(dir, ".workflow")), false);
  } finally {
    if (prev === undefined) delete process.env.AIWF_TELEMETRY_OFF;
    else process.env.AIWF_TELEMETRY_OFF = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runTelemetryHook: malformed JSON stdin -> null, no write (fail-silent)", () => {
  const dir = mkTmpDir("aiwf-tel-badjson-");
  try {
    const result = runTelemetryHook("not json{{{", realDeps(dir));
    assert.equal(result, null);
    assert.equal(fs.existsSync(path.join(dir, ".workflow")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runTelemetryHook: writes one NDJSON line to <cwd>/.workflow/telemetry.ndjson", () => {
  const dir = mkTmpDir("aiwf-tel-write-");
  try {
    const input = JSON.stringify({ cwd: dir, tool_name: "Write", tool_response: { ok: true } });
    const written = runTelemetryHook(input, realDeps(dir));
    const expected = path.join(dir, ".workflow", "telemetry.ndjson");
    assert.equal(written, expected);
    const content = fs.readFileSync(expected, "utf-8");
    assert.equal(content.endsWith("\n"), true);
    const parsed = JSON.parse(content.trim());
    assert.deepEqual(parsed, { ts: "2026-01-01T12:00:00", kind: "tool", tool: "Write", ok: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runTelemetryHook: no cwd in payload -> walks up scriptDir for a sibling .git", () => {
  const root = mkTmpDir("aiwf-tel-root-");
  try {
    fs.mkdirSync(path.join(root, ".git"));
    const scriptDir = path.join(root, "core", "src", "ops");
    fs.mkdirSync(scriptDir, { recursive: true });
    const written = runTelemetryHook(JSON.stringify({ tool_name: "Bash" }), realDeps(scriptDir));
    assert.equal(written, path.join(root, ".workflow", "telemetry.ndjson"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runTelemetryHook: rotation — existing file >= MAX_BYTES is renamed before the new line is appended", () => {
  const dir = mkTmpDir("aiwf-tel-rotate-");
  try {
    const target = path.join(dir, ".workflow", "telemetry.ndjson");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "x".repeat(MAX_BYTES));
    const before = fs.readdirSync(path.join(dir, ".workflow"));
    assert.deepEqual(before, ["telemetry.ndjson"]);

    runTelemetryHook(JSON.stringify({ cwd: dir, tool_name: "Edit" }), realDeps(dir));

    const after = fs.readdirSync(path.join(dir, ".workflow"));
    assert.equal(after.length, 2);
    const rotated = after.find((n) => n !== "telemetry.ndjson")!;
    assert.match(rotated, /^telemetry\.\d+\.ndjson$/);
    assert.equal(fs.statSync(path.join(dir, ".workflow", rotated)).size, MAX_BYTES);
    const newContent = fs.readFileSync(target, "utf-8");
    assert.equal(JSON.parse(newContent.trim()).tool, "Edit");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runTelemetryHook: internal deps error (e.g. mkdirp throws) -> swallowed, returns null", () => {
  const dir = mkTmpDir("aiwf-tel-err-");
  try {
    const deps: TelemetryHookDeps = {
      ...realDeps(dir),
      mkdirp: () => {
        throw new Error("disk full");
      },
    };
    const result = runTelemetryHook(JSON.stringify({ cwd: dir, tool_name: "Bash" }), deps);
    assert.equal(result, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
