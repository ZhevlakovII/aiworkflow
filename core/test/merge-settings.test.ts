import { test } from "node:test";
import assert from "node:assert/strict";

import {
  mergeSettings,
  renderSettings,
  DENY_DEFAULTS,
  PRETOOLUSE_MATCHER_REQUIRED,
  unionMatcher,
  runMergeSettingsCli,
  type SettingsConfig,
  type MergeSettingsCliDeps,
} from "../src/ops/merge-settings.ts";

// ---------------------------------------------------------------------------
// mergeSettings (contract L-3: node port of the retired python heredoc /
// parity with install-claude.ps1's Ensure-Prop/Set-HookGroup)
// ---------------------------------------------------------------------------

test("unionMatcher: required only when no existing", () => {
  assert.equal(unionMatcher(PRETOOLUSE_MATCHER_REQUIRED), PRETOOLUSE_MATCHER_REQUIRED);
  assert.equal(unionMatcher(PRETOOLUSE_MATCHER_REQUIRED, undefined), PRETOOLUSE_MATCHER_REQUIRED);
  assert.equal(unionMatcher(PRETOOLUSE_MATCHER_REQUIRED, ""), PRETOOLUSE_MATCHER_REQUIRED);
});

test("unionMatcher: keeps extra tokens from existing; adds missing required", () => {
  assert.equal(
    unionMatcher("Bash|PowerShell|Write", "Bash|Write|X"),
    "Bash|PowerShell|Write|X"
  );
  assert.equal(
    unionMatcher(PRETOOLUSE_MATCHER_REQUIRED, "Bash|Write|Edit|MultiEdit|NotebookEdit"),
    PRETOOLUSE_MATCHER_REQUIRED
  );
});

test("mergeSettings: empty cfg -> all 4 deny defaults + both hook groups added", () => {
  const out = mergeSettings({}, "node hook.ts", "node tel.ts");
  assert.deepEqual(out.permissions?.deny, DENY_DEFAULTS);
  assert.equal(out.hooks?.PreToolUse?.length, 1);
  assert.equal(out.hooks?.PreToolUse?.[0].matcher, PRETOOLUSE_MATCHER_REQUIRED);
  assert.match(out.hooks?.PreToolUse?.[0].matcher ?? "", /\bPowerShell\b/);
  assert.equal(out.hooks?.PreToolUse?.[0].hooks[0].command, "node hook.ts");
  assert.equal(out.hooks?.PostToolUse?.[0].hooks[0].command, "node tel.ts");
});

test("mergeSettings: fresh install matcher includes PowerShell", () => {
  const out = mergeSettings({}, "node command-hook.ts", "node telemetry.ts");
  assert.match(out.hooks?.PreToolUse?.[0].matcher ?? "", /\bPowerShell\b/);
  assert.equal(out.hooks?.PreToolUse?.[0].matcher, PRETOOLUSE_MATCHER_REQUIRED);
});

test("mergeSettings: keeps extra matcher token X from displaced PreToolUse group", () => {
  const hookCmd = 'node "/repo/core/src/shim/command-hook.ts" claude';
  const cfg: SettingsConfig = {
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|X",
          hooks: [{ type: "command", command: hookCmd }],
        },
      ],
    },
  };
  const out = mergeSettings(cfg, hookCmd, "node telemetry.ts");
  const m = out.hooks?.PreToolUse?.[0].matcher ?? "";
  assert.match(m, /\bPowerShell\b/);
  assert.match(m, /\bX\b/);
  assert.equal(m, "Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|X");
});

test("mergeSettings: adds PowerShell without dropping other tokens from existing matcher", () => {
  const hookCmd = 'node "/repo/core/src/shim/command-hook.ts" claude';
  const cfg: SettingsConfig = {
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash|Write|Edit|MultiEdit|NotebookEdit",
          hooks: [{ type: "command", command: hookCmd }],
        },
      ],
    },
  };
  const out = mergeSettings(cfg, hookCmd, "node telemetry.ts");
  const m = out.hooks?.PreToolUse?.[0].matcher ?? "";
  assert.match(m, /\bPowerShell\b/);
  for (const tok of ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"]) {
    assert.match(m, new RegExp(`\\b${tok}\\b`));
  }
  assert.equal(m, PRETOOLUSE_MATCHER_REQUIRED);
});

test("mergeSettings: re-merge with PowerShell already present does not strip it", () => {
  const hookCmd = 'node "/repo/core/src/shim/command-hook.ts" claude';
  const tel = 'node "/repo/core/src/ops/telemetry-hook.ts"';
  const first = mergeSettings({}, hookCmd, tel);
  assert.match(first.hooks?.PreToolUse?.[0].matcher ?? "", /\bPowerShell\b/);
  const second = mergeSettings(first, hookCmd, tel);
  assert.equal(second.hooks?.PreToolUse?.[0].matcher, first.hooks?.PreToolUse?.[0].matcher);
  assert.match(second.hooks?.PreToolUse?.[0].matcher ?? "", /\bPowerShell\b/);
});

test("mergeSettings: does not mutate the input cfg", () => {
  const cfg: SettingsConfig = { permissions: { deny: ["X"] } };
  mergeSettings(cfg, "h", "t");
  assert.deepEqual(cfg.permissions?.deny, ["X"]);
  assert.equal(cfg.hooks, undefined);
});

test("mergeSettings: existing deny entries preserved, defaults appended without dup", () => {
  const cfg: SettingsConfig = { permissions: { deny: ["Bash(rm -rf:*)", "Custom(x:*)"] } };
  const out = mergeSettings(cfg, "h", "t");
  assert.deepEqual(out.permissions?.deny, [
    "Bash(rm -rf:*)",
    "Custom(x:*)",
    "Bash(nc:*)",
    "Bash(ssh:*)",
    "PowerShell(Remove-Item -Recurse -Force:*)",
  ]);
});

