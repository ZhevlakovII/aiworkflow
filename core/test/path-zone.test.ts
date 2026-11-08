import { test } from "node:test";
import assert from "node:assert/strict";

import { resolvePolicy } from "../src/policy/policy.ts";
import type { Actor, ZoneOptions } from "../src/classify/classify.ts";
import type { Profile } from "../src/policy/profile.ts";
import { classifyPath, globToRegExp, normalizePath, pathMatches } from "../src/classify/path-zone.ts";
import { DEFAULT_EXTERNAL_ALLOW, DEFAULT_EXTERNAL_PROTECTED } from "../src/classify/rules.ts";

// ---------------------------------------------------------------------------
// globToRegExp / pathMatches — glob-семантика (contract §Glob-семантика, Q4)
// ---------------------------------------------------------------------------

test("globToRegExp: '**' matches across '/' boundaries (zero-or-more segments)", () => {
  const re = globToRegExp("src/auth/**");
  assert.equal(re.test("src/auth/x"), true);
  assert.equal(re.test("src/auth/sub/y"), true);
  assert.equal(re.test("src/auth/sub/deep/z.ts"), true);
});

test("dir-glob prefix decision: 'src/auth/**' does NOT match 'src/auth' itself (gitignore-style: /** = contents only)", () => {
  const re = globToRegExp("src/auth/**");
  assert.equal(re.test("src/auth"), false);
});

test("globToRegExp: '*' matches within one segment only, does not cross '/'", () => {
  const re = globToRegExp("core/*.ts");
  assert.equal(re.test("core/foo.ts"), true);
  assert.equal(re.test("core/sub/foo.ts"), false, "'*' must not cross a '/' boundary");
});

test("globToRegExp: '?' matches exactly one non-'/' character", () => {
  const re = globToRegExp("core/a?.ts");
  assert.equal(re.test("core/ab.ts"), true);
  assert.equal(re.test("core/abc.ts"), false);
  assert.equal(re.test("core/a.ts"), false, "'?' requires exactly one char, not zero");
  assert.equal(re.test("core/a/.ts"), false, "'?' must not match '/'");
});

test("globToRegExp: literal characters (incl. regex-special ones like '.') are escaped", () => {
  const re = globToRegExp("core/file.txt");
  assert.equal(re.test("core/file.txt"), true);
  assert.equal(re.test("coreXfileYtxt"), false);
});

test("globToRegExp: full-path anchoring — no partial/substring match", () => {
  const re = globToRegExp("core/**");
  assert.equal(re.test("not-core/x"), false);
  assert.equal(re.test("xcore/y"), false);
});

test("pathMatches: true if ANY glob in the list matches", () => {
  assert.equal(pathMatches("core/src/x.ts", ["tools/**", "core/**"]), true);
  assert.equal(pathMatches("docs/x.md", ["tools/**", "core/**"]), false);
});

// ---------------------------------------------------------------------------
// normalizePath — Windows backslash + absolute/repoRoot handling (contract DS2)
// ---------------------------------------------------------------------------

test("normalizePath: relative path passed through (backslash normalized)", () => {
  assert.equal(normalizePath("core/src/x.ts"), "core/src/x.ts");
  assert.equal(normalizePath("core\\src\\x.ts"), "core/src/x.ts");
});

test("normalizePath: leading './' stripped", () => {
  assert.equal(normalizePath("./core/src/x.ts"), "core/src/x.ts");
});

test("normalizePath: absolute + repoRoot inside tree -> repo-relative POSIX path", () => {
  assert.equal(normalizePath("C:\\repo\\core\\src\\x.ts", "C:\\repo"), "core/src/x.ts");
  assert.equal(normalizePath("/repo/core/src/x.ts", "/repo"), "core/src/x.ts");
});

test("normalizePath: absolute path OUTSIDE repoRoot -> null (fail-closed deny signal)", () => {
  assert.equal(normalizePath("C:\\other\\x.ts", "C:\\repo"), null);
  assert.equal(normalizePath("/other/x.ts", "/repo"), null);
});

