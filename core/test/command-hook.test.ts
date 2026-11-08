import { test } from "node:test";
import assert from "node:assert/strict";

import type { Policy } from "../src/policy/policy.ts";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import {
  runHook,
  processInput,
  parseClaudeInput,
  formatClaudeOutput,
  parseCodexInput,
  formatCodexOutput,
  mapCursorTool,
  parseCursorInput,
  applyCursorHook,
  type HookInput,
  type HookDeps,
} from "../src/shim/command-hook.ts";
import { loadActiveZoneFile, ACTIVE_ZONE_PATH } from "../src/wiring/policy-source.ts";

function depsWith(policy: Policy = {}): HookDeps {
  return { loadPolicy: () => ({ policy, warnings: [] }) };
}

// ---------------------------------------------------------------------------
// runHook — Bash security-floor (always-on, any profile)
// ---------------------------------------------------------------------------

test("runHook: Bash security-floor (rm -rf /) denies at off profile", () => {
  const input: HookInput = { tool: "Bash", command: "rm -rf /" };
  const dec = runHook(input, depsWith({ profile: "off" }));
  assert.equal(dec.decision, "deny");
  assert.ok(dec.reason);
});

test("runHook: Bash security-floor (rm -rf /) denies at autonomous profile too", () => {
  const input: HookInput = { tool: "Bash", command: "rm -rf /" };
  const dec = runHook(input, depsWith({ profile: "autonomous" }));
  assert.equal(dec.decision, "deny");
});

// ---------------------------------------------------------------------------
// runHook — Bash raw-git (rail-mapping)
// ---------------------------------------------------------------------------

test("runHook: raw `git commit` at guarded -> deny (rail-verdict maps to deny, stir to rail)", () => {
  const input: HookInput = { tool: "Bash", command: "git commit -m x" };
  const dec = runHook(input, depsWith({ profile: "guarded" }));
  assert.equal(dec.decision, "deny");
  assert.ok(dec.reason && dec.reason.length > 0);
});

test("runHook: raw `git commit` at off -> allow (rail off -> operator trusted)", () => {
  const input: HookInput = { tool: "Bash", command: "git commit -m x" };
  const dec = runHook(input, depsWith({ profile: "off" }));
  assert.equal(dec.decision, "allow");
});

test("runHook: raw `git commit` at assist -> allow", () => {
  const input: HookInput = { tool: "Bash", command: "git commit -m x" };
  const dec = runHook(input, depsWith({ profile: "assist" }));
  assert.equal(dec.decision, "allow");
});

// ---------------------------------------------------------------------------
// runHook — Write under protected path (DEFAULT_PROTECTED floor)
// ---------------------------------------------------------------------------

test("runHook: Write to .git/x by worker -> deny (protected floor, always active for worker)", () => {
  const input: HookInput = {
    tool: "Write",
    filePath: ".git/x",
    actorSignal: "sub-1",
    zone: { allow: ["core/**"] },
  };
  const dec = runHook(input, depsWith({ profile: "guarded" }));
  assert.equal(dec.decision, "deny");
});

test("runHook: Write to .git/x by operator@assist -> allow (operator_zone off at assist -> unrestricted)", () => {
  const input: HookInput = {
    tool: "Write",
    filePath: ".git/x",
    isTTY: true, // interactive -> assist default
  };
  const dec = runHook(input, depsWith({}));
  assert.equal(dec.decision, "allow");
});

// ---------------------------------------------------------------------------
// runHook — Write worker allow-lane (D9 worker allowlist)
// ---------------------------------------------------------------------------

test("runHook: Write by worker inside its allow-lane (core/x.ts, zone.allow core/**) -> allow", () => {
  const input: HookInput = {
    tool: "Write",
    filePath: "core/x.ts",
    actorSignal: "sub-1",
    zone: { allow: ["core/**"] },
  };
  const dec = runHook(input, depsWith({ profile: "guarded" }));
  assert.equal(dec.decision, "allow");
});

