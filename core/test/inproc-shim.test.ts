import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import type { Policy } from "../src/policy/policy.ts";
import type { HookDeps } from "../src/shim/command-hook.ts";
import { ompGuardDecision, type OmpEvent } from "../src/shim/omp-adapter.ts";
import { opencodeGuardDecision, type OcEvent } from "../src/shim/opencode-adapter.ts";
import * as engine from "../src/render/engine.ts";

const FIXTURE_CANON = nodePath.join(import.meta.dirname, "fixtures", "canon-min");
const FAKE_CORE = nodePath.join(import.meta.dirname, "fixtures", "fake-core");

function depsWith(policy: Policy = {}): HookDeps {
  return { loadPolicy: () => ({ policy, warnings: [] }) };
}

function makeTmp(): string {
  return mkdtempSync(nodePath.join(tmpdir(), "aiwf-inproc-shim-ts-"));
}

// ---------------------------------------------------------------------------
// ompGuardDecision — security-floor / raw-git / protected / clean-tool
// ---------------------------------------------------------------------------

test("ompGuardDecision: Bash `rm -rf /` (security-floor) -> {block:true}", () => {
  const event: OmpEvent = { toolName: "Bash", input: { command: "rm -rf /" } };
  const dec = ompGuardDecision(event, depsWith({ profile: "off" }));
  assert.ok(dec && dec.block === true, JSON.stringify(dec));
  assert.ok(dec!.reason.length > 0);
});

test("ompGuardDecision: raw `git commit` at guarded profile -> {block:true} (rail-verdict)", () => {
  const event: OmpEvent = { toolName: "Bash", input: { command: "git commit -m x" } };
  const dec = ompGuardDecision(event, depsWith({ profile: "guarded" }));
  assert.ok(dec && dec.block === true);
});

test("ompGuardDecision: Write under .git/x by worker -> {block:true} (protected floor)", () => {
  const event: OmpEvent = {
    toolName: "Write",
    input: { path: ".git/x" },
    subagentMarker: "sub-1",
  };
  const dec = ompGuardDecision(event, depsWith({ profile: "guarded" }));
  assert.ok(dec && dec.block === true);
});

test("ompGuardDecision: clean Read -> undefined (allow, no return needed)", () => {
  const event: OmpEvent = { toolName: "Read", input: { path: ".git/config" } };
  const dec = ompGuardDecision(event, depsWith({ profile: "autonomous" }));
  assert.equal(dec, undefined);
});

test("ompGuardDecision: lowercase write → SWP deny on stages path (adapter normalizes PATH_TOOLS)", () => {
  const event: OmpEvent = {
    toolName: "write",
    input: { path: ".workflow/stages/x.json" },
    cwd: "C:\\repo",
  };
  const dec = ompGuardDecision(
    event,
    depsWith({ profile: "guarded", session_write_protected: [".workflow/stages/**"] }),
  );
  assert.ok(dec && dec.block === true, "lowercase write must hit PATH_TOOLS after normalize");
  assert.match(dec!.reason, /session_write_protected/);
});

test("ompGuardDecision: ast_edit → Edit normalize hits SWP", () => {
  const event: OmpEvent = {
    toolName: "ast_edit",
    input: { path: ".workflow/stages/y.json" },
    cwd: "C:\\repo",
  };
  const dec = ompGuardDecision(
    event,
    depsWith({ profile: "guarded", session_write_protected: [".workflow/stages/**"] }),
  );
  assert.ok(dec && dec.block === true);
  assert.match(dec!.reason, /session_write_protected/);
});

// ---------------------------------------------------------------------------
// ompGuardDecision — actor/interactive (subagentMarker/hasUI wiring, contract §1)
// ---------------------------------------------------------------------------

test("ompGuardDecision: subagentMarker present -> worker allow-lane (outside zone.allow -> block)", () => {
  const event: OmpEvent = {
    toolName: "Write",
    input: { path: "docs/x.md" },
    subagentMarker: "sub-1",
  };
  const dec = ompGuardDecision(event, depsWith({}));
  assert.ok(dec && dec.block === true, "worker outside its allow-lane must be blocked");
});

