/**
 * Command-hook shim (T5b) — CC/Codex node-перехватчик через ядро.
 * Source: docs/design/enforcement-governance-redesign-2026-09-18.md
 *   AD-native-render (policy-as-data + единый TS-классификатор рендерятся в
 *   нативный перехватчик: CC/Codex = command-hook(node)), AD-worker-zone-always,
 *   AD-codex-degrade.
 *
 * Reference (READ, NOT copied — re-ported onto the new governance-aware core):
 * `.claude/hooks/zone-guard.py` — pre-governance CC PreToolUse hook. It carried
 * its OWN `path_set`/intent-classification (via `tools/policy/intent.py`),
 * no profile/actor concept. This shim carries ZERO classification logic of
 * its own (contract L-2) — routing only; every verdict comes from
 * `classify`/`classifyPath` (T2) fed by `buildPolicy`/`resolveActor`/
 * `resolveInteractive` (T5a wiring).
 *
 * T7-6 (contract L-4, current state — supersedes the original T5b "HARD
 * SCOPE: BUILD+TEST only" note below): this module IS live-wired now. The
 * installers (`tools/install-claude.sh`/`.ps1` step 3, via
 * `core/src/ops/merge-settings.ts`) splice `node command-hook.ts claude` into
 * `.claude/settings.json`'s `PreToolUse` hook — it IS the active enforcement
 * PreToolUse hook. The old python `.claude/hooks/zone-guard.py` is DELETED
 * (retired in T7); the "Reference (READ, NOT copied)" paragraph above
 * describes that file's role BEFORE the T6/T7 wiring, not a currently-live
 * co-existing hook.
 *
 * Type-strip-safe (no enum/namespace/param-props/decorators), zero external
 * deps — only `node:*` builtins + the core modules below.
 */
import { existsSync } from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import type { Policy, ResolvedPolicy } from "../policy/policy.ts";
import type { Profile } from "../policy/profile.ts";
import { classify, type Actor, type Verdict, type ZoneOptions } from "../classify/classify.ts";
import { classifyPath, normalizePath, pathMatches } from "../classify/path-zone.ts";
import { classifyPowerShell, extractPsRedirectTargets } from "../classify/powershell.ts";
import { extractBashRedirectTargets } from "../classify/zone.ts";
import { anyOpenExecuteStage } from "../stage/execute-open.ts";
import {
  loadPolicyFile,
  loadActiveZoneFile,
  ACTIVE_ZONE_PATH,
  buildPolicy,
  resolveActor,
  resolveInteractive,
} from "../wiring/policy-source.ts";

// ---------------------------------------------------------------------------
// Normalized input/output (harness-agnostic core of the shim)
// ---------------------------------------------------------------------------

/**
 * Normalized hook input — a per-client adapter (`parseClaudeInput`/
 * `parseCodexInput` below) is responsible for producing this shape from a
 * raw stdin payload. `runHook` never touches a raw client payload directly.
 */
export interface HookInput {
  tool: string;
  filePath?: string;
  command?: string;
  cwd?: string;
  /** Raw, not-yet-normalized actor signal — fed to `resolveActor` (wiring, fail-closed). */
  actorSignal?: unknown;
  isTTY?: boolean;
  zone?: { allow?: string[]; deny?: string[] };
  launchProfile?: Profile;
}

/** Normalized hook decision — a per-client formatter turns this into the client's stdout wire-format. */
export interface HookDecision {
  decision: "allow" | "deny";
  reason?: string;
}

/**
 * Injectable policy source (contract: "инъектируемый policy-источник для
 * тестов, БЕЗ прямого fs в ядре-функции"). Production wiring is a thin
 * wrapper over `loadPolicyFile` (see `main`); tests pass a stub.
 */
export interface HookDeps {
  loadPolicy(cwd?: string): { policy: Policy; warnings: string[] };
  /**
   * Contract T7-0 L-1 — worker zone-source (`.workflow/active-zone.json`).
   * Injectable (same shape/rationale as `loadPolicy`) — `runHook` calls this
   * ONLY for `actor === "worker"` (never for `operator`, contract L-1: the
   * file is not even read on that path). Optional so pre-T7-0 `HookDeps`
   * literals (e.g. `omp-adapter.ts`/`opencode-adapter.ts` callers, tests
   * that pass `zone` via `HookInput.zone` directly) keep compiling —
   * `undefined` degrades to "no zone loaded" (fail-closed, same as a
   * missing/malformed file).
   */
  loadZone?(cwd?: string): ZoneOptions | undefined;
  /**
   * Design C create-only task-files — injectable existence probe.
   * Production default `fs.existsSync` (applied in `runHook`).
   */
  exists?(absPath: string): boolean;
  /**
   * Design C execute-stage lead freeze — injectable open-execute probe.
   * Production default `anyOpenExecuteStage(cwd)` (applied in `runHook`).
   */
  isExecuteOpen?(cwd?: string): boolean;
}

