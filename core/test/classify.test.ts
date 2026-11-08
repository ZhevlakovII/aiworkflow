import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { resolvePolicy, type Policy } from "../src/policy/policy.ts";
import { classify, type Actor, type ZoneOptions } from "../src/classify/classify.ts";
import { maskHeredocs } from "../src/classify/zone.ts";
import type { Profile } from "../src/policy/profile.ts";

type FixtureShell = "posix" | "powershell" | "both";

interface CorpusFixture {
  cmd: string;
  shell: FixtureShell;
  profile: Profile;
  expect: "allow" | "deny" | "rail";
  note?: string;
  /** T2b: actor-aware zone classification. Omitted -> classify() fail-closed default (worker). */
  actor?: Actor;
  /** T2b: worker-scoped bash-denylist (consulted only when `actor === "worker"`). */
  zone?: ZoneOptions;
  /** T2b: operator_zone.protected override (consulted only when `actor === "operator"`). */
  protected?: string[];
}

const corpusPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "corpus.json");
const corpus: CorpusFixture[] = JSON.parse(readFileSync(corpusPath, "utf-8"));

function shellsFor(fx: CorpusFixture): readonly ("posix" | "powershell")[] {
  return fx.shell === "both" ? (["posix", "powershell"] as const) : [fx.shell];
}

for (const fx of corpus) {
  for (const shell of shellsFor(fx)) {
    const label = `${JSON.stringify(fx.cmd)} shell=${shell} profile=${fx.profile}${
      fx.actor ? ` actor=${fx.actor}` : ""
    } => ${fx.expect}${fx.note ? ` (${fx.note})` : ""}`;

    test(label, () => {
      const policyOverride: Partial<Policy> | undefined = fx.protected
        ? { operator_zone: { protected: fx.protected } }
        : undefined;
      const policy = resolvePolicy({ explicitProfile: fx.profile, interactive: true, policy: policyOverride });
      const verdict = classify(fx.cmd, { shell, policy, actor: fx.actor, zone: fx.zone });
      assert.equal(
        verdict.decision,
        fx.expect,
        `got decision=${verdict.decision}${verdict.reason ? ` reason=${verdict.reason}` : ""}`
      );
    });
  }
}

test("corpus.json is non-empty (sanity — the loop above actually ran fixtures)", () => {
  assert.ok(corpus.length > 0);
});

// ---------------------------------------------------------------------------
// bash allow-lane (contract T7-0 L-3) — hand-written (not corpus.json: that
// file lives at core/corpus.json, OUTSIDE this task's zone).
// ---------------------------------------------------------------------------

function guardedPolicy() {
  return resolvePolicy({ explicitProfile: "guarded", interactive: true });
}

test("classify: worker, zone.allow set, write target INSIDE allow-lane -> allow", () => {
  const verdict = classify("echo x > core/src/x.ts", {
    shell: "posix",
    policy: guardedPolicy(),
    actor: "worker",
    zone: { allow: ["core/**"] },
  });
  assert.equal(verdict.decision, "allow");
});

test("classify: worker, zone.allow set, write target OUTSIDE allow-lane -> deny", () => {
  const verdict = classify("echo x > out/of/zone", {
    shell: "posix",
    policy: guardedPolicy(),
    actor: "worker",
    zone: { allow: ["core/**"] },
  });
  assert.equal(verdict.decision, "deny");
  assert.ok(verdict.reason?.includes("allow-полосы"));
});

test("classify: worker, zone.allow set, write to active-zone.json listed in zone.deny -> deny even though allow is \"**\"", () => {
  const verdict = classify("echo x > .workflow/active-zone.json", {
    shell: "posix",
    policy: guardedPolicy(),
    actor: "worker",
    zone: { allow: ["**"], deny: [".workflow/active-zone.json"] },
  });
  assert.equal(verdict.decision, "deny");
});