test("runHook: Write by worker outside its allow-lane (docs/x.md) -> deny", () => {
  const input: HookInput = {
    tool: "Write",
    filePath: "docs/x.md",
    actorSignal: "sub-1",
    zone: { allow: ["core/**"] },
  };
  const dec = runHook(input, depsWith({ profile: "guarded" }));
  assert.equal(dec.decision, "deny");
});

test("runHook: Write with empty filePath -> allow (nothing to check)", () => {
  const input: HookInput = { tool: "Write", filePath: "", actorSignal: "sub-1" };
  const dec = runHook(input, depsWith({ profile: "guarded" }));
  assert.equal(dec.decision, "allow");
});

// ---------------------------------------------------------------------------
// runHook — actor fail-closed (AD-worker-zone-always, contract L-2/L-3)
// ---------------------------------------------------------------------------

test("runHook: actorSignal present (truthy) -> worker (strict allow-lane path)", () => {
  const input: HookInput = {
    tool: "Write",
    filePath: "docs/x.md", // outside the allow-lane
    actorSignal: "sub-1",
    zone: { allow: ["core/**"] },
    isTTY: false,
  };
  const dec = runHook(input, depsWith({}));
  assert.equal(dec.decision, "deny", "worker: no allow-lane match -> deny");
});

test("runHook: actorSignal absent -> operator (protected-only path, no allow-lane restriction)", () => {
  const input: HookInput = {
    tool: "Write",
    filePath: "docs/x.md", // not protected, no allow-lane restriction for operator
    zone: { allow: ["core/**"] },
    isTTY: false, // headless -> guarded default (operator_zone on, but docs/x.md isn't protected)
  };
  const dec = runHook(input, depsWith({}));
  assert.equal(dec.decision, "allow", "operator: same path allowed (no worker allow-lane restriction)");
});

// ---------------------------------------------------------------------------
// runHook — interactive -> profile default (AD-profile-resolution, via buildPolicy)
// ---------------------------------------------------------------------------

test("runHook: isTTY=true (interactive), no explicit profile -> assist default (raw git-mut allowed, rail.level=none)", () => {
  const input: HookInput = { tool: "Bash", command: "git commit -m x", isTTY: true };
  const dec = runHook(input, depsWith({}));
  assert.equal(dec.decision, "allow");
});

test("runHook: isTTY=false (headless), no explicit profile -> guarded default (raw git-mut rails, maps to deny)", () => {
  const input: HookInput = { tool: "Bash", command: "git commit -m x", isTTY: false };
  const dec = runHook(input, depsWith({}));
  assert.equal(dec.decision, "deny");
});

// ---------------------------------------------------------------------------
// runHook — non path/Bash tools -> allow
// ---------------------------------------------------------------------------

test("runHook: unrelated tool (Read) -> allow", () => {
  const input: HookInput = { tool: "Read", filePath: ".git/config" };
  const dec = runHook(input, depsWith({ profile: "autonomous" }));
  assert.equal(dec.decision, "allow");
});

// ---------------------------------------------------------------------------
// runHook zone source wiring T7 dash 0 L1 deps loadZone worker only
// ---------------------------------------------------------------------------

function makeZoneTmpDir() {
  return mkdtempSync(nodePath.join(tmpdir(), "aiwf-command-hook-zone-"));
}

function depsWithZone(policy, zoneJson) {
  const dir = makeZoneTmpDir();
  mkdirSync(nodePath.join(dir, ".workflow"), { recursive: true });
  if (zoneJson !== undefined) {
    writeFileSync(nodePath.join(dir, ACTIVE_ZONE_PATH), JSON.stringify(zoneJson), "utf-8");
  }
  const deps = {
    loadPolicy: function () { return { policy: policy, warnings: [] }; },
    loadZone: function (cwd) { return loadActiveZoneFile((cwd || ".") + "/" + ACTIVE_ZONE_PATH); },
  };
  return { deps: deps, cwd: dir, dir: dir };
}