const PATH_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Verdict -> HookDecision (contract: deny+rail -> deny, allow -> allow — a raw-git rail-verdict is a hard stir-to-rail, not a soft allow). */
function toDecision(verdict: Verdict): HookDecision {
  if (verdict.decision === "allow") return { decision: "allow" };
  return { decision: "deny", reason: verdict.reason };
}

/**
 * Design C AD-session-write-protected-set — command-hook-only operator
 * pre-write deny (NOT L1 classifyPath / gatedCommit). Unions
 * `session_write_protected` ∪ `enforcement_paths`, then create-only for
 * existing `.workflow/tasks/` + `.md` paths.
 */
export function sessionWriteProtectedVerdict(
  filePath: string,
  policy: ResolvedPolicy,
  repoRoot: string | undefined,
  existsFn: (absPath: string) => boolean
): Verdict | null {
  const path = normalizePath(filePath, repoRoot);
  if (path === null) return null; // outside-repo handled by classifyPath

  const globs = [...policy.session_write_protected, ...policy.enforcement_paths];
  if (globs.length > 0 && pathMatches(path, globs)) {
    return {
      decision: "deny",
      reason: `zone-guard: session_write_protected — operator write to '${path}' denied.`,
    };
  }

  if (path.startsWith(".workflow/tasks/") && path.endsWith(".md")) {
    const absPath = repoRoot ? nodePath.resolve(repoRoot, path) : nodePath.resolve(path);
    if (existsFn(absPath)) {
      return {
        decision: "deny",
        reason: `zone-guard: session_write_protected — existing task-file is create-only; overwrite of '${path}' denied.`,
      };
    }
  }

  return null;
}

/**
 * Design C execute-stage lead freeze — after SWP. When any execute journal
 * is open: allow `.workflow/ledger/**` and new (absent) `.workflow/tasks/*.md`;
 * deny all other in-repo writes. Outside-repo → null (classifyPath/external).
 */
export function leadFreezeVerdict(
  filePath: string,
  repoRoot: string | undefined,
  existsFn: (absPath: string) => boolean
): Verdict | null {
  const path = normalizePath(filePath, repoRoot);
  if (path === null) return null;

  if (pathMatches(path, [".workflow/ledger/**"])) {
    return null;
  }

  if (path.startsWith(".workflow/tasks/") && path.endsWith(".md")) {
    const absPath = repoRoot ? nodePath.resolve(repoRoot, path) : nodePath.resolve(path);
    if (!existsFn(absPath)) {
      return null; // new task-file create allowed under freeze
    }
  }

  return {
    decision: "deny",
    reason: `zone-guard: lead freeze — execute stage open; operator write to '${path}' denied.`,
  };
}

/**
 * Contract A — after Bash/PS classify allow, apply PATH_TOOLS SWP ∪
 * create-only ∪ execute lead-freeze to each extracted shell write target.
 * Empty targets → null (leave classify verdict unchanged).
 */
function operatorShellWriteGuard(
  targets: readonly string[],
  policy: ResolvedPolicy,
  cwd: string | undefined,
  deps: HookDeps
): HookDecision | null {
  if (targets.length === 0) return null;
  const existsFn = deps.exists ?? existsSync;
  const executeOpen =
    deps.isExecuteOpen?.(cwd) ?? anyOpenExecuteStage(cwd ?? ".");
  for (const filePath of targets) {
    const swp = sessionWriteProtectedVerdict(filePath, policy, cwd, existsFn);
    if (swp !== null) return toDecision(swp);
    if (executeOpen) {
      const freeze = leadFreezeVerdict(filePath, cwd, existsFn);
      if (freeze !== null) return toDecision(freeze);
    }
  }
  return null;
}

