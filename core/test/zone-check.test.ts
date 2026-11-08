import { test } from "node:test";
import assert from "node:assert/strict";

import { checkZone } from "../src/zone/zone-check.ts";
import { runZoneCheckCli } from "../src/zone/zone-check-cli.ts";
import type { GitSeam, GitRunResult } from "../src/rails/git-seam.ts";

// ---------------------------------------------------------------------------
// checkZone (pure core, contract L-3/L-6)
// ---------------------------------------------------------------------------

test("checkZone: path inside allow, no deny -> ok, no violations", () => {
  const r = checkZone(["core/src/zone/x.ts"], ["core/**"], []);
  assert.deepEqual(r, { violations: [], ok: true });
});

test("checkZone: path outside allow -> violation 'вне allow-zone'", () => {
  const r = checkZone(["tools/other.py"], ["core/**"], []);
  assert.equal(r.ok, false);
  assert.deepEqual(r.violations, ["tools/other.py: вне allow-zone"]);
});

test("checkZone: deny match -> violation 'matches deny-zone' even if allow also matches", () => {
  const r = checkZone([".git/config"], ["**"], [".git/**"]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.violations, [".git/config: matches deny-zone"]);
});

test("checkZone: deny wins over allow (both would match) — deny checked first", () => {
  const r = checkZone(["core/secret.ts"], ["core/**"], ["core/secret.ts"]);
  assert.deepEqual(r.violations, ["core/secret.ts: matches deny-zone"]);
});

test("checkZone: empty allow array -> everything is a violation (CLI-level 'empty --allow -> exit 2' is a caller concern, not this function's)", () => {
  const r = checkZone(["core/x.ts"], [], []);
  assert.equal(r.ok, false);
  assert.deepEqual(r.violations, ["core/x.ts: вне allow-zone"]);
});

test("checkZone: '**' matches zero-or-more segments at a path-end boundary (allow-lane semantics)", () => {
  const r = checkZone(["core/src/zone/deep/nested/x.ts"], ["core/src/zone/**"], []);
  assert.equal(r.ok, true);
});

test("checkZone: '?' matches exactly one non-'/' char", () => {
  const r1 = checkZone(["core/a1.ts"], ["core/a?.ts"], []);
  const r2 = checkZone(["core/a12.ts"], ["core/a?.ts"], []);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, false);
});

test("checkZone: backslash-paths are normalized to '/' before matching", () => {
  const r = checkZone(["core\\src\\zone\\x.ts"], ["core/src/zone/**"], []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.violations, []);
});

test("checkZone: leading './' is stripped before matching", () => {
  const r = checkZone(["./core/src/zone/x.ts"], ["core/src/zone/**"], []);
  assert.equal(r.ok, true);
});

test("checkZone: blank/whitespace-only path entries are dropped (не считаются путями)", () => {
  const r = checkZone(["", "   ", "core/x.ts"], ["core/**"], []);
  assert.equal(r.violations.length, 0);
});

// ---------------------------------------------------------------------------
// Python parity cases (contract L-6 — explicit expectations, both impls not
// run side-by-side; pinned here against the documented Python behaviour of
// `tools/zone_check.py`'s `glob_to_re`/`norm`).
// ---------------------------------------------------------------------------

test("parity: sandbox/** allow + .git/**,.omp/** deny — matches the Python docstring usage example", () => {
  const allow = ["sandbox/**"];
  const deny = [".git/**", ".omp/**"];
  assert.equal(checkZone(["sandbox/a/b.txt"], allow, deny).ok, true);
  assert.equal(checkZone([".git/HEAD"], allow, deny).ok, false);
  assert.equal(checkZone([".omp/state.json"], allow, deny).ok, false);
  assert.equal(checkZone(["README.md"], allow, deny).ok, false);
});

test("parity: multiple allow globs, comma-split with surrounding whitespace trimmed (CSV-token '.strip()' parity)", () => {
  const r = checkZone(["src/auth/x.ts"], ["src/auth/**", " tests/auth/** "], []);
  assert.equal(r.ok, true);
});

// ---------------------------------------------------------------------------
// Amend A1 (lead, ex-L-2 finding, now fixed at the source): path-zone's
// `globToRegExp` was patched to eat a slash immediately following `**`,
// matching Python `glob_to_re`'s 0+-segments semantics — these 3 cases are
// now Python-PARITY (were the pinned divergence before the fix).
// ---------------------------------------------------------------------------

test("Amend A1 parity: a glob shaped 'core' + '**' + 'foo.ts' (0+ segments) matches 'core/foo.ts' (zero intervening segments) too", () => {
  const r = checkZone(["core/foo.ts"], ["core/**/foo.ts"], []);
  assert.equal(r.ok, true, "'**' immediately followed by '/' consumes that slash — 0+ segments, Python-parity (Amend A1)");
});