test("runHook: worker, deps.loadZone allow-lane match (Write inside) -> allow", function () {
  const z = depsWithZone({ profile: "guarded" }, { task: "t", allow: ["core/**"] });
  try {
    const dec = runHook({ tool: "Write", filePath: "core/x.ts", actorSignal: "sub-1", cwd: z.cwd }, z.deps);
    assert.equal(dec.decision, "allow");
  } finally {
    rmSync(z.dir, { recursive: true, force: true });
  }
});

test("runHook: worker, deps.loadZone allow-lane match (Write outside) -> deny", function () {
  const z = depsWithZone({ profile: "guarded" }, { task: "t", allow: ["core/**"] });
  try {
    const dec = runHook({ tool: "Write", filePath: "docs/x.md", actorSignal: "sub-1", cwd: z.cwd }, z.deps);
    assert.equal(dec.decision, "deny");
  } finally {
    rmSync(z.dir, { recursive: true, force: true });
  }
});

test("runHook: worker, deps.loadZone allow-lane match (Bash inside) -> allow", function () {
  const z = depsWithZone({ profile: "guarded" }, { task: "t", allow: ["core/**"] });
  try {
    const dec = runHook({ tool: "Bash", command: "echo x > core/src/x.ts", actorSignal: "sub-1", cwd: z.cwd }, z.deps);
    assert.equal(dec.decision, "allow");
  } finally {
    rmSync(z.dir, { recursive: true, force: true });
  }
});

test("runHook: worker, deps.loadZone allow-lane match (Bash outside) -> deny", function () {
  const z = depsWithZone({ profile: "guarded" }, { task: "t", allow: ["core/**"] });
  try {
    const dec = runHook({ tool: "Bash", command: "echo x > out/of/zone", actorSignal: "sub-1", cwd: z.cwd }, z.deps);
    assert.equal(dec.decision, "deny");
  } finally {
    rmSync(z.dir, { recursive: true, force: true });
  }
});

test("runHook: worker, no active-zone.json file at all -> deny (Write); Bash also deny (Amend A1: unloaded zone -> {allow:[]}, closes L-3 gap)", function () {
  const z = depsWithZone({ profile: "guarded" }, undefined);
  try {
    const decWrite = runHook({ tool: "Write", filePath: "core/x.ts", actorSignal: "sub-1", cwd: z.cwd }, z.deps);
    assert.equal(decWrite.decision, "deny");
    const decBash = runHook({ tool: "Bash", command: "echo x > core/src/x.ts", actorSignal: "sub-1", cwd: z.cwd }, z.deps);
    assert.equal(decBash.decision, "deny");
  } finally {
    rmSync(z.dir, { recursive: true, force: true });
  }
});

test("runHook: Amend A1 — worker without active-zone.json, `echo x > a.txt` -> deny", function () {
  const z = depsWithZone({ profile: "guarded" }, undefined);
  try {
    const dec = runHook({ tool: "Bash", command: "echo x > a.txt", actorSignal: "sub-1", cwd: z.cwd }, z.deps);
    assert.equal(dec.decision, "deny");
  } finally {
    rmSync(z.dir, { recursive: true, force: true });
  }
});

test("runHook: Amend A1 — worker, no deps.loadZone provided at all (undefined) -> Bash write deny", function () {
  const deps: HookDeps = { loadPolicy: () => ({ policy: { profile: "guarded" }, warnings: [] }) };
  const dec = runHook({ tool: "Bash", command: "echo x > a.txt", actorSignal: "sub-1" }, deps);
  assert.equal(dec.decision, "deny");
});