/**
 * Pure classification logic (contract: "ЧИСТАЯ логика", no direct fs, no
 * try/catch swallowing — errors from `deps.loadPolicy`/`classify*` propagate
 * to the caller; fail-open lives in `processInput`/`main`, not here).
 *
 * Steps (contract):
 *  1. actor/interactive resolution via wiring (fail-closed, never overridden here).
 *  2. policy load + build (launch-param > policy-file > interactivity-default).
 *  3. tool-routing: Write/Edit/MultiEdit/NotebookEdit -> classifyPath;
 *     then Design C SWP for operator only (command-hook, not L1);
 *     then execute-stage lead freeze (after SWP) for operator only;
 *     Bash -> classify; PowerShell -> classifyPowerShell (T8 H1);
 *     then Contract A shell SWP/freeze for operator redirect targets;
 *     everything else -> allow.
 */
export function runHook(input: HookInput, deps: HookDeps): HookDecision {
  const actor: Actor = resolveActor({ subagentMarker: input.actorSignal });
  const interactive = resolveInteractive({ isTTY: input.isTTY });

  const { policy } = deps.loadPolicy(input.cwd);
  const { resolved } = buildPolicy({ policy, launchProfile: input.launchProfile, interactive });

  // Contract T7-0 L-1: `input.zone` (adapter/test-supplied explicit override)
  // wins when present. Otherwise, ONLY for `actor === "worker"`, load
  // `.workflow/active-zone.json` via the injectable `deps.loadZone` —
  // `operator`'s zone file is NEVER read (contract L-1, no branch below
  // calls `deps.loadZone` for operator). Missing/malformed file / no
  // `deps.loadZone` at all -> `undefined` -> the existing fail-closed deny
  // (D9) for `actor === "worker"` paths below, unchanged for `operator`.
  //
  // Amend A1: for `actor === "worker"`, an unloaded zone (no `deps.loadZone`
  // / file absent / malformed) degrades to `{ allow: [] }` rather than
  // `undefined`. `classifyPath` already treats `zone?.allow ?? []` the same
  // as an explicit `{ allow: [] }` (unchanged), but `classify()`'s bash
  // allow-lane (T7-0 L-3) only engages when `zone.allow` is EXPLICITLY
  // present (`undefined` -> bash keeps its pre-L-3 deny-only behaviour,
  // i.e. open outside `zone.deny`). Without this, a worker with no zone
  // file loaded would deny Write/Edit (D9) but leave Bash open — the L-3
  // gap this amend closes. `classify()` itself is unchanged.
  let zone: ZoneOptions | undefined =
    input.zone ?? (actor === "worker" ? deps.loadZone?.(input.cwd) : undefined);
  if (actor === "worker" && zone === undefined) {
    zone = { allow: [] };
  }

  if (PATH_TOOLS.has(input.tool)) {
    const filePath = input.filePath ?? "";
    if (filePath === "") return { decision: "allow" }; // nothing to check
    const verdict = classifyPath(filePath, {
      actor,
      policy: resolved,
      zone,
      repoRoot: input.cwd,
    });
    if (verdict.decision === "deny") return toDecision(verdict);

    // Design C: SWP ∪ enforcement + create-only — hook-only, actor=operator.
    // Then execute-stage lead freeze (after SWP) when any execute journal is open.
    if (actor === "operator") {
      const existsFn = deps.exists ?? existsSync;
      const swp = sessionWriteProtectedVerdict(filePath, resolved, input.cwd, existsFn);
      if (swp !== null) return toDecision(swp);

      const executeOpen =
        deps.isExecuteOpen?.(input.cwd) ?? anyOpenExecuteStage(input.cwd ?? ".");
      if (executeOpen) {
        const freeze = leadFreezeVerdict(filePath, input.cwd, existsFn);
        if (freeze !== null) return toDecision(freeze);
      }
    }
    return { decision: "allow" };
  }

  // T8 H1: the CC `PowerShell` tool — same verdict model as Bash (security
  // floor, raw git -> rail stir, protected-write, worker allow-lane), PS-aware
  // parsing (`classify/powershell.ts`).
  if (input.tool === "PowerShell") {
    const verdict = classifyPowerShell(input.command ?? "", {
      policy: resolved,
      actor,
      zone,
      repoRoot: input.cwd,
    });
    // deny + rail both map to HookDecision deny via toDecision.
    if (verdict.decision !== "allow") return toDecision(verdict);
    // Contract A: after allow, operator redirect targets hit SWP ∪ freeze.
    if (actor === "operator") {
      const guard = operatorShellWriteGuard(
        extractPsRedirectTargets(input.command ?? ""),
        resolved,
        input.cwd,
        deps
      );
      if (guard !== null) return guard;
    }
    return { decision: "allow" };
  }

  if (input.tool === "Bash") {
    const verdict = classify(input.command ?? "", {
      policy: resolved,
      actor,
      zone,
      repoRoot: input.cwd,
    });
    // deny + rail both map to HookDecision deny via toDecision.
    if (verdict.decision !== "allow") return toDecision(verdict);
    // Contract A: Cursor Shell maps to Bash — same SWP ∪ freeze after allow.
    if (actor === "operator") {
      const guard = operatorShellWriteGuard(
        extractBashRedirectTargets(input.command ?? ""),
        resolved,
        input.cwd,
        deps
      );
      if (guard !== null) return guard;
    }
    return { decision: "allow" };
  }

  return { decision: "allow" };
}

