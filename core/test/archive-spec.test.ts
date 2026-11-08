import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

import { mergeCanon, parseBlocksRaw, emitCanon, applyDedupe, buildDedupePrompt } from "../src/design/archive-spec.ts";
import { runArchiveSpecCli } from "../src/design/archive-spec-cli.ts";
import type { GitSeam } from "../src/rails/git-seam.ts";

const FX = path.resolve(import.meta.dirname, "fixtures/design/archive");
const fxText = (name: string) => fs.readFileSync(path.join(FX, name), "utf8");

// ---------------------------------------------------------------------------
// mergeCanon / emitCanon (pure core) — B.2a/B.2b regression, ported from
// tools/tests/{test_archive_spec.py, test_archive_parity.py}
// ---------------------------------------------------------------------------

test("mergeCanon: A into empty canon -> ADD:2, no collisions", () => {
  const mA = mergeCanon(parseBlocksRaw(fxText("changeA-spec.md")), "", "changeA");
  assert.equal(mA.added.length, 2);
  assert.equal(mA.collisions.length, 0);
  assert.equal(mA.skipped.length, 0);
});

test("mergeCanon: B into canon-A -> SKIP FR-y (same statement), COLLISION SP-x (diff statement), ADD FR-z", () => {
  const mA = mergeCanon(parseBlocksRaw(fxText("changeA-spec.md")), "", "changeA");
  const canonA = emitCanon("theme", mA.canon);
  const mB = mergeCanon(parseBlocksRaw(fxText("changeB-spec.md")), canonA, "changeB");
  assert.deepEqual(mB.added, ["FR-z"]);
  assert.deepEqual(mB.skipped, ["FR-y"]);
  assert.deepEqual(mB.collisions, ["SP-x"]);
});

test("mergeCanon: provenance — canon carries from:<change-id> for both changes; collision keeps OLD statement", () => {
  const mA = mergeCanon(parseBlocksRaw(fxText("changeA-spec.md")), "", "changeA");
  const canonA = emitCanon("theme", mA.canon);
  const mB = mergeCanon(parseBlocksRaw(fxText("changeB-spec.md")), canonA, "changeB");
  const canonB = emitCanon("theme", mB.canon);
  assert.match(canonB, /from: changeA/);
  assert.match(canonB, /from: changeB/);
  assert.match(canonB, /single source of truth/);
  assert.doesNotMatch(canonB, /cache mirror/);
});

test("mergeCanon: collision resolved via reconcile-callback -> reconciled, not collision", () => {
  const mA = mergeCanon(parseBlocksRaw(fxText("changeA-spec.md")), "", "changeA");
  const canonA = emitCanon("theme", mA.canon);
  const mB = mergeCanon(parseBlocksRaw(fxText("changeB-spec.md")), canonA, "changeB", (id, oldBody) => {
    if (id !== "SP-x") return null;
    return oldBody.replace("single source of truth", "reconciled statement");
  });
  assert.deepEqual(mB.collisions, []);
  assert.deepEqual(mB.reconciled, ["SP-x"]);
  const canonB = emitCanon("theme", mB.canon);
  assert.match(canonB, /reconciled statement/);
});

// ---------------------------------------------------------------------------
// applyDedupe / buildDedupePrompt (pure) — #4c regression, ported from
// tools/tests/test_dedupe_unit.py
// ---------------------------------------------------------------------------

const dedupeCanon = [
  { kind: "fr" as const, body: "id: FR-a\nstatement: X" },
  { kind: "fr" as const, body: "id: FR-b\nstatement: Y" },
  { kind: "fr" as const, body: "id: FR-c\nstatement: Z" },
];

test("buildDedupePrompt: lists every block by index/id", () => {
  const p = buildDedupePrompt(dedupeCanon);
  assert.match(p, /\[0\] id=FR-a/);
  assert.match(p, /\[2\] id=FR-c/);
});

test("applyDedupe: drops the flagged pair, keeps the rest, emits one note", () => {
  const d = applyDedupe(dedupeCanon, '```json\n[{"keep":0,"drop":1,"reason":"dup"}]\n```');
  const ids = d.canon.map((b) => (b.body.match(/id: (\S+)/) as RegExpMatchArray)[1]);
  assert.deepEqual(ids, ["FR-a", "FR-c"]);
  assert.equal(d.notes.length, 1);
});

test("applyDedupe: malformed JSON -> canon unchanged", () => {
  const d = applyDedupe(dedupeCanon, "garbage");
  assert.equal(d.canon.length, 3);
});

test("applyDedupe: empty pairs array -> canon unchanged, no notes", () => {
  const d = applyDedupe(dedupeCanon, "[]");
  assert.equal(d.canon.length, 3);
  assert.equal(d.notes.length, 0);
});