test("runHook: worker, malformed active-zone.json -> deny (Write, D9 fail-closed)", function () {
  const dir = makeZoneTmpDir();
  try {
    mkdirSync(nodePath.join(dir, ".workflow"), { recursive: true });
    writeFileSync(nodePath.join(dir, ACTIVE_ZONE_PATH), "not json here", "utf-8");
    const deps = {
      loadPolicy: function () { return { policy: { profile: "guarded" }, warnings: [] }; },
      loadZone: function (cwd) { return loadActiveZoneFile((cwd || ".") + "/" + ACTIVE_ZONE_PATH); },
    };
    const dec = runHook({ tool: "Write", filePath: "core/x.ts", actorSignal: "sub-1", cwd: dir }, deps);
    assert.equal(dec.decision, "deny");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runHook: worker cannot rewrite its own active-zone.json via Write even with allow star star (L-2 floor)", function () {
  const z = depsWithZone({ profile: "guarded" }, { task: "t", allow: ["**"] });
  try {
    const dec = runHook({ tool: "Write", filePath: ACTIVE_ZONE_PATH, actorSignal: "sub-1", cwd: z.cwd }, z.deps);
    assert.equal(dec.decision, "deny");
  } finally {
    rmSync(z.dir, { recursive: true, force: true });
  }
});

test("runHook: worker cannot rewrite its own active-zone.json via Bash even with allow star star (L-2 floor)", function () {
  const z = depsWithZone({ profile: "guarded" }, { task: "t", allow: ["**"] });
  try {
    const cmd = "echo pwned > " + ACTIVE_ZONE_PATH;
    const dec = runHook({ tool: "Bash", command: cmd, actorSignal: "sub-1", cwd: z.cwd }, z.deps);
    assert.equal(dec.decision, "deny");
  } finally {
    rmSync(z.dir, { recursive: true, force: true });
  }
});

test("runHook: operator is not affected, deps.loadZone is never called even when present and would throw", function () {
  const deps = {
    loadPolicy: function () { return { policy: { profile: "guarded" }, warnings: [] }; },
    loadZone: function () { throw new Error("deps.loadZone must never be invoked for actor=operator"); },
  };
  assert.doesNotThrow(function () {
    const dec = runHook({ tool: "Write", filePath: "docs/x.md" }, deps);
    assert.equal(dec.decision, "allow");
  });
});

// ---------------------------------------------------------------------------
// parseClaudeInput
// ---------------------------------------------------------------------------

test("parseClaudeInput: Write tool_input.file_path -> HookInput.filePath", () => {
  const raw = {
    tool_name: "Write",
    tool_input: { file_path: "core/src/x.ts", content: "..." },
    cwd: "/repo",
  };
  const input = parseClaudeInput(raw);
  assert.equal(input.tool, "Write");
  assert.equal(input.filePath, "core/src/x.ts");
  assert.equal(input.command, undefined);
  assert.equal(input.cwd, "/repo");
});

test("parseClaudeInput: Bash tool_input.command -> HookInput.command", () => {
  const raw = { tool_name: "Bash", tool_input: { command: "git status" }, cwd: "/repo" };
  const input = parseClaudeInput(raw);
  assert.equal(input.tool, "Bash");
  assert.equal(input.command, "git status");
  assert.equal(input.filePath, undefined);
});

test("parseClaudeInput: NotebookEdit tool_input.notebook_path -> HookInput.filePath", () => {
  const raw = { tool_name: "NotebookEdit", tool_input: { notebook_path: "nb/a.ipynb" } };
  const input = parseClaudeInput(raw);
  assert.equal(input.tool, "NotebookEdit");
  assert.equal(input.filePath, "nb/a.ipynb");
});

test("parseClaudeInput: missing/malformed fields degrade gracefully", () => {
  const input = parseClaudeInput({});
  assert.equal(input.tool, "");
  assert.equal(input.filePath, undefined);
  assert.equal(input.command, undefined);
  assert.equal(input.cwd, undefined);
});

// ---------------------------------------------------------------------------
// formatClaudeOutput
// ---------------------------------------------------------------------------

test("formatClaudeOutput: allow -> empty string (silent allow)", () => {
  assert.equal(formatClaudeOutput({ decision: "allow" }), "");
});

test("formatClaudeOutput: deny -> valid CC permissionDecision JSON", () => {
  const out = formatClaudeOutput({ decision: "deny", reason: "zone-guard: nope" });
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(parsed.hookSpecificOutput.permissionDecisionReason, "zone-guard: nope");
});

// ---------------------------------------------------------------------------
// Codex adapter (synthetic, AD-codex-degrade — unverified against a live runtime)
// ---------------------------------------------------------------------------

test("parseCodexInput: synthetic Codex JSON -> correct HookInput", () => {
  const raw = { tool: "Bash", input: { command: "rm -rf /" }, cwd: "/repo" };
  const input = parseCodexInput(raw);
  assert.equal(input.tool, "Bash");
  assert.equal(input.command, "rm -rf /");
  assert.equal(input.cwd, "/repo");
});

test("formatCodexOutput: deny -> JSON permissionDecision (symmetric to CC, no hookSpecificOutput envelope)", () => {
  const out = formatCodexOutput({ decision: "deny", reason: "zone-guard: nope" });
  const parsed = JSON.parse(out);
  assert.equal(parsed.permissionDecision, "deny");
  assert.equal(parsed.permissionDecisionReason, "zone-guard: nope");
  assert.equal(parsed.hookSpecificOutput, undefined);
});

test("formatCodexOutput: allow -> empty string", () => {
  assert.equal(formatCodexOutput({ decision: "allow" }), "");
});

test("processInput: Codex end-to-end synthetic deny (security-floor)", () => {
  const raw = JSON.stringify({ tool: "Bash", input: { command: "rm -rf /" } });
  const out = processInput("codex", raw, depsWith({}));
  const parsed = JSON.parse(out);
  assert.equal(parsed.permissionDecision, "deny");
});

// ---------------------------------------------------------------------------
// fail-open (contract L-4) — processInput is the fail-open boundary
// ---------------------------------------------------------------------------

test("processInput: fail-open when deps.loadPolicy throws -> silent allow, does not propagate", () => {
  const throwingDeps: HookDeps = {
    loadPolicy: () => {
      throw new Error("boom: policy file unreadable");
    },
  };
  const raw = JSON.stringify({ tool_name: "Bash", tool_input: { command: "git commit -m x" } });
  assert.doesNotThrow(() => {
    const out = processInput("claude", raw, throwingDeps);
    assert.equal(out, "");
  });
});

test("processInput: fail-open on malformed stdin JSON -> silent allow", () => {
  const out = processInput("claude", "{not json", depsWith({}));
  assert.equal(out, "");
});

test("processInput: end-to-end CC deny (security-floor) round-trips through parse+runHook+format", () => {
  const raw = JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf /" } });
  const out = processInput("claude", raw, depsWith({}));
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
});

test("processInput: end-to-end CC allow (Read tool) -> empty string", () => {
  const raw = JSON.stringify({ tool_name: "Read", tool_input: { file_path: "x.ts" } });
  const out = processInput("claude", raw, depsWith({}));
  assert.equal(out, "");
});

// ---------------------------------------------------------------------------
// Cursor adapter (unit-level; IDE deny not live-verified)
// ---------------------------------------------------------------------------

test("mapCursorTool / parseCursorInput: Shell->Bash, Write->Write, Glob unmapped", () => {
  assert.equal(mapCursorTool("Shell"), "Bash");
  assert.equal(mapCursorTool("Write"), "Write");
  assert.equal(mapCursorTool("Glob"), "");
  const shell = parseCursorInput({
    hook_event_name: "preToolUse",
    tool_name: "Shell",
    tool_input: { command: "echo hi" },
  });
  assert.equal(shell.tool, "Bash");
  assert.equal(shell.command, "echo hi");
});

test("applyCursorHook: deny only on preToolUse/beforeShellExecution (exit 2 ASSUME)", () => {
  const deny = applyCursorHook(
    {
      hook_event_name: "beforeShellExecution",
      command: "rm -rf /",
    },
    depsWith({})
  );
  assert.equal(deny.exitCode, 2);
  const allowAfter = applyCursorHook(
    { hook_event_name: "afterFileEdit", file_path: "x.ts", edits: [] },
    depsWith({})
  );
  assert.equal(allowAfter.exitCode, 0);
});

test("processInput: cursor client routes to applyCursorHook output", () => {
  const raw = JSON.stringify({
    hook_event_name: "preToolUse",
    tool_name: "Shell",
    tool_input: { command: "rm -rf /" },
  });
  const out = processInput("cursor", raw, depsWith({}));
  assert.equal(JSON.parse(out).permission, "deny");
});

// ---------------------------------------------------------------------------
// Design C — session_write_protected in command-hook only (operator Write)
// ---------------------------------------------------------------------------

test("runHook: operator Write to session_write_protected path -> deny", () => {
  const input: HookInput = {
    tool: "Write",
    filePath: ".workflow/active-zone.json",
    cwd: "C:\\repo",
    isTTY: false,
  };
  const dec = runHook(
    input,
    depsWith({
      profile: "guarded",
      session_write_protected: [".workflow/active-zone.json", ".workflow/stages/**"],
      enforcement_paths: ["core/src/**", "policy.yml", ".gitignore"],
    })
  );
  assert.equal(dec.decision, "deny");
  assert.match(dec.reason ?? "", /session_write_protected/);
});

test("runHook: operator Write to enforcement_paths entry -> deny (union)", () => {
  const input: HookInput = {
    tool: "Write",
    filePath: "policy.yml",
    cwd: "C:\\repo",
    isTTY: false,
  };
  const dec = runHook(
    input,
    depsWith({
      profile: "guarded",
      session_write_protected: [".workflow/stages/**"],
      enforcement_paths: ["policy.yml"],
    })
  );
  assert.equal(dec.decision, "deny");
  assert.match(dec.reason ?? "", /session_write_protected/);
});

test("runHook: operator Write stages/design-drafts/core/src -> deny (SWP matrix)", () => {
  const policy: Policy = {
    profile: "guarded",
    session_write_protected: [
      ".workflow/stages/**",
      ".workflow/active-zone.json",
      ".workflow/design-drafts/**",
    ],
    enforcement_paths: ["core/src/**", "policy.yml", ".gitignore"],
  };
  for (const filePath of [
    ".workflow/stages/abcdef012345.design.ndjson",
    ".workflow/design-drafts/foo.md",
    "core/src/classify/path-zone.ts",
    ".gitignore",
  ]) {
    const dec = runHook(
      { tool: "Write", filePath, cwd: "C:\\repo", isTTY: false },
      depsWith(policy)
    );
    assert.equal(dec.decision, "deny", filePath);
    assert.match(dec.reason ?? "", /session_write_protected/);
  }
});

test("runHook: operator Write unrelated path -> allow", () => {
  const dec = runHook(
    { tool: "Write", filePath: "docs/x.md", cwd: "C:\\repo", isTTY: false },
    depsWith({
      profile: "guarded",
      session_write_protected: [".workflow/stages/**"],
      enforcement_paths: ["policy.yml"],
    })
  );
  assert.equal(dec.decision, "allow");
});

test("runHook: worker Write to SWP path inside allow-lane -> allow (SWP is operator-only)", () => {
  const dec = runHook(
    {
      tool: "Write",
      filePath: ".workflow/stages/x.ndjson",
      actorSignal: "sub-1",
      zone: { allow: [".workflow/stages/**"] },
      cwd: "C:\\repo",
      isTTY: false,
    },
    depsWith({
      profile: "guarded",
      session_write_protected: [".workflow/stages/**"],
    })
  );
  assert.equal(dec.decision, "allow");
});

test("runHook: operator create-only task — existing file denied", () => {
  const seen: string[] = [];
  const deps: HookDeps = {
    loadPolicy: () => ({
      policy: { profile: "guarded", session_write_protected: [".workflow/stages/**"] },
      warnings: [],
    }),
    exists: (abs) => {
      seen.push(abs);
      return true;
    },
  };
  const dec = runHook(
    {
      tool: "Write",
      filePath: ".workflow/tasks/core-session-write-protected.md",
      cwd: "C:\\repo",
      isTTY: false,
    },
    deps
  );
  assert.equal(dec.decision, "deny");
  assert.match(dec.reason ?? "", /session_write_protected|create-only/);
  assert.equal(seen.length, 1);
  assert.match(seen[0]!.replace(/\\/g, "/"), /\/\.workflow\/tasks\/core-session-write-protected\.md$/i);
});

test("runHook: operator create-only task — absent file allowed (create)", () => {
  const deps: HookDeps = {
    loadPolicy: () => ({
      policy: { profile: "guarded", session_write_protected: [".workflow/stages/**"] },
      warnings: [],
    }),
    exists: () => false,
  };
  const dec = runHook(
    {
      tool: "Write",
      filePath: ".workflow/tasks/brand-new-task.md",
      cwd: "C:\\repo",
      isTTY: false,
    },
    deps
  );
  assert.equal(dec.decision, "allow");
});

// ---------------------------------------------------------------------------
// Design C — execute-stage lead freeze (after SWP, operator PATH_TOOLS only)
// ---------------------------------------------------------------------------

function freezeDeps(opts: {
  isExecuteOpen: boolean;
  exists?: (abs: string) => boolean;
  policy?: Policy;
}): HookDeps {
  return {
    loadPolicy: () => ({
      policy: opts.policy ?? {
        profile: "guarded",
        session_write_protected: [".workflow/stages/**", ".workflow/active-zone.json"],
        enforcement_paths: ["policy.yml"],
      },
      warnings: [],
    }),
    isExecuteOpen: () => opts.isExecuteOpen,
    exists: opts.exists ?? (() => false),
  };
}

test("runHook: execute closed → docs allow; SWP still denies stages", () => {
  const deps = freezeDeps({ isExecuteOpen: false });
  const docs = runHook(
    { tool: "Write", filePath: "docs/x.md", cwd: "C:\\repo", isTTY: false },
    deps
  );
  assert.equal(docs.decision, "allow");

  const stages = runHook(
    {
      tool: "Write",
      filePath: ".workflow/stages/abcdef012345.execute.ndjson",
      cwd: "C:\\repo",
      isTTY: false,
    },
    deps
  );
  assert.equal(stages.decision, "deny");
  assert.match(stages.reason ?? "", /session_write_protected/);
});

test("runHook: execute open → docs deny (lead freeze)", () => {
  const dec = runHook(
    { tool: "Write", filePath: "docs/x.md", cwd: "C:\\repo", isTTY: false },
    freezeDeps({ isExecuteOpen: true })
  );
  assert.equal(dec.decision, "deny");
  assert.match(dec.reason ?? "", /execute/i);
  assert.match(dec.reason ?? "", /freeze/i);
});

test("runHook: execute open → ledger allow", () => {
  const dec = runHook(
    {
      tool: "Write",
      filePath: ".workflow/ledger/status.md",
      cwd: "C:\\repo",
      isTTY: false,
    },
    freezeDeps({ isExecuteOpen: true })
  );
  assert.equal(dec.decision, "allow");
});

test("runHook: execute open → existing task deny (SWP create-only)", () => {
  const dec = runHook(
    {
      tool: "Write",
      filePath: ".workflow/tasks/existing-task.md",
      cwd: "C:\\repo",
      isTTY: false,
    },
    freezeDeps({ isExecuteOpen: true, exists: () => true })
  );
  assert.equal(dec.decision, "deny");
  assert.match(dec.reason ?? "", /session_write_protected|create-only/);
});

test("runHook: execute open → new task allow", () => {
  const dec = runHook(
    {
      tool: "Write",
      filePath: ".workflow/tasks/brand-new-under-freeze.md",
      cwd: "C:\\repo",
      isTTY: false,
    },
    freezeDeps({ isExecuteOpen: true, exists: () => false })
  );
  assert.equal(dec.decision, "allow");
});

test("runHook: execute open → core/src deny (freeze, after SWP miss)", () => {
  // core/src not in this policy's SWP/enforcement — freeze must still deny.
  const dec = runHook(
    { tool: "Write", filePath: "core/src/shim/command-hook.ts", cwd: "C:\\repo", isTTY: false },
    freezeDeps({
      isExecuteOpen: true,
      policy: {
        profile: "guarded",
        session_write_protected: [".workflow/stages/**"],
      },
    })
  );
  assert.equal(dec.decision, "deny");
  assert.match(dec.reason ?? "", /lead freeze|freeze/);
  assert.match(dec.reason ?? "", /execute/i);
});

test("runHook: worker Write while execute open → allow (freeze is operator-only)", () => {
  const dec = runHook(
    {
      tool: "Write",
      filePath: "docs/x.md",
      actorSignal: "sub-1",
      zone: { allow: ["docs/**"] },
      cwd: "C:\\repo",
      isTTY: false,
    },
    freezeDeps({ isExecuteOpen: true })
  );
  assert.equal(dec.decision, "allow");
});

test("runHook: execute open cleared (isExecuteOpen false) → docs allow again", () => {
  const dec = runHook(
    { tool: "Write", filePath: "docs/x.md", cwd: "C:\\repo", isTTY: false },
    freezeDeps({ isExecuteOpen: false })
  );
  assert.equal(dec.decision, "allow");
});

// ---------------------------------------------------------------------------
// Contract A — Shell SWP + execute freeze (Bash / PowerShell redirects)
// ---------------------------------------------------------------------------

test("runHook: Bash `echo x > .workflow/stages/x.ndjson` → SWP deny", () => {
  const dec = runHook(
    {
      tool: "Bash",
      command: "echo x > .workflow/stages/x.ndjson",
      cwd: "C:\\repo",
      isTTY: false,
    },
    freezeDeps({ isExecuteOpen: false })
  );
  assert.equal(dec.decision, "deny");
  assert.match(dec.reason ?? "", /session_write_protected/);
});

test("runHook: Bash redirect to docs while execute open → lead freeze deny", () => {
  const dec = runHook(
    {
      tool: "Bash",
      command: "echo x > docs/a.md",
      cwd: "C:\\repo",
      isTTY: false,
    },
    freezeDeps({ isExecuteOpen: true })
  );
  assert.equal(dec.decision, "deny");
  assert.match(dec.reason ?? "", /lead freeze|freeze/);
});

test("runHook: Bash ledger redirect allow when freeze open", () => {
  const dec = runHook(
    {
      tool: "Bash",
      command: "echo note > .workflow/ledger/status.md",
      cwd: "C:\\repo",
      isTTY: false,
    },
    freezeDeps({ isExecuteOpen: true })
  );
  assert.equal(dec.decision, "allow");
});

test("runHook: Bash plain `ls` allow (no extractable write targets)", () => {
  const dec = runHook(
    { tool: "Bash", command: "ls", cwd: "C:\\repo", isTTY: false },
    freezeDeps({ isExecuteOpen: true })
  );
  assert.equal(dec.decision, "allow");
});

test("runHook: PowerShell redirect to stages → SWP deny", () => {
  const dec = runHook(
    {
      tool: "PowerShell",
      command: "echo x > .workflow/stages/x.ndjson",
      cwd: "C:\\repo",
      isTTY: false,
    },
    freezeDeps({ isExecuteOpen: false })
  );
  assert.equal(dec.decision, "deny");
  assert.match(dec.reason ?? "", /session_write_protected/);
});

test("runHook: Cursor Shell mapped Bash redirect SWP deny", () => {
  const result = applyCursorHook(
    {
      hook_event_name: "beforeShellExecution",
      command: "echo x > .workflow/stages/x.ndjson",
      cwd: "C:\\repo",
    },
    freezeDeps({ isExecuteOpen: false })
  );
  assert.equal(result.exitCode, 2);
  assert.match(result.output, /session_write_protected/);
});