test("normalizePath: absolute path with NO repoRoot given -> null (fail-closed)", () => {
  assert.equal(normalizePath("C:\\repo\\core\\x.ts"), null);
  assert.equal(normalizePath("/repo/core/x.ts"), null);
});

test("normalizePath: '..' escaping above repoRoot -> null (fail-closed)", () => {
  assert.equal(normalizePath("C:\\repo\\..\\outside\\x.ts", "C:\\repo"), null);
});

// ---------------------------------------------------------------------------
// classifyPath — actor/profile matrix (contract §Модель verdict, DoD)
// ---------------------------------------------------------------------------

function policyFor(profile: Profile, operatorProtected?: string[]) {
  return resolvePolicy({
    explicitProfile: profile,
    interactive: true,
    policy: operatorProtected ? { operator_zone: { protected: operatorProtected } } : undefined,
  });
}

interface Case {
  name: string;
  filePath: string;
  actor?: Actor;
  profile: Profile;
  zone?: ZoneOptions;
  operatorProtected?: string[];
  repoRoot?: string;
  expect: "allow" | "deny";
}

const cases: Case[] = [
  // --- worker: allow-lane (D9) ---
  {
    name: "worker: path inside allow-lane -> allow",
    filePath: "core/src/x.ts",
    actor: "worker",
    profile: "guarded",
    zone: { allow: ["core/**"] },
    expect: "allow",
  },
  {
    name: "worker: path outside allow-lane -> deny",
    filePath: "tools/x.py",
    actor: "worker",
    profile: "guarded",
    zone: { allow: ["core/**"] },
    expect: "deny",
  },
  {
    name: "worker: empty allow (misconfiguration, D9) -> deny everywhere",
    filePath: "core/src/x.ts",
    actor: "worker",
    profile: "guarded",
    zone: { allow: [] },
    expect: "deny",
  },
  {
    name: "worker: no zone.allow given at all -> deny (same as empty)",
    filePath: "core/src/x.ts",
    actor: "worker",
    profile: "guarded",
    expect: "deny",
  },
  {
    name: "worker: DEFAULT_PROTECTED floor (.git) denies even when broadly allowed",
    filePath: ".git/config",
    actor: "worker",
    profile: "guarded",
    zone: { allow: ["**"] },
    expect: "deny",
  },
  {
    name: "worker: extra zone.deny wins over allow-lane (deny takes precedence)",
    filePath: "core/legacy/x.ts",
    actor: "worker",
    profile: "guarded",
    zone: { allow: ["core/**"], deny: ["core/legacy"] },
    expect: "deny",
  },
  {
    name: "worker: zone.deny does not affect paths outside it",
    filePath: "core/src/x.ts",
    actor: "worker",
    profile: "guarded",
    zone: { allow: ["core/**"], deny: ["core/legacy"] },
    expect: "allow",
  },
  {
    // Amend A1 (lead): globToRegExp's `**` immediately followed by `/` now
    // eats that slash (0+ segments, Python `glob_to_re` parity) — a
    // deny-glob shaped `x` + `/` + `**` + `/` + `y` must block `x/y`
    // itself (zero intervening segments), not just `x/a/y`.
    name: "worker: zone.deny 'x/**/y'-shaped glob blocks 'x/y' itself (0+ segments, Amend A1)",
    filePath: "x/y",
    actor: "worker",
    profile: "guarded",
    zone: { allow: ["**"], deny: ["x/**/y"] },
    expect: "deny",
  },

  // --- operator + operator_zone enabled (guarded/autonomous) ---
  {
    name: "operator guarded: protected entry -> deny",
    filePath: ".claude/settings.json",
    actor: "operator",
    profile: "guarded",
    operatorProtected: [".claude"],
    expect: "deny",
  },
  {
    name: "operator guarded: DEFAULT_PROTECTED floor (.git) -> deny even without explicit protected config",
    filePath: ".git/config",
    actor: "operator",
    profile: "guarded",
    expect: "deny",
  },
  {
    name: "operator guarded: elsewhere (not protected) -> allow, no allow-lane restriction",
    filePath: "any/random/path.ts",
    actor: "operator",
    profile: "guarded",
    operatorProtected: [".claude"],
    expect: "allow",
  },
  {
    name: "operator autonomous: floor still applies",
    filePath: ".git/hooks/pre-commit",
    actor: "operator",
    profile: "autonomous",
    expect: "deny",
  },

  // --- operator + operator_zone off (off/assist) ---
  {
    name: "operator off-profile: operator_zone disabled -> allow unrestricted (even .git)",
    filePath: ".git/config",
    actor: "operator",
    profile: "off",
    expect: "allow",
  },
  {
    name: "operator assist-profile: operator_zone disabled -> allow unrestricted",
    filePath: ".claude/settings.json",
    actor: "operator",
    profile: "assist",
    operatorProtected: [".claude"],
    expect: "allow",
  },

  // --- fail-closed: actor omitted ---
  {
    name: "fail-closed: actor omitted -> treated as worker (strict), empty allow -> deny",
    filePath: "core/src/x.ts",
    profile: "guarded",
    zone: { allow: ["core/**"] },
    expect: "allow", // still worker semantics, but allow-lane matches -> allow
  },
  {
    name: "fail-closed: actor omitted -> worker, path outside declared allow-lane -> deny",
    filePath: "tools/x.py",
    profile: "guarded",
    zone: { allow: ["core/**"] },
    expect: "deny",
  },
];