test("applyDedupe: out-of-range drop index -> ignored, canon unchanged", () => {
  const d = applyDedupe(dedupeCanon, '[{"keep":0,"drop":9,"reason":"x"}]');
  assert.equal(d.canon.length, 3);
});

// ---------------------------------------------------------------------------
// runArchiveSpecCli (argv/fs shell, output/exit parity with tools/archive_spec.py)
// ---------------------------------------------------------------------------

function fakeClaude(result: { code: number; stdout: string; stderr: string }): GitSeam {
  return { run: () => result, runShell: () => result };
}

function memFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  return {
    files,
    exists: (p: string) => files.has(p),
    readFile: (p: string) => files.get(p) ?? "",
    writeFile: (p: string, content: string) => { files.set(p, content); },
    mkdir: (_p: string) => {},
  };
}

test("CLI: change with no SP/FR blocks -> 'nothing to merge', exit 0, no canon write", () => {
  const changeP = path.resolve("/repo/change.md");
  const dep = memFs({ [changeP]: "# nothing here\n" });
  const out = runArchiveSpecCli(["--change", changeP], { ...dep, repoRoot: "/repo" });
  assert.equal(out.exitCode, 0);
  assert.match(out.stdout, /nothing to merge/);
  assert.equal(dep.files.has(path.resolve("/repo", "docs/spec", "system.md")), false);
});

test("CLI: change with SP/FR blocks, empty canon -> ADD:2, exit 0, canon written", () => {
  const changeP = path.resolve("/repo/changeA-spec.md");
  const dep = memFs({ [changeP]: fxText("changeA-spec.md") });
  const out = runArchiveSpecCli(
    ["--change", changeP, "--capability", "theme", "--spec-dir", "docs/spec"],
    { ...dep, repoRoot: "/repo" },
  );
  assert.equal(out.exitCode, 0);
  assert.match(out.stdout, /ADD:2 SKIP:0 RECONCILED:0 COLLISION:0/);
  assert.match(out.stdout, /ARCHIVE: OK/);
  const canonP = path.resolve("/repo", "docs/spec", "theme.md");
  assert.ok(dep.files.has(canonP));
});

test("CLI: unresolved collision -> exit 1, ARCHIVE: BLOCKED", () => {
  const changeAP = path.resolve("/repo/changeA-spec.md");
  const changeBP = path.resolve("/repo/changeB-spec.md");
  const dep = memFs({ [changeAP]: fxText("changeA-spec.md"), [changeBP]: fxText("changeB-spec.md") });
  const depsA = { ...dep, repoRoot: "/repo" };
  const outA = runArchiveSpecCli(["--change", changeAP, "--capability", "theme"], depsA);
  assert.equal(outA.exitCode, 0);
  const outB = runArchiveSpecCli(["--change", changeBP, "--capability", "theme"], depsA);
  assert.equal(outB.exitCode, 1);
  assert.match(outB.stdout, /ADD:1 SKIP:1 RECONCILED:0 COLLISION:1/);
  assert.match(outB.stdout, /! SP-x/);
  assert.match(outB.stdout, /ARCHIVE: BLOCKED/);
});

test("CLI: --reconcile resolves the collision via the injected claude seam -> exit 0", () => {
  const changeAP = path.resolve("/repo/changeA-spec.md");
  const changeBP = path.resolve("/repo/changeB-spec.md");
  const dep = memFs({ [changeAP]: fxText("changeA-spec.md"), [changeBP]: fxText("changeB-spec.md") });
  const claude = fakeClaude({
    code: 0,
    stdout: JSON.stringify({ result: "```spec\nid: SP-x\nstatement: reconciled\n```" }),
    stderr: "",
  });
  const depsA = { ...dep, repoRoot: "/repo" };
  runArchiveSpecCli(["--change", changeAP, "--capability", "theme"], depsA);
  const outB = runArchiveSpecCli(["--change", changeBP, "--capability", "theme", "--reconcile"], { ...depsA, claude });
  assert.equal(outB.exitCode, 0);
  assert.match(outB.stdout, /RECONCILED:1 COLLISION:0/);
});

test("CLI: missing --change file -> exit 2, stderr 'change-spec не найден'", () => {
  const dep = memFs({});
  const out = runArchiveSpecCli(["--change", "/repo/nope.md"], { ...dep, repoRoot: "/repo" });
  assert.equal(out.exitCode, 2);
  assert.match(out.stderr, /change-spec не найден/);
});

test("CLI: unknown flag -> exit 2 usage error", () => {
  const dep = memFs({});
  const out = runArchiveSpecCli(["--bogus"], { ...dep, repoRoot: "/repo" });
  assert.equal(out.exitCode, 2);
  assert.match(out.stderr, /неизвестный аргумент/);
});