test("ompGuardDecision: hasUI=true (interactive), no explicit profile -> assist default (raw git-mut allowed)", () => {
  const event: OmpEvent = { toolName: "Bash", input: { command: "git commit -m x" }, hasUI: true };
  const dec = ompGuardDecision(event, depsWith({}));
  assert.equal(dec, undefined, "interactive -> assist default, rail.level=none -> allow");
});

test("ompGuardDecision: hasUI=false (headless), no explicit profile -> guarded default (raw git-mut blocked)", () => {
  const event: OmpEvent = { toolName: "Bash", input: { command: "git commit -m x" }, hasUI: false };
  const dec = ompGuardDecision(event, depsWith({}));
  assert.ok(dec && dec.block === true, "headless -> guarded default -> rail maps to deny/block");
});

// ---------------------------------------------------------------------------
// opencodeGuardDecision — security-floor / raw-git / protected / safe-command
// ---------------------------------------------------------------------------

test("opencodeGuardDecision: Bash `rm -rf /` (security-floor) -> {deny:true}", () => {
  const event: OcEvent = { tool: "Bash", args: { command: "rm -rf /" } };
  const dec = opencodeGuardDecision(event, depsWith({ profile: "off" }));
  assert.ok(dec && dec.deny === true, JSON.stringify(dec));
  assert.ok(dec!.reason.length > 0);
});

test("opencodeGuardDecision: raw `git commit` at guarded -> {deny:true} (rail-verdict)", () => {
  const event: OcEvent = { tool: "Bash", args: { command: "git commit -m x" } };
  const dec = opencodeGuardDecision(event, depsWith({ profile: "guarded" }));
  assert.ok(dec && dec.deny === true);
});

test("opencodeGuardDecision: Write under .git/x -> {deny:true} (protected floor, no marker required)", () => {
  const event: OcEvent = { tool: "Write", args: { filePath: ".git/x" } };
  const dec = opencodeGuardDecision(event, depsWith({ profile: "guarded" }));
  assert.ok(dec && dec.deny === true);
});

test("opencodeGuardDecision: safe Bash command -> undefined (allow)", () => {
  const event: OcEvent = { tool: "Bash", args: { command: "git status" } };
  const dec = opencodeGuardDecision(event, depsWith({ profile: "guarded" }));
  assert.equal(dec, undefined);
});

test("opencodeGuardDecision: no marker (OpenCode gives none) -> operator semantics (non-protected write allowed)", () => {
  const event: OcEvent = { tool: "Write", args: { filePath: "docs/x.md" } };
  const dec = opencodeGuardDecision(event, depsWith({ profile: "guarded" }));
  assert.equal(dec, undefined, "operator: non-protected path, no worker allow-lane restriction applies");
});

test("opencodeGuardDecision: lowercase write → SWP deny on stages path (adapter normalizes PATH_TOOLS)", () => {
  const event: OcEvent = {
    tool: "write",
    args: { filePath: ".workflow/stages/x.json" },
    directory: "C:\\repo",
  };
  const dec = opencodeGuardDecision(
    event,
    depsWith({ profile: "guarded", session_write_protected: [".workflow/stages/**"] }),
  );
  assert.ok(dec && dec.deny === true, "lowercase write must hit PATH_TOOLS after normalize");
  assert.match(dec!.reason, /session_write_protected/);
});

// ---------------------------------------------------------------------------
// engine-emit wrapper — omp + opencode bundled/in-process fixtures
// ---------------------------------------------------------------------------

