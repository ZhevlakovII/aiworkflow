/**
 * merge-settings (T7-6, contract L-3) — Node port of the python heredoc
 * `install-claude.sh` used to shell out to for its settings.json step (the
 * LAST python dependency in the node-installer surface — `install-claude.ps1`
 * already did this natively via `ConvertFrom-Json`/`Ensure-Prop`/
 * `Set-HookGroup`, see that file; this is the TS/POSIX-twin port of THAT
 * same algorithm, not a re-derivation).
 *
 * `mergeSettings` (pure): merge `permissions.deny` (append the 4 fixed
 * security-backstop entries, skip if already present) + `hooks.PreToolUse`/
 * `hooks.PostToolUse` (dedupe-by-tag-substring REPLACE semantics — a re-run
 * replaces a stale hook-group entry, e.g. the old python `zone-guard`/a
 * prior TS `command-hook` install, instead of duplicating it) — verbatim
 * parity with the retired python heredoc AND the still-live `install-claude.ps1`
 * `Ensure-Prop`/`Set-HookGroup` functions. Existing keys/values elsewhere in
 * `cfg` (statusline, ...) pass through untouched.
 *
 * Pure-core + thin-shell split (contract L-1, same pattern as
 * `./stats-cli.ts`/`./audit-commits-cli.ts`): `runMergeSettingsCli(argv, deps)`
 * is the injectable, testable layer. `main` is the real fs/argv/process.exit
 * shell (not unit-tested).
 */
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

export interface HookEntry {
  type: string;
  command: string;
}

export interface HookGroup {
  matcher: string;
  hooks: HookEntry[];
}

export interface SettingsConfig {
  permissions?: { deny?: string[]; [k: string]: unknown };
  hooks?: Record<string, HookGroup[]>;
  [k: string]: unknown;
}

/** The 4 fixed security-backstop deny entries (verbatim parity with the retired python heredoc / `install-claude.ps1`). */
export const DENY_DEFAULTS: readonly string[] = [
  "Bash(rm -rf:*)",
  "Bash(nc:*)",
  "Bash(ssh:*)",
  "PowerShell(Remove-Item -Recurse -Force:*)",
];

/** Required PreToolUse matcher minimum (must include PowerShell). */
export const PRETOOLUSE_MATCHER_REQUIRED =
  "Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit";

/**
 * Union of pipe-separated matcher tokens: required first, then any extra
 * tokens from `existing` (deduped, order-preserving). Reinstall must not
 * strip already-recorded tokens (e.g. PowerShell, or a user/extra tool X).
 */
export function unionMatcher(required: string, existing?: string): string {
  const split = (s: string): string[] =>
    s
      .split("|")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...split(required), ...split(existing ?? "")]) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out.join("|");
}

/**
 * Merge `permissions.deny` + `hooks.{PreToolUse,PostToolUse}` into `cfg`
 * (does not mutate the input). `hookCmd`/`tel` are the PreToolUse/PostToolUse
 * command strings (already absolute-path-rewritten by the caller).
 *
 * When replacing a PreToolUse/PostToolUse group (dedupe-by-tag), the new
 * matcher is `unionMatcher(required, displaced.matcher)` so reinstall never
 * strips already-recorded tokens.
 */