test("classify: worker, zone.allow UNSET (only zone.deny) -> pre-L-3 behaviour unchanged, recognized write outside any protected set still allows", () => {
  const verdict = classify("echo x > anywhere/at/all.txt", {
    shell: "posix",
    policy: guardedPolicy(),
    actor: "worker",
    zone: { deny: [".omp"] },
  });
  assert.equal(verdict.decision, "allow");
});

test("classify: worker, no zone at all (undefined), recognized write-intent -> allow-lane step skipped (pre-L-3 zone.deny-only behaviour, unaffected)", () => {
  const verdict = classify("echo x > anywhere/at/all.txt", {
    shell: "posix",
    policy: guardedPolicy(),
    actor: "worker",
  });
  assert.equal(verdict.decision, "allow");
});

test("classify: operator is NOT affected by zone.allow at all, even with a recognized write-target outside it", () => {
  const verdict = classify("echo x > out/of/zone", {
    shell: "posix",
    policy: guardedPolicy(),
    actor: "operator",
    zone: { allow: ["core/**"] },
  });
  assert.equal(verdict.decision, "allow");
});

test("classify: worker, cp destination outside allow-lane -> deny (\"last\"-arg target mode)", () => {
  const verdict = classify("cp core/src/a.ts out/of/zone.ts", {
    shell: "posix",
    policy: guardedPolicy(),
    actor: "worker",
    zone: { allow: ["core/**"] },
  });
  assert.equal(verdict.decision, "deny");
});

test("classify: worker, cp source+dest both inside allow-lane -> allow", () => {
  const verdict = classify("cp core/src/a.ts core/src/b.ts", {
    shell: "posix",
    policy: guardedPolicy(),
    actor: "worker",
    zone: { allow: ["core/**"] },
  });
  assert.equal(verdict.decision, "allow");
});

test("classify: worker, mkdir target outside allow-lane -> deny (\"all\"-args target mode)", () => {
  const verdict = classify("mkdir out/of/zone", {
    shell: "posix",
    policy: guardedPolicy(),
    actor: "worker",
    zone: { allow: ["core/**"] },
  });
  assert.equal(verdict.decision, "deny");
});

test("classify: worker, touch target inside allow-lane -> allow", () => {
  const verdict = classify("touch core/src/new-file.ts", {
    shell: "posix",
    policy: guardedPolicy(),
    actor: "worker",
    zone: { allow: ["core/**"] },
  });
  assert.equal(verdict.decision, "allow");
});

test("classify: worker, read-only command (no recognized write token) -> allow, regardless of allow-lane", () => {
  const verdict = classify("cat out/of/zone.txt", {
    shell: "posix",
    policy: guardedPolicy(),
    actor: "worker",
    zone: { allow: ["core/**"] },
  });
  assert.equal(verdict.decision, "allow");
});

// ---------------------------------------------------------------------------
// T7-7 L-4 — Bash-symmetry (documented CURRENT behaviour, NOT hardened here):
// unlike `path-zone.ts`'s `classifyPath` (T7-7 L-1, a hard "outside repoRoot"
// floor for Write/Edit), the bash surface has NO repoRoot-boundary check at
// all. `resolveProtectedSet`'s protected-set is matched as a raw substring
// pattern (`zone.ts` `pathSetRegex`) against the write-target TEXT, wherever
// it appears — it never resolves the target to an absolute path / compares
// it against `repoRoot`. An operator bash-writing OUTSIDE the repo (and
// outside any configured protected-name substring) is NOT specially
// checked — same as it always was, pre-T7-7. Tightening the bash surface to
// mirror `classifyPath`'s repoRoot floor is an explicit NON-goal of T7-7
// (contract L-4: "ужесточение Bash вне репо — НЕ в этой задаче").
// ---------------------------------------------------------------------------