for (const c of cases) {
  test(`classifyPath: ${c.name}`, () => {
    const policy = policyFor(c.profile, c.operatorProtected);
    const verdict = classifyPath(c.filePath, {
      actor: c.actor,
      policy,
      zone: c.zone,
      repoRoot: c.repoRoot,
    });
    assert.equal(
      verdict.decision,
      c.expect,
      `got decision=${verdict.decision}${verdict.reason ? ` reason=${verdict.reason}` : ""}`
    );
  });
}

// ---------------------------------------------------------------------------
// classifyPath — Windows backslash + absolute-outside-repoRoot (contract DoD)
// ---------------------------------------------------------------------------

test("classifyPath: Windows absolute path inside repoRoot, worker allow-lane match -> allow", () => {
  const policy = policyFor("guarded");
  const verdict = classifyPath("C:\\repo\\core\\src\\x.ts", {
    actor: "worker",
    policy,
    zone: { allow: ["core/**"] },
    repoRoot: "C:\\repo",
  });
  assert.equal(verdict.decision, "allow");
});

test("classifyPath: absolute path OUTSIDE repoRoot -> deny (fail-closed), even for operator with zone off", () => {
  const policy = policyFor("off");
  const verdict = classifyPath("C:\\somewhere-else\\x.ts", {
    actor: "operator",
    policy,
    repoRoot: "C:\\repo",
  });
  assert.equal(verdict.decision, "deny");
});

test("classifyPath: absolute path with no repoRoot given at all -> deny (fail-closed), worker", () => {
  const policy = policyFor("guarded");
  const verdict = classifyPath("/abs/core/src/x.ts", {
    actor: "worker",
    policy,
    zone: { allow: ["core/**"] },
  });
  assert.equal(verdict.decision, "deny");
});

// ---------------------------------------------------------------------------
// T7-7 — operator external-whitelist (contract
// .workflow/tasks/t7-7-operator-external-whitelist.md, L-1/L-2/L-3/L-5)
// ---------------------------------------------------------------------------

function policyForExternal(profile: Profile, externalAllow?: string[]) {
  return resolvePolicy({
    explicitProfile: profile,
    interactive: true,
    policy: externalAllow ? { operator_zone: { external_allow: externalAllow } } : undefined,
  });
}

const WIN_HOME = "C:\\Users\\tester";
const WIN_REPO = "C:\\repo";
const POSIX_HOME = "/home/tester";
const POSIX_REPO = "/repo";

test("classifyPath: T7-7 default DEFAULT_EXTERNAL_ALLOW covers exactly the 4 contract harness-home dirs", () => {
  assert.deepEqual(
    [...DEFAULT_EXTERNAL_ALLOW].sort(),
    ["~/.claude/**", "~/.codex/**", "~/.config/opencode/**", "~/.omp/**"].sort()
  );
});

