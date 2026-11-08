/**
 * anyOpenExecuteStage / foldExecuteOpen — Design C execute-stage lead freeze.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import {
  anyOpenExecuteStage,
  foldExecuteOpen,
} from "../src/stage/execute-open.ts";
import { STAGES_DIR } from "../src/stage/journal.ts";

function tmpRepo(): string {
  return mkdtempSync(nodePath.join(tmpdir(), "aiwf-exec-open-"));
}

function writeExecuteJournal(repo: string, ck12: string, lines: object[]): void {
  const dir = nodePath.join(repo, STAGES_DIR);
  mkdirSync(dir, { recursive: true });
  const body = lines.map((e) => JSON.stringify(e)).join("\n") + (lines.length ? "\n" : "");
  writeFileSync(nodePath.join(dir, `${ck12}.execute.ndjson`), body, "utf-8");
}

test("foldExecuteOpen: empty → false", () => {
  assert.equal(foldExecuteOpen([]), false);
});

test("foldExecuteOpen: exec-started alone → true", () => {
  assert.equal(foldExecuteOpen([{ type: "exec-started" }]), true);
});

test("foldExecuteOpen: started then done → false", () => {
  assert.equal(
    foldExecuteOpen([{ type: "exec-started" }, { type: "exec-done", outcome: "ok" }]),
    false
  );
});

test("foldExecuteOpen: re-open after done → true", () => {
  assert.equal(
    foldExecuteOpen([
      { type: "exec-started" },
      { type: "exec-done", outcome: "ok" },
      { type: "exec-started" },
    ]),
    true
  );
});

test("anyOpenExecuteStage: missing stages dir → false", () => {
  const repo = tmpRepo();
  try {
    assert.equal(anyOpenExecuteStage(repo), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("anyOpenExecuteStage: empty execute journal → false", () => {
  const repo = tmpRepo();
  try {
    writeExecuteJournal(repo, "aaaaaaaaaaaa", []);
    assert.equal(anyOpenExecuteStage(repo), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("anyOpenExecuteStage: open exec-started → true", () => {
  const repo = tmpRepo();
  try {
    writeExecuteJournal(repo, "bbbbbbbbbbbb", [{ type: "exec-started", ts: "t1" }]);
    assert.equal(anyOpenExecuteStage(repo), true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("anyOpenExecuteStage: exec-done clears → false", () => {
  const repo = tmpRepo();
  try {
    writeExecuteJournal(repo, "cccccccccccc", [
      { type: "exec-started", ts: "t1" },
      { type: "exec-done", outcome: "ok", ts: "t2" },
    ]);
    assert.equal(anyOpenExecuteStage(repo), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("anyOpenExecuteStage: any one open ck12 freezes (others closed)", () => {
  const repo = tmpRepo();
  try {
    writeExecuteJournal(repo, "dddddddddddd", [
      { type: "exec-started" },
      { type: "exec-done", outcome: "ok" },
    ]);
    writeExecuteJournal(repo, "eeeeeeeeeeee", [{ type: "exec-started" }]);
    writeExecuteJournal(repo, "ffffffffffff", [
      { type: "exec-started" },
      { type: "exec-done", outcome: "violation" },
    ]);
    assert.equal(anyOpenExecuteStage(repo), true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("anyOpenExecuteStage: ignores non-execute journals", () => {
  const repo = tmpRepo();
  try {
    const dir = nodePath.join(repo, STAGES_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      nodePath.join(dir, "gggggggggggg.design.ndjson"),
      JSON.stringify({ type: "design-begin" }) + "\n",
      "utf-8"
    );
    assert.equal(anyOpenExecuteStage(repo), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