test("classify: T7-7 L-4 — operator bash-write to an absolute path OUTSIDE repoRoot is NOT specially checked (no repoRoot floor on the bash surface, unlike classifyPath) — allow", () => {
  const verdict = classify("echo x > /etc/passwd", {
    shell: "posix",
    policy: guardedPolicy(), // operator_zone.protected defaults to [] (+ DEFAULT_PROTECTED '.git' floor)
    actor: "operator",
  });
  assert.equal(verdict.decision, "allow");
});

test("classify: T7-7 L-4 — same for a Windows absolute path outside repoRoot (powershell)", () => {
  const verdict = classify('"x" | Set-Content C:\\Windows\\System32\\evil.txt', {
    shell: "powershell",
    policy: guardedPolicy(),
    actor: "operator",
  });
  assert.equal(verdict.decision, "allow");
});

// ---------------------------------------------------------------------------
// T7-9 L-1 — heredoc body is DATA, not commands, ONLY when the consumer (and
// every sibling pipeline stage) is a provable DATA SINK, and the heredoc
// isn't attached to a compound/loop construct — an ALLOWLIST (lead
// amendment fixing a security regression in the original interpreter
// DENYLIST draft: `xargs`/`awk`/a bare construct-closer all fell through to
// "mask" under that draft even though they can turn heredoc body TEXT into
// EXECUTED commands) — `.workflow/tasks/t7-9-hook-false-denies.md` symptom 1
// + the lead's security-regression amendment.
// ---------------------------------------------------------------------------

test("maskHeredocs: data-sink consumer (cat) -- body+terminator dropped, header line kept", () => {
  const masked = maskHeredocs("cat >> f <<'EOF'\ngit rm --cached x\nEOF\n");
  assert.equal(masked, "cat >> f <<'EOF'\n");
});

test("maskHeredocs: non-data-sink consumer (bash) -- left untouched (body IS commands, fail-closed)", () => {
  const cmd = "bash <<EOF\ngit commit\nEOF\n";
  assert.equal(maskHeredocs(cmd), cmd);
});

test("maskHeredocs: no-op on a command with no heredoc at all", () => {
  const cmd = "git status";
  assert.equal(maskHeredocs(cmd), cmd);
});

test("maskHeredocs: unclosed heredoc -- fail-closed, remainder left untouched", () => {
  const cmd = "cat >> f <<'EOF'\ngit rm --cached x\n";
  assert.equal(maskHeredocs(cmd), cmd);
});

test("maskHeredocs: dash-form <<-EOF -- terminator line may be tab-indented", () => {
  const masked = maskHeredocs("cat >> f <<-EOF\ngit rm --cached x\n\tEOF\necho after\n");
  assert.equal(masked, "cat >> f <<-EOF\necho after\n");
});

test("classify: symptom 1 -- heredoc body (cat consumer) mentioning `git rm` -> allow, not a false raw-git-mut deny", () => {
  const verdict = classify("cat >> f <<'EOF'\ngit rm --cached x\nEOF\n", {
    shell: "posix",
    policy: guardedPolicy(),
    actor: "worker",
  });
  assert.equal(verdict.decision, "allow", `got reason=${verdict.reason}`);
});

test("classify: symptom 1 -- heredoc body (cat consumer) mentioning a protected-path write -> allow (body is data, not a real write)", () => {
  const verdict = classify("cat >> f <<'EOF'\necho x > .git/config\nEOF\n", {
    shell: "posix",
    policy: guardedPolicy(),
    actor: "worker",
  });
  assert.equal(verdict.decision, "allow", `got reason=${verdict.reason}`);
});

test("classify: symptom 1 -- heredoc body (cat consumer) mentioning `rm -rf /` -> allow (security-floor does not scan heredoc data either)", () => {
  const verdict = classify("cat > f <<'EOF'\nrm -rf /\nEOF\n", {
    shell: "posix",
    policy: guardedPolicy(),
    actor: "worker",
  });
  assert.equal(verdict.decision, "allow", `got reason=${verdict.reason}`);
});

