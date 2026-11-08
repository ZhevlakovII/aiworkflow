/**
 * Classifier rule data — security-floor + git-mut + branch-delete + rail texts.
 *
 * Ported VERBATIM from `tools/policy/guard-rules.yml` (former tier2 source of
 * truth) + `tools/policy/intent.py` (`_SECURITY_LABELS` message texts, FIX-4
 * git-bin regex prefix lives in `./git.ts`). This file is DATA — the TS core
 * does NOT read guard-rules.yml at runtime (contract L-3, self-contained core).
 *
 * T7-6 (contract L-4): `tools/policy/guard-rules.yml` and `tools/policy/intent.py`
 * are DELETED (retired in T7, python rails/drivers surface gone) — every
 * `guard-rules.yml`/`intent.py` reference below (here and in `./zone.ts`,
 * `./git.ts`, `./security-floor.ts`, `./classify.ts`) is a HISTORICAL
 * provenance note (where this data/logic was ported FROM), not a live
 * pointer to an existing file. THIS file is now the source of truth;
 * `corpus.json` is the parity-contract that catches drift going forward.
 */

export interface SecurityDenyRule {
  key: string;
  /** RegExp source string (not a compiled RegExp — kept as data). */
  pattern: string;
  message: string;
}

// Source: guard-rules.yml `security_deny` (pipe_to_shell / net / rm_rf).
// Messages ported from intent.py `_SECURITY_LABELS`.
export const SECURITY_DENY: readonly SecurityDenyRule[] = [
  {
    key: "pipe_to_shell",
    // "| sh", "|sh", "| bash", "|bash"
    pattern: String.raw`\|\s*(sh|bash)\b`,
    message: "zone-guard: pipe-to-shell (download→exec) запрещён.",
  },
  {
    key: "net",
    // nc/ssh в начале команды или после ; & |
    pattern: String.raw`(^|[;&|]\s*)(nc|ssh)\s`,
    message: "zone-guard: nc/ssh запрещены (exfil/reverse-shell surface).",
  },
  {
    key: "rm_rf",
    // rm -rf / -fr / комбинированные формы / раздельные -r -f
    pattern: String.raw`\brm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*|-r\s+-f|-f\s+-r|-rf|-fr)\b`,
    message: "zone-guard: `rm -rf` запрещён.",
  },
] as const;

// T8 H1 (contract `.workflow/tasks/t8-status-quo-holes.md`) — PowerShell-tool
// security floor, ADDITIVE to `SECURITY_DENY` above (the PS classifier runs
// both). Case-insensitive (PowerShell cmdlet/param names are). Parameter
// names accept any unambiguous PS prefix (`-r`/`-rec`/`-Recurse`,
// `-fo`/`-Force`), in any order, anywhere in the same statement. Applied
// to the PS surface only (`powershell.ts`) — the Bash surface is unchanged.
export interface FlaggedSecurityDenyRule extends SecurityDenyRule {
  flags: string;
}

export const SECURITY_DENY_POWERSHELL: readonly FlaggedSecurityDenyRule[] = [
  {
    key: "ps_recursive_force_delete",
    pattern:
      String.raw`(?:^|[^\w-])(?:remove-item|ri|rm|rmdir|rd|del|erase)(?![\w-])` +
      String.raw`(?=[^;|\n]*\s-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?(?::\S*)?(?=[\s"')}]|$))` +
      String.raw`(?=[^;|\n]*\s-fo(?:r(?:c(?:e)?)?)?(?::\S*)?(?=[\s"')}]|$))`,
    flags: "i",
    message: "zone-guard: `Remove-Item -Recurse -Force` (рекурсивное принудительное удаление) запрещено.",
  },
  {
    key: "cmd_rd_s_q",
    pattern: String.raw`(?:^|[^\w-])(?:rd|rmdir)(?![\w-])(?=[^;|\n]*\s/s(?![\w]))(?=[^;|\n]*\s/q(?![\w]))`,
    flags: "i",
    message: "zone-guard: `rd /s /q` (рекурсивное удаление) запрещено.",
  },
  {
    key: "dotnet_directory_delete_recursive",
    pattern: String.raw`\[\s*(?:system\s*\.\s*)?io\s*\.\s*directory\s*\]\s*::\s*delete\s*\([^)]*,\s*\$true`,
    flags: "i",
    message: "zone-guard: `[IO.Directory]::Delete(..., $true)` (рекурсивное удаление) запрещено.",
  },
] as const;