test("mergeSettings: re-run REPLACES a stale hook-group tagged 'zone-guard'/'command-hook', no duplicate", () => {
  const cfg: SettingsConfig = {
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "python zone-guard.py" }] },
        { matcher: "Other", hooks: [{ type: "command", command: "some-other-hook" }] },
      ],
    },
  };
  const out = mergeSettings(cfg, "node command-hook.ts claude", "t");
  const pre = out.hooks?.PreToolUse ?? [];
  assert.equal(pre.length, 2, "stale zone-guard group replaced, unrelated group kept, new group added");
  assert.ok(pre.some((g) => g.hooks[0].command === "some-other-hook"));
  assert.ok(pre.some((g) => g.hooks[0].command === "node command-hook.ts claude"));
  assert.ok(!pre.some((g) => g.hooks[0].command.includes("zone-guard.py")));
});

test("mergeSettings: re-run against ITS OWN prior output is idempotent (no growth) — realistic hookCmd/tel containing the dedupe tags", () => {
  const hookCmd = 'node "/repo/core/src/shim/command-hook.ts" claude';
  const tel = 'node "/repo/core/src/ops/telemetry-hook.ts"';
  const first = mergeSettings({}, hookCmd, tel);
  const second = mergeSettings(first, hookCmd, tel);
  assert.deepEqual(second, first);
  assert.equal(first.hooks?.PreToolUse?.length, 1);
  assert.equal(first.hooks?.PostToolUse?.length, 1);
});

test("mergeSettings: dedupe is BY TAG SUBSTRING, not generic re-run detection (python-heredoc/install-claude.ps1 parity, not a bug) — a hookCmd that doesn't contain 'command-hook' does NOT get deduped against itself", () => {
  const first = mergeSettings({}, "node hook.ts", "node tel.ts");
  const second = mergeSettings(first, "node hook.ts", "node tel.ts");
  assert.equal(second.hooks?.PreToolUse?.length, 2, "no 'command-hook'/'zone-guard' substring in the command -> not recognized as a prior install, both entries kept (documented, matches the ported algorithm)");
});

test("mergeSettings: preserves unrelated top-level keys (e.g. statusline)", () => {
  const cfg: SettingsConfig = { statusline: { type: "command", command: "x" } };
  const out = mergeSettings(cfg, "h", "t");
  assert.deepEqual(out.statusline, { type: "command", command: "x" });
});

test("renderSettings: pretty-printed JSON (indent 2)", () => {
  const text = renderSettings({ a: 1 });
  assert.equal(text, JSON.stringify({ a: 1 }, null, 2));
});

// ---------------------------------------------------------------------------
// runMergeSettingsCli (fake fs deps — contract L-3, no real fs needed)
// ---------------------------------------------------------------------------

function fakeDeps(initial?: string): { deps: MergeSettingsCliDeps; written: Map<string, string> } {
  const files = new Map<string, string>();
  if (initial !== undefined) files.set("/settings.json", initial);
  const written = new Map<string, string>();
  const deps: MergeSettingsCliDeps = {
    exists: (p) => files.has(p),
    readFile: (p) => files.get(p) ?? "",
    writeFile: (p, c) => {
      written.set(p, c);
      files.set(p, c);
    },
  };
  return { deps, written };
}

test("runMergeSettingsCli: missing args -> exit 2 usage error", () => {
  const { deps } = fakeDeps();
  const out = runMergeSettingsCli(["/settings.json"], deps);
  assert.equal(out.exitCode, 2);
  assert.match(out.stderr, /usage:/);
});

test("runMergeSettingsCli: no existing settings.json -> writes merged file, exit 0", () => {
  const { deps, written } = fakeDeps();
  const out = runMergeSettingsCli(["/settings.json", "node hook.ts", "node tel.ts"], deps);
  assert.equal(out.exitCode, 0);
  assert.match(out.stdout, /\[sync\]/);
  const written_ = JSON.parse(written.get("/settings.json")!);
  assert.deepEqual(written_.permissions.deny, DENY_DEFAULTS);
});

test("runMergeSettingsCli: malformed existing JSON -> treated as empty cfg (python parity: except Exception: cfg = {})", () => {
  const { deps, written } = fakeDeps("{not json");
  const out = runMergeSettingsCli(["/settings.json", "h", "t"], deps);
  assert.equal(out.exitCode, 0);
  const cfg = JSON.parse(written.get("/settings.json")!);
  assert.deepEqual(cfg.permissions.deny, DENY_DEFAULTS);
});

test("runMergeSettingsCli: --check -> reports would-change/in-sync, writes nothing", () => {
  const { deps, written } = fakeDeps();
  const out = runMergeSettingsCli(["/settings.json", "h", "t", "--check"], deps);
  assert.equal(out.exitCode, 0);
  assert.match(out.stdout, /\[check\] settings\.json: would change/);
  assert.equal(written.size, 0);
});

test("runMergeSettingsCli: --check against already-merged content -> in sync", () => {
  const hookCmd = 'node "/repo/core/src/shim/command-hook.ts" claude';
  const tel = 'node "/repo/core/src/ops/telemetry-hook.ts"';
  const { deps: seedDeps, written: seedWritten } = fakeDeps();
  runMergeSettingsCli(["/settings.json", hookCmd, tel], seedDeps);
  const merged = seedWritten.get("/settings.json")!;

  const { deps, written } = fakeDeps(merged);
  const out = runMergeSettingsCli(["/settings.json", hookCmd, tel, "--check"], deps);
  assert.match(out.stdout, /in sync/);
  assert.equal(written.size, 0);
});
