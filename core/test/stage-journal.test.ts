import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