// ---------------------------------------------------------------------------
// Claude Code adapter
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Parse a Claude Code PreToolUse stdin payload (`.claude/hooks/zone-guard.py`
 * §contract: `{tool_name, tool_input, cwd}`) into `HookInput`.
 *
 * `actorSignal`/`isTTY` extraction (contract §E-open): the CC PreToolUse
 * stdin schema does not (at write-time) document a stable "this call was
 * issued by a subagent" / "is the parent session a TTY" field. The keys
 * below are a best-effort, normalized guess — HARNESS-SPECIFIC, VERIFY LIVE
 * IN T6. `resolveActor`/`resolveInteractive` are fail-closed regardless
 * (absent/unknown signal never relaxes the verdict), so an unverified/wrong
 * key here degrades to the strict path, never the permissive one.
 */
export function parseClaudeInput(raw: unknown): HookInput {
  const data = isRecord(raw) ? raw : {};
  const tool = typeof data.tool_name === "string" ? data.tool_name : "";

  const toolInput = isRecord(data.tool_input) ? data.tool_input : {};
  const filePath =
    typeof toolInput.file_path === "string"
      ? toolInput.file_path
      : typeof toolInput.notebook_path === "string"
        ? toolInput.notebook_path
        : undefined;
  const command = typeof toolInput.command === "string" ? toolInput.command : undefined;

  const cwd = typeof data.cwd === "string" ? data.cwd : undefined;

  // Best-effort, unverified (§E-open, see doc-comment above).
  const actorSignal: unknown =
    (typeof data.agent_id === "string" && data.agent_id) ||
    (typeof data.subagent_type === "string" && data.subagent_type) ||
    (typeof data.isSubagent === "boolean" && data.isSubagent) ||
    undefined;
  const isTTY = typeof data.isTTY === "boolean" ? data.isTTY : undefined;

  return { tool, filePath, command, cwd, actorSignal, isTTY };
}

/**
 * Format a `HookDecision` as the CC PreToolUse stdout contract
 * (`.claude/hooks/zone-guard.py` §contract): silent allow (empty string,
 * caller writes nothing / exits 0); deny -> `hookSpecificOutput` JSON.
 */
export function formatClaudeOutput(decision: HookDecision): string {
  if (decision.decision === "allow") return "";
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: decision.reason ?? "zone-guard: запрещено политикой.",
    },
  });
}

// ---------------------------------------------------------------------------
// Codex adapter — AD-codex-degrade: Codex hooks are experimental and, at
// write-time, not live on Windows (this environment). This adapter is
// UNVERIFIED against a real Codex runtime — tests below are synthetic only,
// exercising the parse/format shape, not a captured live payload.
// ---------------------------------------------------------------------------

/**
 * Parse a Codex PreToolUse-equivalent stdin payload into `HookInput`.
 *
 * Shape chosen deliberately symmetric to `parseClaudeInput` (`tool` +
 * nested `input.{file_path,command}` + `cwd`) since no confirmed-live Codex
 * hook schema is available here (contract §E-open / AD-codex-degrade) —
 * degrade documented, not hidden. `actorSignal`/`isTTY` are not modeled for
 * Codex here (undefined -> fail-closed defaults via `resolveActor`/
 * `resolveInteractive`, same as an absent CC signal).
 */
export function parseCodexInput(raw: unknown): HookInput {
  const data = isRecord(raw) ? raw : {};
  const tool = typeof data.tool === "string" ? data.tool : "";

  const inner = isRecord(data.input) ? data.input : {};
  const filePath = typeof inner.file_path === "string" ? inner.file_path : undefined;
  const command = typeof inner.command === "string" ? inner.command : undefined;

  const cwd = typeof data.cwd === "string" ? data.cwd : undefined;

  return { tool, filePath, command, cwd };
}