test("classify: L-3 non-weakening -- heredoc HEADER line's own write (>> to .git) is still classified normally", () => {
  const verdict = classify("cat >> .git/config <<'EOF'\nharmless text\nEOF\n", {
    shell: "posix",
    policy: guardedPolicy(),
    actor: "worker",
  });
  assert.equal(verdict.decision, "deny", `got reason=${verdict.reason}`);
});

test("classify: L-3 non-weakening -- `bash <<EOF` with `git commit` in body -> deny/rail (bash is not a data sink, body IS commands)", () => {
  const verdict = classify("bash <<EOF\ngit commit -m x\nEOF\n", {
    shell: "posix",
    policy: guardedPolicy(),
    actor: "worker",
  });
  assert.notEqual(verdict.decision, "allow", `got reason=${verdict.reason}`);
});

test("classify: L-3 non-weakening -- non-data-sink (bash) heredoc body writing to a protected path -> deny", () => {
  const verdict = classify("bash <<EOF\necho x > .git/config\nEOF\n", {
    shell: "posix",
    policy: guardedPolicy(),
    actor: "worker",
  });
  assert.equal(verdict.decision, "deny", `got reason=${verdict.reason}`);
});

test("classify: L-3 non-weakening -- unclosed heredoc with `git commit` in the (never-terminated) body -> deny (fail-closed)", () => {
  const verdict = classify("cat >> f <<'EOF'\ngit commit -m x\n", {
    shell: "posix",
    policy: guardedPolicy(),
    actor: "worker",
  });
  assert.notEqual(verdict.decision, "allow", `got reason=${verdict.reason}`);
});

test("classify: L-3 sanity -- `sh -c \"git commit -m x\"` still deny/rail (no heredoc involved, unaffected)", () => {
  const verdict = classify('sh -c "git commit -m x"', {
    shell: "posix",
    policy: guardedPolicy(),
    actor: "worker",
  });
  assert.notEqual(verdict.decision, "allow", `got reason=${verdict.reason}`);
});

test("classify: L-3 sanity -- `eval \"git reset --hard\"` still deny (no heredoc involved, unaffected)", () => {
  const verdict = classify('eval "git reset --hard"', {
    shell: "posix",
    policy: guardedPolicy(),
    actor: "worker",
  });
  assert.equal(verdict.decision, "deny", `got reason=${verdict.reason}`);
});

// ---------------------------------------------------------------------------
// T7-9 L-1 security-regression fix (lead amendment) — the ORIGINAL interpreter
// DENYLIST silently masked (treated as inert data) any heredoc whose consumer
// wasn't on its interpreter list: `xargs`, `awk`, and a bare compound-closer
// (`done`/`}`) all fell through to "mask", even though each can turn the
// heredoc body's TEXT into EXECUTED commands. The allowlist fix
// (`DATA_SINK_WORDS` + compound-construct rejection + pipeline-sibling check,
// contract L-1 (a)/(b)/(c)) must classify all of these as commands (fail-
// closed), not data.
// ---------------------------------------------------------------------------

test("classify: security-regression fix -- `xargs` consumer is NOT a data sink -> heredoc body stays classified as commands -> deny", () => {
  const verdict = classify("xargs echo <<EOF\ngit reset --hard\nEOF\n", {
    shell: "posix",
    policy: guardedPolicy(),
    actor: "worker",
  });
  assert.equal(verdict.decision, "deny", `got reason=${verdict.reason}`);
});

test("classify: security-regression fix -- `while read l; do $l; done <<EOF` -- heredoc attached to loop closer `done` -> not masked -> deny", () => {
  const verdict = classify("while read l; do $l; done <<EOF\ngit reset --hard\nEOF\n", {
    shell: "posix",
    policy: guardedPolicy(),
    actor: "worker",
  });
  assert.equal(verdict.decision, "deny", `got reason=${verdict.reason}`);
});