// Source: guard-rules.yml `git_mut` — first-word subcommand list. READ
// subcommands (status/diff/log/rev-parse/show/branch-without-flags) are
// intentionally absent — they fall through to allow in classify.ts.
export const GIT_MUT: readonly string[] = [
  "commit",
  "add",
  "push",
  "merge",
  "reset",
  "checkout",
  "restore",
  "clean",
  "stash",
  "rm",
  "apply",
  "cherry-pick",
  "rebase",
  "tag",
] as const;

// Source: guard-rules.yml `branch_delete.pattern`. `git branch` itself is
// READ; the only mutation is `-d`/`-D` (branch deletion).
export const BRANCH_DELETE_PATTERN = String.raw`branch\s+-[dD]`;

// Source: guard-rules.yml `git_mut_rails` — rail stir-text per subcommand
// (same texts as the prior RAIL dict in zone-guard.py / intent.py). Only
// {commit, push, merge} are railable (contract §Модель verdict, D6); other
// git_mut subcommands fall through to a generic deny in git.ts.
export const GIT_MUT_RAILS: Readonly<Record<string, string>> = {
  commit: 'gated_commit → `python tools/gated_commit.py -m "..." [--gate <cmd>]`',
  push: "gated_push → `python tools/gated_push.py [--pr --base <b>]`",
  merge: "gated_merge → `python tools/gated_merge.py --branch <b> [--class <c>]`",
} as const;

// Source: guard-rules.yml `token_tables` (posix/powershell) — WRITE-intent
// allowlist tokens (AD-guard-shared-intent-core). Ported VERBATIM (T2b, contract
// L-1). READ verbs (cat/grep/ls/type/Get-Content) are intentionally ABSENT —
// this is the BASH_WRITE_PROTECTED fix: a bare mention of a protected path in
// a read-only command must never trigger the write-intent path (see zone.ts
// `segmentIsProtectedWrite` — it only runs per-token, and read verbs simply
// have no token here to match on).
export const TOKEN_TABLES: { readonly posix: readonly string[]; readonly powershell: readonly string[] } = {
  posix: [">", ">>", "tee", "rm", "mv", "cp", "sed -i", "dd", "truncate", "install", "ln", "touch", "mkdir"],
  powershell: [
    "Out-File",
    "Set-Content",
    "Add-Content",
    "Clear-Content",
    ">",
    ">>",
    "Remove-Item",
    "ri",
    "del",
    "Move-Item",
    "mv",
    "Copy-Item",
    "cp",
    "New-Item",
    "Tee-Object",
    "tee",
  ],
} as const;

// Source: guard-rules.yml `intent.shell_unknown` — when `shell` is not given
// (or not recognized as "posix"/"powershell"), the token list used is the
// UNION of both tables (dedup, order preserved: posix entries first). Kept
// as a named constant (data, not a magic string) per contract L-1/L-4.
export const SHELL_UNKNOWN_MODE = "union" as const;