/**
 * Format a `HookDecision` for Codex. Contract offers two documented forms
 * for a PreToolUse deny — a JSON `permissionDecision:"deny"` payload, or a
 * bare `exit 2`. The JSON form is chosen here, symmetric to
 * `formatClaudeOutput` (no `hookSpecificOutput`/`hookEventName` envelope —
 * that CC-specific wrapper is not part of the (unverified) Codex contract).
 */
export function formatCodexOutput(decision: HookDecision): string {
  if (decision.decision === "allow") return "";
  return JSON.stringify({
    permissionDecision: "deny",
    permissionDecisionReason: decision.reason ?? "zone-guard: запрещено политикой.",
  });
}

// ---------------------------------------------------------------------------
// Cursor adapter — docs/design/cursor-port-2026-10-28.md §2
// Deny claimed ONLY for preToolUse / beforeShellExecution. Exit code 2 =
// ASSUME per Cursor docs (2026-10-28): equivalent to permission:"deny".
// afterFileEdit / subagentStart / subagentStop → allow (exit 0), no deny.
// Shell → Bash class; Write → Write; Glob unmapped (empty tool → allow).
// ---------------------------------------------------------------------------

const CURSOR_DENY_EVENTS = new Set(["preToolUse", "beforeShellExecution"]);

/** Map a Cursor tool name onto the classifier's tool vocabulary. Unmapped → "". */
export function mapCursorTool(name: string): string {
  if (name === "Shell") return "Bash";
  if (name === "Write") return "Write";
  return "";
}

/**
 * Parse a Cursor hooks.json stdin payload into `HookInput`.
 * Event from `hook_event_name`. beforeShellExecution has top-level `command`
 * (no tool_name) → treated as Shell. Write path from tool_input.file_path /
 * path / filePath, or afterFileEdit top-level file_path (not used for deny).
 */
export function parseCursorInput(raw: unknown): HookInput & { event: string } {
  const data = isRecord(raw) ? raw : {};
  const event = typeof data.hook_event_name === "string" ? data.hook_event_name : "";

  let toolName = typeof data.tool_name === "string" ? data.tool_name : "";
  const toolInput = isRecord(data.tool_input) ? data.tool_input : {};

  let command: string | undefined =
    typeof toolInput.command === "string" ? toolInput.command : undefined;
  let filePath: string | undefined =
    typeof toolInput.file_path === "string"
      ? toolInput.file_path
      : typeof toolInput.path === "string"
        ? toolInput.path
        : typeof toolInput.filePath === "string"
          ? toolInput.filePath
          : undefined;

  if (event === "beforeShellExecution") {
    toolName = "Shell";
    if (typeof data.command === "string") command = data.command;
  }
  if (event === "afterFileEdit" && typeof data.file_path === "string") {
    filePath = data.file_path;
    if (!toolName) toolName = "Write";
  }

  const cwd =
    typeof data.cwd === "string"
      ? data.cwd
      : Array.isArray(data.workspace_roots) && typeof data.workspace_roots[0] === "string"
        ? data.workspace_roots[0]
        : undefined;

  const actorSignal: unknown =
    (typeof data.agent_id === "string" && data.agent_id) ||
    (typeof data.subagent_type === "string" && data.subagent_type) ||
    (typeof data.isSubagent === "boolean" && data.isSubagent) ||
    undefined;

  return {
    tool: mapCursorTool(toolName),
    filePath,
    command,
    cwd,
    actorSignal,
    event,
  };
}

export interface CursorHookResult {
  output: string;
  /** 0 = allow; 2 = deny (ASSUME — Cursor docs 2026-10-28). */
  exitCode: number;
}

/**
 * Cursor hook decision. Deny (exit 2 + optional permission JSON) only for
 * preToolUse / beforeShellExecution. Other registered events → exit 0 allow.
 * Fail-open: any throw → exit 0.
 */
export function applyCursorHook(raw: unknown, deps: HookDeps): CursorHookResult {
  try {
    const parsed = parseCursorInput(raw);
    if (!CURSOR_DENY_EVENTS.has(parsed.event)) {
      return { output: "", exitCode: 0 };
    }
    if (parsed.tool === "") {
      return { output: "", exitCode: 0 };
    }
    const decision = runHook(parsed, deps);
    if (decision.decision === "allow") return { output: "", exitCode: 0 };
    const reason = decision.reason ?? "zone-guard: запрещено политикой.";
    // ASSUME: exit 2 blocks; JSON permission also emitted for clients that read stdout.
    return {
      output: JSON.stringify({
        permission: "deny",
        user_message: reason,
        agent_message: reason,
      }),
      exitCode: 2,
    };
  } catch {
    return { output: "", exitCode: 0 };
  }
}

