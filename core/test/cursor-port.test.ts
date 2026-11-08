/**
 * Cursor port unit tests (p2-cursor-port).
 * Docs: docs/design/cursor-port-2026-10-28.md §1–2.
 * IDE deny is NOT claimed verified live — these are unit-level only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import {
  mapCursorTool,
  parseCursorInput,
  applyCursorHook,
  processInput,
  type HookDeps,
} from "../src/shim/command-hook.ts";
import { render } from "../src/render/engine.ts";
import type { Policy } from "../src/policy/policy.ts";

const REPO_ROOT = nodePath.join(import.meta.dirname, "..", "..");
const CANON_ROOT = nodePath.join(REPO_ROOT, "canon");
const ADAPTERS_ROOT = nodePath.join(REPO_ROOT, "tools", "adapters");

function depsWith(policy: Policy = {}): HookDeps {
  return { loadPolicy: () => ({ policy, warnings: [] }) };
}

// ---------------------------------------------------------------------------
// mapCursorTool
// ---------------------------------------------------------------------------

test("mapCursorTool: Shell -> Bash", () => {
  assert.equal(mapCursorTool("Shell"), "Bash");
});

test("mapCursorTool: Write -> Write", () => {
  assert.equal(mapCursorTool("Write"), "Write");
});

test("mapCursorTool: Glob unmapped -> empty", () => {
  assert.equal(mapCursorTool("Glob"), "");
});

test("mapCursorTool: Read unmapped -> empty (allow path)", () => {
  assert.equal(mapCursorTool("Read"), "");
});

// ---------------------------------------------------------------------------
// parseCursorInput
// ---------------------------------------------------------------------------

test("parseCursorInput: preToolUse Shell -> Bash + command", () => {
  const input = parseCursorInput({
    hook_event_name: "preToolUse",
    tool_name: "Shell",
    tool_input: { command: "git status" },
    cwd: "/repo",
  });
  assert.equal(input.event, "preToolUse");
  assert.equal(input.tool, "Bash");
  assert.equal(input.command, "git status");
  assert.equal(input.cwd, "/repo");
});

test("parseCursorInput: preToolUse Write -> Write + filePath", () => {
  const input = parseCursorInput({
    hook_event_name: "preToolUse",
    tool_name: "Write",
    tool_input: { file_path: "core/x.ts", contents: "..." },
    cwd: "/repo",
  });
  assert.equal(input.tool, "Write");
  assert.equal(input.filePath, "core/x.ts");
});

test("parseCursorInput: beforeShellExecution top-level command -> Bash", () => {
  const input = parseCursorInput({
    hook_event_name: "beforeShellExecution",
    command: "rm -rf /",
    cwd: "/repo",
  });
  assert.equal(input.event, "beforeShellExecution");
  assert.equal(input.tool, "Bash");
  assert.equal(input.command, "rm -rf /");
});

test("parseCursorInput: Glob preToolUse -> empty tool (unmapped)", () => {
  const input = parseCursorInput({
    hook_event_name: "preToolUse",
    tool_name: "Glob",
    tool_input: { glob_pattern: "**/*.ts" },
  });
  assert.equal(input.tool, "");
});

// ---------------------------------------------------------------------------
// applyCursorHook — deny only pre events; exit 2 ASSUME
// ---------------------------------------------------------------------------

test("applyCursorHook: preToolUse Shell security-floor -> deny exit 2", () => {
  const result = applyCursorHook(
    {
      hook_event_name: "preToolUse",
      tool_name: "Shell",
      tool_input: { command: "rm -rf /" },
    },
    depsWith({})
  );
  assert.equal(result.exitCode, 2);
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.permission, "deny");
});

test("applyCursorHook: beforeShellExecution security-floor -> deny exit 2", () => {
  const result = applyCursorHook(
    {
      hook_event_name: "beforeShellExecution",
      command: "rm -rf /",
    },
    depsWith({})
  );
  assert.equal(result.exitCode, 2);
});

test("applyCursorHook: afterFileEdit -> allow exit 0 (no deny claim)", () => {
  const result = applyCursorHook(
    {
      hook_event_name: "afterFileEdit",
      file_path: ".git/x",
      edits: [],
    },
    depsWith({ profile: "guarded" })
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, "");
});

test("applyCursorHook: subagentStart -> allow exit 0", () => {
  const result = applyCursorHook(
    { hook_event_name: "subagentStart", subagent_type: "executor" },
    depsWith({})
  );
  assert.equal(result.exitCode, 0);
});

test("applyCursorHook: subagentStop -> allow exit 0", () => {
  const result = applyCursorHook(
    { hook_event_name: "subagentStop", status: "completed" },
    depsWith({})
  );
  assert.equal(result.exitCode, 0);
});