test("classify: security-regression fix -- `cat <<EOF | xargs git` -- cat IS a sink but sibling pipeline stage `xargs` is NOT -> condition (c) fails -> not masked -> deny", () => {
  const verdict = classify("cat <<EOF | xargs git\ngit reset --hard\nEOF\n", {
    shell: "posix",
    policy: guardedPolicy(),
    actor: "worker",
  });
  assert.equal(verdict.decision, "deny", `got reason=${verdict.reason}`);
});

test("classify: security-regression fix -- `cat <<EOF | awk '{system($0)}'` -- sibling stage `awk` is NOT a data sink -> not masked -> deny", () => {
  const verdict = classify("cat <<EOF | awk '{system($0)}'\ngit reset --hard\nEOF\n", {
    shell: "posix",
    policy: guardedPolicy(),
    actor: "worker",
  });
  assert.equal(verdict.decision, "deny", `got reason=${verdict.reason}`);
});

test("classify: security-regression fix -- `{ cat; } <<EOF` -- heredoc attached to the closing `}`, not to `cat` -> not masked -> deny", () => {
  const verdict = classify("{ cat; } <<EOF\ngit reset --hard\nEOF\n", {
    shell: "posix",
    policy: guardedPolicy(),
    actor: "worker",
  });
  assert.equal(verdict.decision, "deny", `got reason=${verdict.reason}`);
});

test("classify: security-regression fix parity -- plain `cat >> f <<EOF` (single-stage data sink, no compound) -> still masked -> allow", () => {
  const verdict = classify("cat >> f <<EOF\ngit reset --hard\nEOF\n", {
    shell: "posix",
    policy: guardedPolicy(),
    actor: "worker",
  });
  assert.equal(verdict.decision, "allow", `got reason=${verdict.reason}`);
});

test("classify: security-regression fix parity -- plain `tee f <<EOF` (single-stage data sink, no compound) -> still masked -> allow", () => {
  const verdict = classify("tee f <<EOF\ngit reset --hard\nEOF\n", {
    shell: "posix",
    policy: guardedPolicy(),
    actor: "worker",
  });
  assert.equal(verdict.decision, "allow", `got reason=${verdict.reason}`);
});

test("classify: security-regression fix parity -- `cat <<EOF | grep x` (BOTH pipeline stages are data sinks) -> masked -> allow", () => {
  const verdict = classify("cat <<EOF | grep x\ngit reset --hard\nEOF\n", {
    shell: "posix",
    policy: guardedPolicy(),
    actor: "worker",
  });
  assert.equal(verdict.decision, "allow", `got reason=${verdict.reason}`);
});

test("maskHeredocs: security-regression fix -- `xargs` is not masked (unchanged text)", () => {
  const cmd = "xargs echo <<EOF\ngit reset --hard\nEOF\n";
  assert.equal(maskHeredocs(cmd), cmd);
});

test("maskHeredocs: security-regression fix -- `while ... done <<EOF` is not masked (unchanged text)", () => {
  const cmd = "while read l; do $l; done <<EOF\ngit reset --hard\nEOF\n";
  assert.equal(maskHeredocs(cmd), cmd);
});

test("maskHeredocs: security-regression fix -- `cat <<EOF | xargs git` is not masked (unchanged text, sibling stage not a sink)", () => {
  const cmd = "cat <<EOF | xargs git\ngit reset --hard\nEOF\n";
  assert.equal(maskHeredocs(cmd), cmd);
});

test("maskHeredocs: security-regression fix -- `{ cat; } <<EOF` is not masked (unchanged text, attached to `}`)", () => {
  const cmd = "{ cat; } <<EOF\ngit reset --hard\nEOF\n";
  assert.equal(maskHeredocs(cmd), cmd);
});