test("render: omp+opencode in-process wrappers emitted at entry paths, correct vendor-import + adapter call + rel-path, claimed", (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const out = nodePath.join(tmp, "out");

  const report = engine.render(FIXTURE_CANON, out, {
    clients: ["omp", "opencode"],
    overlayRoot: nodePath.join(tmp, "no-overlay"),
    coreSrcRoot: FAKE_CORE,
  });

  assert.deepEqual(report.errors, []);

  const ompEntry = nodePath.join(out, ".omp", "hooks", "pre", "zone-guard.ts");
  assert.equal(existsSync(ompEntry), true, "omp wrapper not emitted");
  const ompText = readFileSync(ompEntry, "utf-8");
  assert.match(ompText, /@oh-my-pi\/pi-coding-agent\/extensibility\/hooks/);
  assert.match(ompText, /import \{ ompGuardDecision \} from "\.\.\/_core\/shim\/omp-adapter";/);
  assert.match(ompText, /ompGuardDecision\(/);
  assert.match(ompText, /pi\.on\("tool_call"/);

  const ocEntry = nodePath.join(out, ".opencode", "plugins", "zone-guard.ts");
  assert.equal(existsSync(ocEntry), true, "opencode wrapper not emitted");
  const ocText = readFileSync(ocEntry, "utf-8");
  assert.match(ocText, /@opencode-ai\/plugin/);
  assert.match(ocText, /import \{ opencodeGuardDecision \} from "\.\.\/_core\/shim\/opencode-adapter";/);
  assert.match(ocText, /opencodeGuardDecision\(/);
  assert.match(ocText, /tool\.execute\.before/);

  // claimed, not unmanaged.
  const unmanagedHits = report.unmanaged.filter(
    (p) => p === ".omp/hooks/pre/zone-guard.ts" || p === ".opencode/plugins/zone-guard.ts"
  );
  assert.deepEqual(unmanagedHits, []);
});

// ---------------------------------------------------------------------------
// engine — regression: style="command-hook" / missing entry -> no wrapper
// ---------------------------------------------------------------------------

test("render: shim.style command-hook (default) or absent entry -> wrapper NOT emitted, bundle unaffected", (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const canonCopy = nodePath.join(tmp, "canon-min");
  mkdirSync(nodePath.join(canonCopy, "adapters"), { recursive: true });
  writeFileSync(
    nodePath.join(canonCopy, "adapters", "nowrap.yml"),
    "client: nowrap\ndir: \".nowrap\"\ncapabilities: []\nshim:\n  mode: bundled\n  location: \"_core\"\n",
    "utf-8"
  );
  writeFileSync(
    nodePath.join(canonCopy, "adapters", "nowrap2.yml"),
    "client: nowrap2\ndir: \".nowrap2\"\ncapabilities: []\nshim:\n  mode: bundled\n  location: \"_core\"\n  style: in-process\n",
    "utf-8"
  );

  const out = nodePath.join(tmp, "out");
  const report = engine.render(canonCopy, out, {
    clients: ["nowrap", "nowrap2"],
    overlayRoot: nodePath.join(tmp, "no-overlay"),
    coreSrcRoot: FAKE_CORE,
  });

  assert.deepEqual(report.errors, []);
  // Bundle IS emitted (regression, T5c-1 unaffected by T5c-2).
  assert.equal(existsSync(nodePath.join(out, ".nowrap", "_core", "a.ts")), true);
  assert.equal(existsSync(nodePath.join(out, ".nowrap2", "_core", "a.ts")), true);
  // No wrapper file written anywhere under either client dir besides the bundle.
  assert.equal(existsSync(nodePath.join(out, ".nowrap", "hooks")), false);
  assert.equal(existsSync(nodePath.join(out, ".nowrap2", "hooks")), false);
});

// ---------------------------------------------------------------------------
// engine — in-process client with no registered wrapper template
// ---------------------------------------------------------------------------

test("render: in-process style but no wrapper template for client -> report.errors, render does not throw, bundle intact", (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const canonCopy = nodePath.join(tmp, "canon-min");
  mkdirSync(nodePath.join(canonCopy, "adapters"), { recursive: true });
  writeFileSync(
    nodePath.join(canonCopy, "adapters", "notpl.yml"),
    "client: notpl\ndir: \".notpl\"\ncapabilities: []\nshim:\n  mode: bundled\n  location: \"_core\"\n  style: in-process\n  entry: \"hooks/zone-guard.ts\"\n",
    "utf-8"
  );

  const out = nodePath.join(tmp, "out");
  let report: engine.RenderReport | undefined;
  assert.doesNotThrow(() => {
    report = engine.render(canonCopy, out, {
      clients: ["notpl"],
      overlayRoot: nodePath.join(tmp, "no-overlay"),
      coreSrcRoot: FAKE_CORE,
    });
  });

  assert.equal(report!.errors.length, 1);
  assert.match(report!.errors[0], /notpl/);
  assert.match(report!.errors[0], /template/);
  // Bundle unaffected (fail-soft — only the wrapper is skipped).
  assert.equal(existsSync(nodePath.join(out, ".notpl", "_core", "a.ts")), true);
  // No wrapper written.
  assert.equal(existsSync(nodePath.join(out, ".notpl", "hooks", "zone-guard.ts")), false);
});