test("classifyPath: operator, Windows memory-path under ~/.claude outside repoRoot -> allow", () => {
  const policy = policyForExternal("guarded");
  const verdict = classifyPath("C:\\Users\\tester\\.claude\\projects\\x\\memory\\a.md", {
    actor: "operator",
    policy,
    repoRoot: WIN_REPO,
    homeDir: WIN_HOME,
  });
  assert.equal(verdict.decision, "allow");
});

test("classifyPath: operator, ~/.claude/settings.json -> deny (L-3 protected-within-whitelist)", () => {
  const policy = policyForExternal("guarded");
  const verdict = classifyPath("C:\\Users\\tester\\.claude\\settings.json", {
    actor: "operator",
    policy,
    repoRoot: WIN_REPO,
    homeDir: WIN_HOME,
  });
  assert.equal(verdict.decision, "deny");
});

test("classifyPath: operator, ~/.claude/settings.local.json -> deny (L-3)", () => {
  const policy = policyForExternal("guarded");
  const verdict = classifyPath("C:\\Users\\tester\\.claude\\settings.local.json", {
    actor: "operator",
    policy,
    repoRoot: WIN_REPO,
    homeDir: WIN_HOME,
  });
  assert.equal(verdict.decision, "deny");
});

for (const entry of DEFAULT_EXTERNAL_PROTECTED) {
  test(`classifyPath: operator, DEFAULT_EXTERNAL_PROTECTED entry '${entry}' -> deny (posix home)`, () => {
    const policy = policyForExternal("guarded");
    // A '/**'-suffixed entry is a directory glob (contract dir-glob-prefix
    // convention, see `expandProtectedEntry` above) — substitute a concrete
    // file under it for the actual filePath under test.
    const sample = entry.endsWith("/**") ? entry.slice(0, -3) + "/sample-hook.ts" : entry;
    const filePath = sample.replace("~", POSIX_HOME);
    const verdict = classifyPath(filePath, {
      actor: "operator",
      policy,
      repoRoot: POSIX_REPO,
      homeDir: POSIX_HOME,
    });
    assert.equal(verdict.decision, "deny");
  });
}

test("classifyPath: operator, posix home ~/.omp/agent/x.yml (not protected) -> allow", () => {
  const policy = policyForExternal("guarded");
  const verdict = classifyPath("/home/tester/.omp/agent/x.yml", {
    actor: "operator",
    policy,
    repoRoot: POSIX_REPO,
    homeDir: POSIX_HOME,
  });
  assert.equal(verdict.decision, "allow");
});

test("classifyPath: operator, C:/Windows/x (outside repoRoot AND outside whitelist) -> deny", () => {
  const policy = policyForExternal("guarded");
  const verdict = classifyPath("C:\\Windows\\x", {
    actor: "operator",
    policy,
    repoRoot: WIN_REPO,
    homeDir: WIN_HOME,
  });
  assert.equal(verdict.decision, "deny");
});

test("classifyPath: operator, /etc/x (outside repoRoot AND outside whitelist) -> deny", () => {
  const policy = policyForExternal("guarded");
  const verdict = classifyPath("/etc/x", {
    actor: "operator",
    policy,
    repoRoot: POSIX_REPO,
    homeDir: POSIX_HOME,
  });
  assert.equal(verdict.decision, "deny");
});

test("classifyPath: operator, $TEMP-style path outside the home whitelist dirs -> deny", () => {
  const policy = policyForExternal("guarded");
  const verdict = classifyPath("C:\\Users\\tester\\AppData\\Local\\Temp\\x", {
    actor: "operator",
    policy,
    repoRoot: WIN_REPO,
    homeDir: WIN_HOME,
  });
  assert.equal(verdict.decision, "deny");
});

test("classifyPath: operator, Windows drive-letter case mismatch (c: vs C:) still matches whitelist (case-insensitive)", () => {
  const policy = policyForExternal("guarded");
  const verdict = classifyPath("c:\\users\\tester\\.claude\\memory\\a.md", {
    actor: "operator",
    policy,
    repoRoot: WIN_REPO,
    homeDir: WIN_HOME,
  });
  assert.equal(verdict.decision, "allow");
});