test("maskHeredocs: security-regression fix parity -- `cat <<EOF | grep x` -- both stages sinks -> body IS masked", () => {
  const masked = maskHeredocs("cat <<EOF | grep x\ngit reset --hard\nEOF\n");
  assert.equal(masked, "cat <<EOF | grep x\n");
});

// ---------------------------------------------------------------------------
// T7-9 L-2 — a WORD write-token (install/cp/mv/tee/touch/mkdir/ln/...) only
// counts as a command word (segment start or a quoted embedded-script
// occurrence), never a bare substring of a path/argument —
// `.workflow/tasks/t7-9-hook-false-denies.md` symptom 2.
// ---------------------------------------------------------------------------

test("classify: symptom 2 -- `bash tools/install.sh --check` -> allow (coreutils `install` is a path segment, not a command word)", () => {
  const verdict = classify("bash tools/install.sh --check", {
    shell: "posix",
    policy: guardedPolicy(),
    actor: "worker",
    zone: { allow: ["core/**"] },
  });
  assert.equal(verdict.decision, "allow", `got reason=${verdict.reason}`);
});

test("classify: symptom 2 -- `grep x tools/install.sh` -> allow (same class, `install` inside a read command's argument)", () => {
  const verdict = classify("grep x tools/install.sh", {
    shell: "posix",
    policy: guardedPolicy(),
    actor: "worker",
    zone: { allow: ["core/**"] },
  });
  assert.equal(verdict.decision, "allow", `got reason=${verdict.reason}`);
});

test("classify: L-3 non-weakening -- a REAL `install` command word outside the worker allow-lane -> deny", () => {
  const verdict = classify("install -m 644 a /etc/x", {
    shell: "posix",
    policy: guardedPolicy(),
    actor: "worker",
    zone: { allow: ["core/**"] },
  });
  assert.equal(verdict.decision, "deny", `got reason=${verdict.reason}`);
});

test("classify: L-3 non-weakening -- `sudo install -m 644 a /etc/x` -> still recognized as the command word past `sudo` -> deny", () => {
  const verdict = classify("sudo install -m 644 a /etc/x", {
    shell: "posix",
    policy: guardedPolicy(),
    actor: "worker",
    zone: { allow: ["core/**"] },
  });
  assert.equal(verdict.decision, "deny", `got reason=${verdict.reason}`);
});

test("classify: L-3 non-weakening -- `powershell -Command \"Remove-Item .git/x\"` still matches nested inside quotes -> deny (unchanged, corpus.json parity)", () => {
  const verdict = classify('powershell -Command "Remove-Item .git/x"', {
    shell: "powershell",
    policy: guardedPolicy(),
    actor: "worker",
  });
  assert.equal(verdict.decision, "deny", `got reason=${verdict.reason}`);
});

test("classify: symptom 2 same-class fix -- `cat tools/touch-notes.sh` -> allow (`touch` is a path segment, not a command word)", () => {
  const verdict = classify("cat tools/touch-notes.sh", {
    shell: "posix",
    policy: guardedPolicy(),
    actor: "worker",
    zone: { allow: ["core/**"] },
  });
  assert.equal(verdict.decision, "allow", `got reason=${verdict.reason}`);
});

test("classify: symptom 2 same-class fix -- `echo src/cp-utils.ts` -> allow (`cp` is a path segment, not a command word)", () => {
  const verdict = classify("echo src/cp-utils.ts", {
    shell: "posix",
    policy: guardedPolicy(),
    actor: "worker",
    zone: { allow: ["core/**"] },
  });
  assert.equal(verdict.decision, "allow", `got reason=${verdict.reason}`);
});

test("classify: symptom 2 same-class fix -- real `touch` command word still recognized -> deny outside allow-lane", () => {
  const verdict = classify("touch out/of/zone.txt", {
    shell: "posix",
    policy: guardedPolicy(),
    actor: "worker",
    zone: { allow: ["core/**"] },
  });
  assert.equal(verdict.decision, "deny", `got reason=${verdict.reason}`);
});