// FIX-1 (security-review, T2b blocker): intent.py always had a non-empty
// `path_set` floor (`guard-rules.yml path_set: [.git, .omp]`) — the
// actor-aware model in classify.ts replaces that static global with
// `zone.deny` (worker) / `policy.operator_zone.protected` (operator), which
// can legitimately be empty (caller didn't configure a denylist). Without a
// floor, an empty configured set silently fail-opens the zone-check
// (no-op). `DEFAULT_PROTECTED` is the engine-universal VCS floor — `.git` —
// merged into the protected-set WHENEVER the zone-check is active for the
// actor (contract fix: `resolveProtectedSet` in `classify.ts`). Project/
// target-specific protected dirs (`.omp`, `.claude`, client dirs, ...) are
// layered ON TOP via `policy.operator_zone.protected` / worker `zone.deny` —
// they do not replace this floor. `.git` cannot be un-configured away while
// the zone-check runs for that actor (see classify.ts for the off/assist
// operator exception, which skips the WHOLE zone-check, floor included, by
// design — operator trusted at those profiles).
export const DEFAULT_PROTECTED: readonly string[] = [".git"];

// T7-7 (contract .workflow/tasks/t7-7-operator-external-whitelist.md, L-1/L-2)
// — operator external-whitelist: harness-home directories a `operator`
// (never `worker`, see `path-zone.ts` `classifyPath`) may write OUTSIDE
// `repoRoot` under. `~` expands to `os.homedir()` (injectable via
// `ClassifyPathOptions.homeDir` for tests) in `path-zone.ts`'s
// `expandHomeGlob`. Data default — overridable WHOLESALE (replaces, not
// merges) by `policy.yml`'s `operator_zone.external_allow: [...]` (parsed/
// validated in `wiring/policy-source.ts`, fail-closed: invalid value ->
// this default + a warning, see `resolvePolicy`).
export const DEFAULT_EXTERNAL_ALLOW: readonly string[] = [
  "~/.claude/**",
  "~/.omp/**",
  "~/.config/opencode/**",
  "~/.codex/**",
] as const;

// T7-7 L-3 — protected-within-whitelist floor: config/hook files inside the
// external-allow harness-home dirs that would let an agent weaken its OWN
// enforcement (permissions/hooks) if writable. Applied UNCONDITIONALLY
// whenever a path falls inside the (possibly policy-overridden)
// `external_allow` set — this list itself is a hardcoded floor, NOT
// policy.yml-configurable (mirrors `DEFAULT_PROTECTED`'s ".git" floor: a
// security backstop, not policy-as-data).
//
// Entries chosen (contract L-3 "исполнитель перечисляет найденные",
// cross-checked against `docs/design/universal-core-capability-matrix-2026-09-18.md`
// §G config-surface + a live listing of this machine's harness-home dirs):
//  - `~/.claude/settings.json` / `settings.local.json` — CC PreToolUse hook
//    wiring + `permissions.deny` (THIS repo's own live enforcement surface,
//    contract's original trigger case).
//  - `~/.omp/agent/config.yml` / `~/.omp/agent/hooks/**` — OMP's
//    `config.yml extensions` (hooks) + `hooks/pre/zone-guard.ts`-equivalent
//    surface (confirmed present on this machine: `~/.omp/agent/config.yml`,
//    `~/.omp/agent/hooks/`).
//  - `~/.config/opencode/opencode.json` / `.jsonc` — OpenCode's global
//    `permission`/hook config (project-root `opencode.json` is the
//    documented surface; the XDG home-dir variant shares the filename —
//    NOT present on this machine at write-time, protected preemptively).
//  - `~/.codex/config.toml` / `~/.codex/hooks.json` — Codex's hook/config
//    surface (`docs/design/universal-core-capability-matrix-2026-09-18.md`
//    correction note: `.codex/hooks.json` / inline `config.toml`, shared by
//    Codex desktop + Codex CLI — NOT present on this machine at write-time,
//    protected preemptively).
export const DEFAULT_EXTERNAL_PROTECTED: readonly string[] = [
  "~/.claude/settings.json",
  "~/.claude/settings.local.json",
  "~/.omp/agent/config.yml",
  "~/.omp/agent/hooks/**",
  "~/.config/opencode/opencode.json",
  "~/.config/opencode/opencode.jsonc",
  "~/.codex/config.toml",
  "~/.codex/hooks.json",
] as const;