// ---------------------------------------------------------------------------
// main — thin I/O shell (fail-open, L-4)
// ---------------------------------------------------------------------------

export type Client = "claude" | "codex" | "cursor";

/**
 * Parse raw stdin text -> run the classification -> format the client's
 * stdout string. This is the fail-open boundary (contract L-4): ANY error
 * (malformed stdin JSON, `deps.loadPolicy` throwing, a classifier throwing)
 * is swallowed here and degrades to a silent allow (`""`) — the hook must
 * never crash the tool-call stream. Exported separately from `main` so the
 * fail-open branch is unit-testable without mocking `process.stdin`.
 *
 * For `cursor`, stdout is the applyCursorHook output string; exit code is
 * handled by `main` / `applyCursorHook` (deny = 2 ASSUME), not by this return.
 */
export function processInput(client: Client, rawText: string, deps: HookDeps): string {
  try {
    const raw: unknown = JSON.parse(rawText);
    if (client === "cursor") {
      return applyCursorHook(raw, deps).output;
    }
    const input = client === "codex" ? parseCodexInput(raw) : parseClaudeInput(raw);
    const decision = runHook(input, deps);
    return client === "codex" ? formatCodexOutput(decision) : formatClaudeOutput(decision);
  } catch {
    return ""; // fail-open (L-4): tihiy allow, never propagate.
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    try {
      process.stdin.setEncoding("utf-8");
      process.stdin.on("data", (chunk) => {
        data += chunk;
      });
      process.stdin.on("end", () => resolve(data));
      process.stdin.on("error", () => resolve(""));
    } catch {
      resolve("");
    }
  });
}

/**
 * Production `HookDeps` for live port hooks / CLI: policy.yml + active-zone +
 * exists + execute-open probe. `cwd` is optional (reserved for call-site
 * clarity); each dep still resolves paths from the per-call `cwd` argument.
 */
export function prodHookDeps(_cwd?: string): HookDeps {
  return {
    loadPolicy: (cwd) => loadPolicyFile((cwd || ".") + "/policy.yml"),
    loadZone: (cwd) => loadActiveZoneFile((cwd || ".") + "/" + ACTIVE_ZONE_PATH),
    exists: existsSync,
    isExecuteOpen: (cwd) => anyOpenExecuteStage(cwd ?? "."),
  };
}

/** @deprecated Prefer `prodHookDeps` — kept as alias for internal CLI entry. */
function prodDeps(): HookDeps {
  return prodHookDeps();
}

/**
 * CLI entry point (contract `main(client)`): read stdin -> `processInput` ->
 * write the formatted output (if any) -> exit 0. Fail-open (L-4) wraps the
 * WHOLE body — even a `readStdin` failure must not exit non-zero.
 *
 * T7-6 (contract L-4, current state — supersedes the original T5b hard-scope
 * note): `main("claude")` IS invoked from `.claude/settings.json`'s
 * `PreToolUse` hook now (spliced in by the installers, see the module
 * doc-comment above) — live-wired, not build-only.
 */
export async function main(client: Client): Promise<void> {
  let exitCode = 0;
  try {
    const raw = await readStdin();
    if (client === "cursor") {
      let parsed: unknown = {};
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = {};
      }
      const result = applyCursorHook(parsed, prodDeps());
      if (result.output) process.stdout.write(result.output);
      exitCode = result.exitCode;
    } else {
      const output = processInput(client, raw, prodDeps());
      if (output) process.stdout.write(output);
    }
  } catch {
    // fail-open (L-4): never let the hook crash the tool-call stream.
    exitCode = 0;
  }
  process.exit(exitCode);
}

// Direct-run guard (`node core/src/shim/command-hook.ts [claude|codex|cursor]`) —
// inert under `node --test` / plain `import` (test files import the named
// exports above, they never execute this module as the process entry point).
if (process.argv[1]) {
  let isDirectRun = false;
  try {
    isDirectRun = fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    isDirectRun = false;
  }
  if (isDirectRun) {
    const arg = process.argv[2];
    const client: Client = arg === "codex" || arg === "cursor" ? arg : "claude";
    void main(client);
  }
}
