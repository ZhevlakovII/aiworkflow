import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import {
  appendEvent,
  contractKey12,
  contractKeyHex,
  journalAbsPath,
  journalRelPath,
  normalizeTaskBytes,
  readJournal,
  resolveContractKey,
  stripContractKeyFrontmatter,
} from "../src/stage/journal.ts";

function makeTmp(): string {
  return mkdtempSync(nodePath.join(tmpdir(), "aiwf-stage-journal-"));
}

test("normalizeTaskBytes: CRLF and CR collapse to LF (UTF-8)", () => {
  const a = normalizeTaskBytes("a\r\nb\rc\n");
  const b = normalizeTaskBytes("a\nb\nc\n");
  assert.deepEqual(a, b);
  assert.equal(a.toString("utf-8"), "a\nb\nc\n");
});

test("contractKey12: first 12 hex of sha256 of normalized bytes; CRLF == LF", () => {
  const k1 = contractKey12("hello\r\nworld\n");
  const k2 = contractKey12("hello\nworld\n");
  assert.equal(k1, k2);
  assert.equal(k1.length, 12);
  assert.equal(contractKeyHex("hello\nworld\n").slice(0, 12), k1);
  assert.match(k1, /^[0-9a-f]{12}$/);
});

test("strip: id/supersedes/stage excluded; body+zone stay; stage-only drift shares key", () => {
  const a = ["---", "id: one", "stage: design", "class: feature", "---", "", "# Body", ""].join("\n");
  const b = ["---", "id: two", "supersedes: one", "stage: execute", "class: feature", "---", "", "# Body", ""].join("\n");
  assert.equal(contractKey12(a), contractKey12(b));
  const stripped = stripContractKeyFrontmatter(a);
  assert.doesNotMatch(stripped, /^id:/m);
  assert.doesNotMatch(stripped, /^stage:/m);
  assert.match(stripped, /^class: feature/m);
  assert.match(stripped, /# Body/);
});

test("strip: different zone/body → different key", () => {
  const a = ["---", "id: a", "stage: design", "class: feature", "---", "", "# A", ""].join("\n");
  const b = ["---", "id: a", "stage: design", "class: feature", "---", "", "# B", ""].join("\n");
  assert.notEqual(contractKey12(a), contractKey12(b));
});

test("binds: execute task key equals design target after strip", () => {
  const dir = makeTmp();
  try {
    const design = nodePath.join(dir, "design.md");
    const exec = nodePath.join(dir, "exec.md");
    writeFileSync(
      design,
      ["---", "id: d1", "stage: design", "class: feature", "---", "", "# Design body", ""].join("\n"),
      "utf-8",
    );
    writeFileSync(
      exec,
      ["---", "id: e1", "stage: execute", "class: feature", "binds: design.md", "---", "", "# Exec different body", ""].join("\n"),
      "utf-8",
    );
    const ctx = { repoRoot: dir, exists: existsSync, readFile: (p: string) => readFileSync(p, "utf-8") };
    const dk = contractKey12(readFileSync(design, "utf-8"));
    const ek = contractKey12(readFileSync(exec, "utf-8"), { ...ctx, taskPath: exec });
    assert.equal(ek, dk);
    // Without binds, different bodies would diverge:
    const bare = ["---", "id: e1", "stage: execute", "class: feature", "---", "", "# Exec different body", ""].join("\n");
    assert.notEqual(contractKey12(bare), dk);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("binds fail-closed: missing target", () => {
  const dir = makeTmp();
  try {
    const exec = nodePath.join(dir, "exec.md");
    writeFileSync(exec, ["---", "stage: execute", "binds: missing.md", "---", ""].join("\n"), "utf-8");
    const r = resolveContractKey(readFileSync(exec, "utf-8"), { repoRoot: dir, taskPath: exec });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("binds fail-closed: non-design target", () => {
  const dir = makeTmp();
  try {
    writeFileSync(nodePath.join(dir, "other.md"), ["---", "stage: execute", "---", ""].join("\n"), "utf-8");
    const exec = nodePath.join(dir, "exec.md");
    writeFileSync(exec, ["---", "stage: execute", "binds: other.md", "---", ""].join("\n"), "utf-8");
    const r = resolveContractKey(readFileSync(exec, "utf-8"), { repoRoot: dir, taskPath: exec });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /not stage design/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("binds fail-closed: multiple targets", () => {
  const text = ["---", "stage: execute", "binds: [a.md, b.md]", "---", ""].join("\n");
  const r = resolveContractKey(text, { repoRoot: "/tmp" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /multiple/);
});

test("binds fail-closed: self-cycle", () => {
  const dir = makeTmp();
  try {
    // design that binds to itself — target stage is design so stage check passes, cycle catches
    const p = nodePath.join(dir, "design.md");
    writeFileSync(p, ["---", "stage: design", "binds: design.md", "---", ""].join("\n"), "utf-8");
    const r = resolveContractKey(readFileSync(p, "utf-8"), { repoRoot: dir, taskPath: p });
    // one-hop: target is design.md; we hash target without following binds — cycle only if taskPath==target
    // self-bind: abs path equals taskPath → cycle
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /cycle/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("journalRelPath: .workflow/stages/<ck12>.<stage>.ndjson", () => {
  assert.equal(
    journalRelPath("abcdef012345ffff", "design"),
    ".workflow/stages/abcdef012345.design.ndjson",
  );
});

test("appendEvent + readJournal: append-only NDJSON round-trip in tmp dir", () => {
  const dir = makeTmp();
  try {
    const ck = "aaaaaaaaaaaa";
    const p1 = appendEvent(dir, ck, "design", { type: "design-begin", task: "t.md" });
    assert.equal(p1, journalAbsPath(dir, ck, "design"));
    appendEvent(dir, ck, "design", {
      type: "design-gate",
      verdict: "PASS",
      ts: "2026-01-01T00:00:00.000Z",
    });
    const events = readJournal(dir, ck, "design");
    assert.equal(events.length, 2);
    assert.equal(events[0]!.type, "design-begin");
    assert.equal(events[1]!.type, "design-gate");
    assert.equal(events[1]!.verdict, "PASS");
    assert.equal(events[1]!.ts, "2026-01-01T00:00:00.000Z");
    const raw = readFileSync(p1, "utf-8");
    assert.equal(raw.trim().split("\n").length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readJournal: missing file -> []", () => {
  const dir = makeTmp();
  try {
    assert.deepEqual(readJournal(dir, "bbbbbbbbbbbb", "design"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readJournal: skips malformed lines", () => {
  const dir = makeTmp();
  try {
    const ck = "cccccccccccc";
    const abs = appendEvent(dir, ck, "design", { type: "ok", n: 1 });
    appendFileSync(abs, "NOT JSON\n{\"type\":\"ok2\"}\n", "utf-8");
    const events = readJournal(dir, ck, "design");
    assert.equal(events.length, 2);
    assert.equal(events[0]!.type, "ok");
    assert.equal(events[1]!.type, "ok2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