test("classifyPath: operator, policy.yml operator_zone.external_allow override REPLACES the default (only-configured dir allowed)", () => {
  const policy = policyForExternal("guarded", ["~/.only-this/**"]);
  const allowed = classifyPath("C:\\Users\\tester\\.only-this\\a.txt", {
    actor: "operator",
    policy,
    repoRoot: WIN_REPO,
    homeDir: WIN_HOME,
  });
  assert.equal(allowed.decision, "allow");

  const noLongerAllowed = classifyPath("C:\\Users\\tester\\.claude\\memory\\a.md", {
    actor: "operator",
    policy,
    repoRoot: WIN_REPO,
    homeDir: WIN_HOME,
  });
  assert.equal(
    noLongerAllowed.decision,
    "deny",
    "an explicit external_allow override replaces (does not merge with) the default whitelist"
  );
});

test("classifyPath: worker, path under ~/.claude (would match operator's whitelist) -> STILL deny (worker unaffected by T7-7)", () => {
  const policy = policyForExternal("guarded");
  const verdict = classifyPath("C:\\Users\\tester\\.claude\\projects\\x\\memory\\a.md", {
    actor: "worker",
    policy,
    zone: { allow: ["**"] },
    repoRoot: WIN_REPO,
    homeDir: WIN_HOME,
  });
  assert.equal(verdict.decision, "deny");
});

test("classifyPath: operator, off-profile (operator_zone disabled) — external-whitelist deny for non-whitelisted path is UNCONDITIONAL on profile", () => {
  // T7-7 L-1: the outside-repoRoot check is not gated by operator_zone.enabled
  // (unlike the in-repo protected-floor, which off/assist skips entirely).
  const policy = policyForExternal("off");
  const verdict = classifyPath("C:\\Windows\\x", {
    actor: "operator",
    policy,
    repoRoot: WIN_REPO,
    homeDir: WIN_HOME,
  });
  assert.equal(verdict.decision, "deny");
});

test("classifyPath: operator, off-profile — whitelisted memory-path still allows (external whitelist independent of operator_zone.enabled)", () => {
  const policy = policyForExternal("off");
  const verdict = classifyPath("C:\\Users\\tester\\.claude\\memory\\a.md", {
    actor: "operator",
    policy,
    repoRoot: WIN_REPO,
    homeDir: WIN_HOME,
  });
  assert.equal(verdict.decision, "allow");
});

// ---------------------------------------------------------------------------
// T7-7 hardening — path-traversal bypass fix (coordinator finding).
// `classifyExternalPath` previously glob-matched the RAW, unresolved path —
// `**` also matches literal '..'/'.' segments in the string, so a path that
// textually starts with an allowed prefix but LEXICALLY resolves outside it
// (or onto a protected file) slipped through. Fixed via `resolveForMatch`
// (lexical `.`/`..` collapse before matching, both sides).
// ---------------------------------------------------------------------------

test("classifyPath: T7-7 hardening — '~/.claude/../.bashrc' resolves OUTSIDE the whitelist -> deny", () => {
  const policy = policyForExternal("guarded");
  const verdict = classifyPath("C:\\Users\\tester\\.claude\\..\\.bashrc", {
    actor: "operator",
    policy,
    repoRoot: WIN_REPO,
    homeDir: WIN_HOME,
  });
  assert.equal(verdict.decision, "deny");
});

test("classifyPath: T7-7 hardening — '~/.claude/x/../settings.json' resolves to the PROTECTED settings.json -> deny", () => {
  const policy = policyForExternal("guarded");
  const verdict = classifyPath("C:\\Users\\tester\\.claude\\x\\..\\settings.json", {
    actor: "operator",
    policy,
    repoRoot: WIN_REPO,
    homeDir: WIN_HOME,
  });
  assert.equal(verdict.decision, "deny");
});

test("classifyPath: T7-7 hardening — '~/.claude/./settings.json' ('.' segment) resolves to the PROTECTED settings.json -> deny", () => {
  const policy = policyForExternal("guarded");
  const verdict = classifyPath("C:\\Users\\tester\\.claude\\.\\settings.json", {
    actor: "operator",
    policy,
    repoRoot: WIN_REPO,
    homeDir: WIN_HOME,
  });
  assert.equal(verdict.decision, "deny");
});