export function mergeSettings(cfg: SettingsConfig, hookCmd: string, tel: string): SettingsConfig {
  const out: SettingsConfig = { ...cfg };

  const perm = { ...(out.permissions ?? {}) };
  const deny = [...(perm.deny ?? [])];
  for (const d of DENY_DEFAULTS) {
    if (!deny.includes(d)) deny.push(d);
  }
  perm.deny = deny;
  out.permissions = perm;

  const hooks: Record<string, HookGroup[]> = { ...(out.hooks ?? {}) };
  const setGroup = (event: string, matcher: string, cmd: string, tags: readonly string[]): void => {
    const existing = hooks[event] ?? [];
    const isDisplaced = (g: HookGroup): boolean =>
      g.hooks.some((h) => tags.some((t) => (h.command ?? "").includes(t)));
    const displaced = existing.filter(isDisplaced);
    const kept = existing.filter((g) => !isDisplaced(g));
    let finalMatcher = matcher;
    for (const g of displaced) {
      finalMatcher = unionMatcher(finalMatcher, g.matcher ?? "");
    }
    hooks[event] = [...kept, { matcher: finalMatcher, hooks: [{ type: "command", command: cmd }] }];
  };
  setGroup("PreToolUse", PRETOOLUSE_MATCHER_REQUIRED, hookCmd, ["zone-guard", "command-hook"]);
  setGroup("PostToolUse", "", tel, ["telemetry"]);
  out.hooks = hooks;

  return out;
}

/** `JSON.stringify(cfg, null, 2)` — same shape as python's `json.dumps(cfg, indent=2, ensure_ascii=False)`. */
export function renderSettings(cfg: SettingsConfig): string {
  return JSON.stringify(cfg, null, 2);
}

// ---------------------------------------------------------------------------
// runMergeSettingsCli — injectable CLI layer
// ---------------------------------------------------------------------------

export interface MergeSettingsCliDeps {
  exists(p: string): boolean;
  readFile(p: string): string;
  writeFile(p: string, content: string): void;
}

export interface MergeSettingsCliOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * argv: `<settingsPath> <hookCmd> <tel> [--check]` — positional order mirrors
 * the retired python heredoc's `sys.argv[1..4]` (`set_dst hook_cmd tel check`).
 */
export function runMergeSettingsCli(argv: readonly string[], deps: MergeSettingsCliDeps): MergeSettingsCliOutput {
  const positional: string[] = [];
  let check = false;
  for (const a of argv) {
    if (a === "--check") check = true;
    else positional.push(a);
  }
  const [settingsPath, hookCmd, tel] = positional;
  if (!settingsPath || !hookCmd || !tel) {
    return {
      stdout: "",
      stderr: "usage: merge-settings <settingsPath> <hookCmd> <tel> [--check]",
      exitCode: 2,
    };
  }

  let cfg: SettingsConfig = {};
  const existed = deps.exists(settingsPath);
  if (existed) {
    try {
      cfg = JSON.parse(deps.readFile(settingsPath));
    } catch {
      cfg = {};
    }
  }
  const merged = mergeSettings(cfg, hookCmd, tel);
  const out = renderSettings(merged);

  if (check) {
    const cur = existed ? deps.readFile(settingsPath) : "";
    const changed = cur.trim() !== out.trim();
    return {
      stdout: `[check] settings.json: ${changed ? "would change (hooks/deny merged)" : "in sync"}`,
      stderr: "",
      exitCode: 0,
    };
  }

  deps.writeFile(settingsPath, out + "\n");
  return {
    stdout: "[sync] settings.json (hooks + permissions.deny merged, existing keys preserved)",
    stderr: "",
    exitCode: 0,
  };
}

// ---------------------------------------------------------------------------
// main — thin I/O shell (NOT unit-tested, same pattern as ./stats-cli.ts)
// ---------------------------------------------------------------------------

function prodDeps(): MergeSettingsCliDeps {
  return {
    exists: fs.existsSync,
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
  };
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const { stdout, stderr, exitCode } = runMergeSettingsCli(argv, prodDeps());
  if (stdout) process.stdout.write(stdout + "\n");
  if (stderr) process.stderr.write(stderr + "\n");
  process.exit(exitCode);
}

// Direct-run guard (`node core/src/ops/merge-settings.ts ...`) — inert under
// `node --test` / plain `import` (same pattern as ./stats-cli.ts).
if (process.argv[1]) {
  let isDirectRun = false;
  try {
    isDirectRun = fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    isDirectRun = false;
  }
  if (isDirectRun) {
    main();
  }
}