test("applyCursorHook: Glob preToolUse unmapped -> allow exit 0", () => {
  const result = applyCursorHook(
    {
      hook_event_name: "preToolUse",
      tool_name: "Glob",
      tool_input: { glob_pattern: "**/*" },
    },
    depsWith({})
  );
  assert.equal(result.exitCode, 0);
});

test("applyCursorHook: preToolUse Write allow (operator assist, non-protected) -> exit 0", () => {
  const result = applyCursorHook(
    {
      hook_event_name: "preToolUse",
      tool_name: "Write",
      tool_input: { file_path: "docs/x.md" },
      cwd: "/repo",
    },
    depsWith({ profile: "assist" })
  );
  assert.equal(result.exitCode, 0);
});

test("processInput cursor: deny output string (exit code via applyCursorHook)", () => {
  const raw = JSON.stringify({
    hook_event_name: "preToolUse",
    tool_name: "Shell",
    tool_input: { command: "rm -rf /" },
  });
  const out = processInput("cursor", raw, depsWith({}));
  const parsed = JSON.parse(out);
  assert.equal(parsed.permission, "deny");
});

// ---------------------------------------------------------------------------
// Adapter + tree fixtures
// ---------------------------------------------------------------------------

test("cursor.yml: glob tool_map is null; client/dir/capabilities", () => {
  const yml = readFileSync(nodePath.join(ADAPTERS_ROOT, "cursor.yml"), "utf-8");
  assert.match(yml, /^client:\s*cursor\s*$/m);
  assert.match(yml, /dir:\s*"\.cursor"/);
  assert.match(yml, /glob:\s*null/);
  assert.match(yml, /capabilities:[\s\S]*roles/);
});

test("render --clients cursor writes .cursor/agents/*.md", (t) => {
  const tmp = mkdtempSync(nodePath.join(tmpdir(), "aiwf-cursor-render-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const report = render(CANON_ROOT, tmp, {
    clients: ["cursor"],
    adaptersRoot: ADAPTERS_ROOT,
  });
  assert.deepEqual(report.errors, [], `render errors: ${JSON.stringify(report.errors)}`);
  assert.ok(existsSync(nodePath.join(tmp, ".cursor", "agents", "executor.md")));
  assert.ok(existsSync(nodePath.join(tmp, ".cursor", "agents", "producer.md")));
  const body = readFileSync(nodePath.join(tmp, ".cursor", "agents", "executor.md"), "utf-8");
  // Glob must not appear as an invented Cursor tool name in rendered tools frontmatter
  const fmMatch = body.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(fmMatch);
  assert.ok(!/\bGlob\b/.test(fmMatch[1]), "Glob must not appear in Cursor agent tools frontmatter");
  assert.match(fmMatch[1], /\bShell\b/);
  assert.match(fmMatch[1], /\bWrite\b/);
});

test("ports/cursor/hooks.json: version 1 + five events + <clone> token", () => {
  const hooks = JSON.parse(
    readFileSync(nodePath.join(REPO_ROOT, "ports", "cursor", "hooks.json"), "utf-8")
  );
  assert.equal(hooks.version, 1);
  const names = Object.keys(hooks.hooks);
  for (const ev of [
    "preToolUse",
    "beforeShellExecution",
    "afterFileEdit",
    "subagentStart",
    "subagentStop",
  ]) {
    assert.ok(names.includes(ev), `missing hook event ${ev}`);
    const cmd = hooks.hooks[ev][0].command as string;
    assert.match(cmd, /<clone>/);
    assert.match(cmd, /command-hook\.ts" cursor/);
  }
});

test("aiwf-flow skill includes scaffold in stage list", () => {
  const skill = readFileSync(
    nodePath.join(REPO_ROOT, "ports", "cursor", "skills", "aiwf-flow", "SKILL.md"),
    "utf-8"
  );
  assert.match(skill, /scaffold/);
  assert.match(skill, /classify\s*→\s*design\s*→\s*plan\s*→\s*scaffold\s*→\s*execute/);
});

test("setup.ps1: all includes cursor; both does not", () => {
  const ps1 = readFileSync(nodePath.join(REPO_ROOT, "tools", "setup.ps1"), "utf-8");
  // Assignment body must include cursor|all and must NOT or-eq 'both'
  assert.match(
    ps1,
    /\$doCursor\s*=\s*\(\$Flow -eq 'cursor'\s*-or\s*\$Flow -eq 'all'\)/
  );
  assert.doesNotMatch(
    ps1,
    /\$doCursor\s*=\s*\([^)]*-eq 'both'/
  );
});

test("setup.sh: all includes cursor; both excludes cursor", () => {
  const sh = readFileSync(nodePath.join(REPO_ROOT, "tools", "setup.sh"), "utf-8");
  assert.match(sh, /all\)\s+DO_OMP=1; DO_CLAUDE=1; DO_OPENCODE=1; DO_CURSOR=1/);
  assert.match(sh, /both\)\s+DO_OMP=1; DO_CLAUDE=1; DO_OPENCODE=1\s*;;/);
});