test("classifyPath: T7-7 hardening — posix equivalent, '~/.claude/../.bashrc' -> deny", () => {
  const policy = policyForExternal("guarded");
  const verdict = classifyPath("/home/tester/.claude/../.bashrc", {
    actor: "operator",
    policy,
    repoRoot: POSIX_REPO,
    homeDir: POSIX_HOME,
  });
  assert.equal(verdict.decision, "deny");
});

test("classifyPath: T7-7 hardening — a '..'-carrying path that STILL lexically resolves inside a non-protected whitelisted dir -> allow (traversal collapse is not a blanket deny)", () => {
  const policy = policyForExternal("guarded");
  const verdict = classifyPath("C:\\Users\\tester\\.claude\\a\\..\\memory\\note.md", {
    actor: "operator",
    policy,
    repoRoot: WIN_REPO,
    homeDir: WIN_HOME,
  });
  assert.equal(verdict.decision, "allow");
});

test("classifyPath: T7-7 hardening — excessive '..' escaping ABOVE the home dir entirely -> deny", () => {
  const policy = policyForExternal("guarded");
  const verdict = classifyPath("C:\\Users\\tester\\.claude\\..\\..\\..\\Windows\\x", {
    actor: "operator",
    policy,
    repoRoot: WIN_REPO,
    homeDir: WIN_HOME,
  });
  assert.equal(verdict.decision, "deny");
});

// ---------------------------------------------------------------------------
// T7-7 hardening — Windows path-shape quirks (cheap ones handled; anything
// else fails closed to deny, per resolveForMatch's doc-comment).
// ---------------------------------------------------------------------------

test("classifyPath: T7-7 hardening — trailing dot on the final segment (NTFS quirk 'settings.json.') resolves to the SAME protected file -> deny", () => {
  const policy = policyForExternal("guarded");
  const verdict = classifyPath("C:\\Users\\tester\\.claude\\settings.json.", {
    actor: "operator",
    policy,
    repoRoot: WIN_REPO,
    homeDir: WIN_HOME,
  });
  assert.equal(verdict.decision, "deny");
});

test("classifyPath: T7-7 hardening — trailing space on the final segment ('settings.json ') resolves to the SAME protected file -> deny", () => {
  const policy = policyForExternal("guarded");
  const verdict = classifyPath("C:\\Users\\tester\\.claude\\settings.json ", {
    actor: "operator",
    policy,
    repoRoot: WIN_REPO,
    homeDir: WIN_HOME,
  });
  assert.equal(verdict.decision, "deny");
});

test("classifyPath: T7-7 hardening — trailing dot on an INTERMEDIATE segment ('.claude.') still resolves under the whitelisted dir -> allow (non-protected file)", () => {
  const policy = policyForExternal("guarded");
  const verdict = classifyPath("C:\\Users\\tester\\.claude.\\memory\\note.md", {
    actor: "operator",
    policy,
    repoRoot: WIN_REPO,
    homeDir: WIN_HOME,
  });
  assert.equal(verdict.decision, "allow");
});

test("classifyPath: T7-7 hardening — '\\\\?\\'-prefixed long path to a protected file still denies", () => {
  const policy = policyForExternal("guarded");
  const verdict = classifyPath("\\\\?\\C:\\Users\\tester\\.claude\\settings.json", {
    actor: "operator",
    policy,
    repoRoot: WIN_REPO,
    homeDir: WIN_HOME,
  });
  assert.equal(verdict.decision, "deny");
});

test("classifyPath: T7-7 hardening — '\\\\?\\'-prefixed long path to a non-protected whitelisted file still allows", () => {
  const policy = policyForExternal("guarded");
  const verdict = classifyPath("\\\\?\\C:\\Users\\tester\\.claude\\memory\\a.md", {
    actor: "operator",
    policy,
    repoRoot: WIN_REPO,
    homeDir: WIN_HOME,
  });
  assert.equal(verdict.decision, "allow");
});