test("Amend A1 parity, deny-side: a deny-glob shaped 'a' + '**' + 'b' DOES flag 'a/b' (0+ segments) — the deny-floor no longer under-matches vs Python", () => {
  const r = checkZone(["a/b"], ["**"], ["a/**/b"]);
  assert.equal(r.ok, false, "deny-glob 'a/**/b' must catch 'a/b' too (0+ segments)");
  assert.deepEqual(r.violations, ["a/b: matches deny-zone"]);
});

test("a '**' glob still matches with >=1 intervening segment too (unchanged)", () => {
  const r = checkZone(["core/sub/foo.ts"], ["core/**/foo.ts"], []);
  assert.equal(r.ok, true);
});

// ---------------------------------------------------------------------------
// runZoneCheckCli (argv/git-seam/stdin shell, contract L-1 output/exit parity)
// ---------------------------------------------------------------------------

function fakeGit(result: GitRunResult): GitSeam {
  return {
    run: (_args: readonly string[]) => result,
    runShell: (_cmd: string) => result,
  };
}

test("CLI: empty --allow -> exit 2, stderr error, no stdout", () => {
  const out = runZoneCheckCli(["--allow", ""], { git: fakeGit({ code: 0, stdout: "", stderr: "" }), stdinText: "" });
  assert.equal(out.exitCode, 2);
  assert.match(out.stderr, /пустой --allow/);
  assert.equal(out.stdout, "");
});

test("CLI: stdin paths, clean -> exit 0, 'ZONE: OK'", () => {
  const out = runZoneCheckCli(["--allow", "core/**"], {
    git: fakeGit({ code: 0, stdout: "", stderr: "" }),
    stdinText: "core/a.ts\ncore/b.ts\n",
  });
  assert.equal(out.exitCode, 0);
  assert.equal(out.stdout, "paths: 2 | violations: 0\nZONE: OK");
});

test("CLI: stdin paths with a violation -> exit 1, 'ZONE: VIOLATION', '[x]' line", () => {
  const out = runZoneCheckCli(["--allow", "core/**"], {
    git: fakeGit({ code: 0, stdout: "", stderr: "" }),
    stdinText: "core/a.ts\ntools/x.py\n",
  });
  assert.equal(out.exitCode, 1);
  assert.equal(
    out.stdout,
    "paths: 2 | violations: 1\n  [x] tools/x.py: вне allow-zone\nZONE: VIOLATION",
  );
});

test("CLI: --staged uses `git diff --cached --name-only` via the seam", () => {
  let calledArgs: readonly string[] | undefined;
  const git: GitSeam = {
    run: (args) => {
      calledArgs = args;
      return { code: 0, stdout: "core/a.ts\n", stderr: "" };
    },
    runShell: () => ({ code: 0, stdout: "", stderr: "" }),
  };
  const out = runZoneCheckCli(["--allow", "core/**", "--staged"], { git, stdinText: "" });
  assert.deepEqual(calledArgs, ["git", "diff", "--cached", "--name-only"]);
  assert.equal(out.exitCode, 0);
});

test("CLI: --from-git <ref> uses `git diff --name-only <ref>` via the seam", () => {
  let calledArgs: readonly string[] | undefined;
  const git: GitSeam = {
    run: (args) => {
      calledArgs = args;
      return { code: 0, stdout: "core/a.ts\n", stderr: "" };
    },
    runShell: () => ({ code: 0, stdout: "", stderr: "" }),
  };
  const out = runZoneCheckCli(["--allow", "core/**", "--from-git", "HEAD~1"], { git, stdinText: "" });
  assert.deepEqual(calledArgs, ["git", "diff", "--name-only", "HEAD~1"]);
  assert.equal(out.exitCode, 0);
});

test("CLI: git failure (--staged) -> exit 2, stderr forwarded", () => {
  const out = runZoneCheckCli(["--allow", "core/**", "--staged"], {
    git: fakeGit({ code: 128, stdout: "", stderr: "fatal: not a git repository" }),
    stdinText: "",
  });
  assert.equal(out.exitCode, 2);
  assert.match(out.stderr, /not a git repository/);
});

test("CLI: --deny wins over --allow", () => {
  const out = runZoneCheckCli(["--allow", "**", "--deny", ".git/**"], {
    git: fakeGit({ code: 0, stdout: "", stderr: "" }),
    stdinText: ".git/config\n",
  });
  assert.equal(out.exitCode, 1);
  assert.equal(
    out.stdout,
    "paths: 1 | violations: 1\n  [x] .git/config: matches deny-zone\nZONE: VIOLATION",
  );
});

test("CLI: unknown flag -> exit 2 usage error", () => {
  const out = runZoneCheckCli(["--bogus"], { git: fakeGit({ code: 0, stdout: "", stderr: "" }), stdinText: "" });
  assert.equal(out.exitCode, 2);
  assert.match(out.stderr, /неизвестный аргумент/);
});
