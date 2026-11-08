/**
 * T8 H1 (`.workflow/tasks/t8-status-quo-holes.md`) — PowerShell tool through
 * the hook: raw git -> rail stir, security floor, protected writes, worker
 * allow-lane; reads / in-zone writes / rail CLI -> allow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolvePolicy, type Policy } from "../src/policy/policy.ts";
import { classifyPowerShell, extractPsWriteTargets } from "../src/classify/powershell.ts";
import { runHook, processInput, type HookDeps } from "../src/shim/command-hook.ts";

const ROOT = "C:/repo";
const ZONE = { allow: ["core/**"], deny: [".omp"] };

function pol(profile: Policy["profile"] = "guarded") {
  return resolvePolicy({ explicitProfile: profile, interactive: true });
}

function worker(cmd: string) {
  return classifyPowerShell(cmd, { policy: pol(), actor: "worker", zone: ZONE, repoRoot: ROOT }).decision;
}

function operator(cmd: string, profile: Policy["profile"] = "guarded") {
  return classifyPowerShell(cmd, { policy: pol(profile), actor: "operator", repoRoot: ROOT }).decision;
}

// --- raw git (rail stir) ----------------------------------------------------

for (const cmd of [
  "git commit -m x",
  "& git.exe commit -m x",
  '& "C:\\Program Files\\Git\\cmd\\git.exe" commit -m x',
  "GIT.EXE commit -m x",
]) {
  test(`PS git: ${JSON.stringify(cmd)} guarded -> rail (hook maps to deny)`, () => {
    assert.equal(operator(cmd), "rail");
  });
}

for (const cmd of ["git push", "git reset --hard", "git rebase -i", "git branch -D f", "Set-Location x; git merge b"]) {
  test(`PS git: ${JSON.stringify(cmd)} guarded -> deny`, () => {
    assert.equal(operator(cmd), "deny");
  });
}

test("PS git: read-only git -> allow", () => {
  assert.equal(operator("git status; git log -1; git diff"), "allow");
});

test("PS git: rail off (profile off) -> raw git allow (same as Bash)", () => {
  assert.equal(operator("git commit -m x", "off"), "allow");
});

// --- backtick escape bypass (T8-H2 CRITICAL) --------------------------------

test("PS backtick bypass: g`it commit -m x guarded -> rail (same as plain git commit)", () => {
  assert.equal(operator("g`it commit -m x"), "rail");
});

test("PS backtick bypass: Remove-I`tem -Recurse -Force C:\\x -> deny even at profile off", () => {
  assert.equal(operator("Remove-I`tem -Recurse -Force C:\\x", "off"), "deny");
});

test("PS backtick bypass: [IO.Directory]::Del`ete('x', $true) -> deny even at profile off", () => {
  assert.equal(operator("[IO.Directory]::Del`ete('x', $true)", "off"), "deny");
});

test("PS backtick bypass: line-continuation git `\\n commit -m x guarded -> rail", () => {
  assert.equal(operator("git `\ncommit -m x"), "rail");
});

test("PS backtick: benign backtick-n inside a string stays allow", () => {
  assert.equal(operator('Write-Output "a`nb"'), "allow");
});

// --- security floor ---------------------------------------------------------

for (const cmd of [
  "Remove-Item -Recurse -Force build",
  "Remove-Item build -Force -Recurse",
  "remove-item -r -fo build",
  "rm -r -fo x",
  "ri x -Force -Recurse:$true",
  "Get-ChildItem | Remove-Item -Recurse -Force",
  "cmd /c rd /s /q build",
  "[IO.Directory]::Delete('build', $true)",
  "rm -rf /",
]) {
  test(`PS security-floor: ${JSON.stringify(cmd)} -> deny even at profile off`, () => {
    assert.equal(operator(cmd, "off"), "deny");
  });
}

test("PS security-floor: non-forced / non-recursive Remove-Item is not a floor hit", () => {
  assert.equal(operator("Remove-Item build -Recurse", "off"), "allow");
  assert.equal(operator("Remove-Item build -Force", "off"), "allow");
});

// --- protected writes -------------------------------------------------------

for (const cmd of [
  "Set-Content .git/config x",
  "Set-Content -Value x -Path .git/config",
  "Add-Content -LiteralPath .git\\hooks\\pre-commit 'x'",
  "'x' | Out-File -FilePath .git/x",
  "echo x > .git/x",
  "echo x >> .git/x",
  "echo x *> .git/x",
  "New-Item -ItemType File .git/x",
  "New-Item -Path .git -Name x",
  "Copy-Item a -Destination .git/x",
  "Move-Item a .git/x",
  "Remove-Item .git/index",
  "Rename-Item .git/HEAD H2",
  "[System.IO.File]::WriteAllText('.git/x', 'y')",
  "[IO.File]::AppendAllText(\".git/x\", 'y')",
  "Set-Location .git; Set-Content config x",
  "cd .git; 'x' > config",
  "Set-Content .GIT/config x",
  "Get-ChildItem | ForEach-Object { Remove-Item .git/x }",
]) {
  test(`PS protected (operator guarded, .git floor): ${JSON.stringify(cmd)} -> deny`, () => {
    assert.equal(operator(cmd), "deny");
  });
}

test("PS protected: worker zone.deny (.omp) -> deny", () => {
  assert.equal(worker("Remove-Item core/../.omp/x"), "deny");
  assert.equal(worker("Set-Content .omp/config x"), "deny");
});

// --- reads / out-of-protected writes (operator) -> allow --------------------

for (const cmd of [
  "Get-Content .git/config",
  "Select-String -Path .omp/x -Pattern foo",
  "Test-Path .git",
  "Get-ChildItem .git -Recurse",
  "Set-Content out.txt x",
  "echo x > out.txt",
  "Copy-Item docs/a backup.txt",
  'node core/src/rails/cli.ts commit -m "msg"',
  'node "$env:CLAUDE_PROJECT_DIR/core/src/rails/cli.ts" push --pr',
]) {
  test(`PS allow (operator guarded): ${JSON.stringify(cmd)}`, () => {
    assert.equal(operator(cmd), "allow");
  });
}

// --- worker allow-lane ------------------------------------------------------

for (const cmd of [
  "Set-Content -Path core/a.txt -Value hi",
  "set-content core/a.txt 'a b c'",
  "Add-Content core\\x.txt y",
  "New-Item -ItemType File core/x.ts",
  "New-Item -Path core -Name x.ts",
  "Out-File -FilePath core/o.txt -Encoding utf8",
  "echo x > core/y",
  "echo x 2>&1 > core/z",
  "echo x > $null",
  "Copy-Item docs/a core/b",
  "Copy-Item -Destination core/b -Path docs/a",
  "Remove-Item core/x -Recurse",
  "Remove-Item core/a, core/b",
  "Remove-Item core/x -ErrorAction SilentlyContinue",
  "Rename-Item core/a.txt b.txt",
  "[IO.File]::WriteAllText('core/x', 'y')",
  "cd core; Set-Content a.txt x",
  "Remove-Item C:/repo/core/x",
  "Get-Content docs/a > core/b",
  "Get-Content docs/a",
  "Select-String -Path docs/*.md -Pattern x",
]) {
  test(`PS worker in-zone / read: ${JSON.stringify(cmd)} -> allow`, () => {
    assert.equal(worker(cmd), "allow");
  });
}

for (const cmd of [
  "Set-Content -Value hi -Path docs/a.txt",
  "New-Item -ItemType File docs/x",
  "'x' | Out-File docs/o.txt",
  "echo x *> docs/y",
  "Copy-Item core/a docs/b",
  "Move-Item docs/a core/b",
  "Rename-Item core/a.txt ../docs/b.txt",
  "Remove-Item core/a, docs/b",
  "[System.IO.File]::WriteAllText(\"docs/x\", 'y')",
  "Get-ChildItem | ForEach-Object { Remove-Item docs/x }",
  'Write-Host "$(Remove-Item docs/q)"',
  'powershell -Command "Set-Content docs/x y"',
  "Set-Content -Path $p -Value x",
  "Push-Location docs; Set-Content a x; Pop-Location",
  "Remove-Item D:/elsewhere/x",
  "touch docs/x",
]) {
  test(`PS worker out-of-zone: ${JSON.stringify(cmd)} -> deny`, () => {
    assert.equal(worker(cmd), "deny");
  });
}

test("extractPsWriteTargets: param binding ignores values/switches, joins -Name/-NewName, tracks Set-Location", () => {
  assert.deepEqual(extractPsWriteTargets("Set-Content -Value 'a b' -Path x.txt -Encoding utf8"), ["x.txt"]);
  assert.deepEqual(extractPsWriteTargets("New-Item -Path d -Name f.txt -ItemType File"), ["d/f.txt"]);
  assert.deepEqual(extractPsWriteTargets("Rename-Item d/a.txt b.txt"), ["d/a.txt", "d/b.txt"]);
  assert.deepEqual(extractPsWriteTargets("Set-Location sub; Remove-Item x"), ["sub/x"]);
  assert.deepEqual(extractPsWriteTargets("Copy-Item a"), ["."]);
});

// --- deep nesting parse-failure (T8-H2 HIGH) --------------------------------

test("PS deep nesting: 5000-deep (-nest wrapping a protected write -> deny (parse-failure fail-closed)", () => {
  const cmd = "(".repeat(5000) + "Set-Content .git/config x" + ")".repeat(5000);
  const dec = classifyPowerShell(cmd, { policy: pol(), actor: "operator", repoRoot: ROOT });
  assert.equal(dec.decision, "deny");
  assert.match(dec.reason ?? "", /не разобрана/);
});

// --- hook routing -----------------------------------------------------------

function deps(policy: Policy, zone?: { allow: string[]; deny: string[] }): HookDeps {
  return { loadPolicy: () => ({ policy, warnings: [] }), loadZone: () => zone };
}

test("runHook: PowerShell tool is classified (raw git commit guarded -> deny with rail stir)", () => {
  const dec = runHook({ tool: "PowerShell", command: "git commit -m x" }, deps({ profile: "guarded" }));
  assert.equal(dec.decision, "deny");
  assert.match(dec.reason ?? "", /рельс/);
});

test("runHook: PowerShell worker without zone file -> any write denied, read allowed", () => {
  const d = deps({ profile: "guarded" });
  assert.equal(
    runHook({ tool: "PowerShell", command: "Set-Content core/a x", actorSignal: "executor", cwd: ROOT }, d).decision,
    "deny"
  );
  assert.equal(
    runHook({ tool: "PowerShell", command: "Get-Content core/a", actorSignal: "executor", cwd: ROOT }, d).decision,
    "allow"
  );
});

test("runHook: PowerShell worker with zone file -> in-zone allow, out-of-zone deny", () => {
  const d = deps({ profile: "guarded" }, { allow: ["core/**"], deny: [".workflow/active-zone.json"] });
  assert.equal(
    runHook({ tool: "PowerShell", command: "Set-Content core/a x", actorSignal: "executor", cwd: ROOT }, d).decision,
    "allow"
  );
  assert.equal(
    runHook({ tool: "PowerShell", command: "Set-Content docs/a x", actorSignal: "executor", cwd: ROOT }, d).decision,
    "deny"
  );
  assert.equal(
    runHook(
      { tool: "PowerShell", command: "Set-Content .workflow/active-zone.json '{}'", actorSignal: "executor", cwd: ROOT },
      d
    ).decision,
    "deny"
  );
});

test("processInput(claude): PowerShell payload -> deny JSON for Remove-Item -Recurse -Force", () => {
  const raw = JSON.stringify({
    tool_name: "PowerShell",
    tool_input: { command: "Remove-Item -Recurse -Force build" },
    cwd: ROOT,
  });
  const out = processInput("claude", raw, deps({ profile: "off" }));
  assert.match(out, /"permissionDecision":"deny"/);
});

test("processInput(claude): PowerShell read payload -> silent allow", () => {
  const raw = JSON.stringify({ tool_name: "PowerShell", tool_input: { command: "Get-Content .git/config" }, cwd: ROOT });
  assert.equal(processInput("claude", raw, deps({ profile: "guarded" })), "");
});