test("classifyPath: T7-7 hardening — '\\\\.\\' device-namespace path -> fail-closed deny (cannot lexically resolve)", () => {
  const policy = policyForExternal("guarded");
  const verdict = classifyPath("\\\\.\\C:\\Users\\tester\\.claude\\memory\\a.md", {
    actor: "operator",
    policy,
    repoRoot: WIN_REPO,
    homeDir: WIN_HOME,
  });
  assert.equal(verdict.decision, "deny");
});

test("classifyPath: T7-7 hardening — a Windows 8.3-short-name-shaped segment (e.g. 'CLAUD~1') -> fail-closed deny (cannot normalize without fs access)", () => {
  const policy = policyForExternal("guarded");
  const verdict = classifyPath("C:\\Users\\tester\\CLAUD~1\\settings.json", {
    actor: "operator",
    policy,
    repoRoot: WIN_REPO,
    homeDir: WIN_HOME,
  });
  assert.equal(verdict.decision, "deny");
});

test("classifyPath: T7-7 hardening — repeated/mixed separators still resolve and match correctly", () => {
  const policy = policyForExternal("guarded");
  const verdict = classifyPath("C:\\\\Users\\/tester\\.claude\\\\memory\\a.md", {
    actor: "operator",
    policy,
    repoRoot: WIN_REPO,
    homeDir: WIN_HOME,
  });
  assert.equal(verdict.decision, "allow");
});

test("classifyPath: T7-7 hardening — a malformed homeDir (itself containing an unresolvable device-namespace prefix) fails closed (deny), not a crash", () => {
  const policy = policyForExternal("guarded");
  const verdict = classifyPath("C:\\Users\\tester\\.claude\\memory\\a.md", {
    actor: "operator",
    policy,
    repoRoot: WIN_REPO,
    homeDir: "\\\\.\\C:\\Users\\tester",
  });
  assert.equal(verdict.decision, "deny");
});

// ---------------------------------------------------------------------------
// T7-8 (fixes the T7-7 "separate finding" above) — in-repo path traversal:
// `normalizePath` now lexically collapses `.`/`..` (via `resolveForMatch`,
// reused from T7-7) BEFORE the result is ever handed to `pathMatches`, so a
// glob can no longer be fooled by a raw, uncollapsed '..' segment.
// ---------------------------------------------------------------------------

test("normalizePath: T7-8 — a SINGLE leading '..' immediately escaping repoRoot is still caught -> null", () => {
  assert.equal(normalizePath("C:\\repo\\..\\x", "C:\\repo"), null);
});

test("normalizePath: T7-8 — an INTERIOR '..' that stays inside repoRoot IS now lexically collapsed to the canonical resolved path", () => {
  // 'core/legacy/../x' lexically resolves to 'core/x' — the '..' segment no
  // longer survives into the returned string (T7-8 fix, was 'core/legacy/../x').
  const rel = normalizePath("C:\\repo\\core\\legacy\\..\\x", "C:\\repo");
  assert.equal(rel, "core/x");
});

test("classifyPath: T7-8 — an interior '..' that stays inside repoRoot can NO LONGER bypass a narrower worker allow-lane glob via raw-string matching (was T7-7's documented, unfixed finding)", () => {
  const policy = policyFor("guarded");
  const verdict = classifyPath("C:\\repo\\core\\legacy\\..\\secret\\x", {
    actor: "worker",
    policy,
    zone: { allow: ["core/legacy/**"] },
    repoRoot: "C:\\repo",
  });
  // The resolved path is 'core/secret/x' — OUTSIDE 'core/legacy/**' — deny.
  assert.equal(verdict.decision, "deny");
});

test("classifyPath: T7-8 — 'docs/../.git/config' resolves to the protected '.git/config' -> deny (worker)", () => {
  const policy = policyFor("guarded");
  const verdict = classifyPath("C:\\repo\\docs\\..\\.git\\config", {
    actor: "worker",
    policy,
    zone: { allow: ["**"] },
    repoRoot: "C:\\repo",
  });
  assert.equal(verdict.decision, "deny");
});

test("classifyPath: T7-8 — 'docs/../.git/config' resolves to the protected '.git/config' -> deny (operator, guarded)", () => {
  const policy = policyFor("guarded");
  const verdict = classifyPath("C:\\repo\\docs\\..\\.git\\config", {
    actor: "operator",
    policy,
    repoRoot: "C:\\repo",
  });
  assert.equal(verdict.decision, "deny");
});

test("classifyPath: T7-8 — 'core/./legacy/x' ('.' segment) with allow 'core/legacy/**' -> allow", () => {
  const policy = policyFor("guarded");
  const verdict = classifyPath("C:\\repo\\core\\.\\legacy\\x", {
    actor: "worker",
    policy,
    zone: { allow: ["core/legacy/**"] },
    repoRoot: "C:\\repo",
  });
  assert.equal(verdict.decision, "allow");
});

test("classifyPath: T7-8 — 'core/legacy/../../..' escapes repoRoot entirely -> deny (вне репо)", () => {
  const policy = policyFor("guarded");
  const verdict = classifyPath("C:\\repo\\core\\legacy\\..\\..\\..", {
    actor: "worker",
    policy,
    zone: { allow: ["**"] },
    repoRoot: "C:\\repo",
  });
  assert.equal(verdict.decision, "deny");
  assert.match(verdict.reason ?? "", /вне repoRoot/);
});

test("normalizePath: T7-8 — relative input with NO repoRoot is still lexically collapsed ('core/./legacy/x' -> 'core/legacy/x')", () => {
  assert.equal(normalizePath("core/./legacy/x"), "core/legacy/x");
});

test("normalizePath: T7-8 — relative input with NO repoRoot, interior '..' collapsed ('core/legacy/../x' -> 'core/x')", () => {
  assert.equal(normalizePath("core/legacy/../x"), "core/x");
});

test("normalizePath: T7-8 — relative input with NO repoRoot, excess '..' nets negative -> null (fail-closed, same as pre-T7-8 escapesRoot)", () => {
  assert.equal(normalizePath("core/legacy/../../.."), null);
});

test("normalizePath: T7-8 — POSIX absolute + repoRoot, interior '..' collapsed too (not just Windows)", () => {
  assert.equal(normalizePath("/repo/core/legacy/../x", "/repo"), "core/x");
});

// ---------------------------------------------------------------------------
// Design C — SWP is command-hook-only; classifyPath must NOT deny (L1 rail)
// ---------------------------------------------------------------------------

test("classifyPath: operator — enforcement_paths alone does NOT deny policy.yml (L1 may stage it)", () => {
  const policy = resolvePolicy({
    explicitProfile: "guarded",
    interactive: true,
    policy: {
      session_write_protected: [".workflow/stages/**"],
      enforcement_paths: ["policy.yml", "core/src/**", ".gitignore"],
    },
  });
  const verdict = classifyPath("policy.yml", {
    actor: "operator",
    policy,
    repoRoot: "C:\\repo",
  });
  assert.equal(
    verdict.decision,
    "allow",
    "SWP/enforcement must live in command-hook only — classifyPath is shared with gatedCommit"
  );
});

test("classifyPath: operator — session_write_protected path still allowed here (hook enforces)", () => {
  const policy = resolvePolicy({
    explicitProfile: "guarded",
    interactive: true,
    policy: {
      session_write_protected: [".workflow/stages/**", ".workflow/active-zone.json"],
      enforcement_paths: ["core/src/**"],
    },
  });
  for (const filePath of [
    ".workflow/stages/x.ndjson",
    ".workflow/active-zone.json",
    "core/src/classify/path-zone.ts",
  ]) {
    const verdict = classifyPath(filePath, {
      actor: "operator",
      policy,
      repoRoot: "C:\\repo",
    });
    assert.equal(verdict.decision, "allow", `classifyPath must allow ${filePath}`);
  }
});

test("classifyPath: operator — existing task-file overwrite NOT create-only-denied here", () => {
  const policy = resolvePolicy({
    explicitProfile: "guarded",
    interactive: true,
    policy: { session_write_protected: [".workflow/stages/**"] },
  });
  const verdict = classifyPath(".workflow/tasks/existing.md", {
    actor: "operator",
    policy,
    repoRoot: "C:\\repo",
  });
  assert.equal(verdict.decision, "allow");
});
