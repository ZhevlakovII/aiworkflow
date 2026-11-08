import { test } from "node:test";
import assert from "node:assert/strict";

import { KICK, extractTaskId, allTerminal, isErrorEvent } from "../src/ops/queue-rpc.ts";

// ---------------------------------------------------------------------------
// KICK (contract L-4: exact wording matters — the worker is told to echo it back)
// ---------------------------------------------------------------------------

test("KICK: exact wording (worker replies QUEUE-READY to this)", () => {
  assert.equal(
    KICK,
    "Autonomous queue mode armed. Reply exactly QUEUE-READY, then process each injected " +
      "task prompt as it arrives. Do nothing else on your own.",
  );
});

// ---------------------------------------------------------------------------
// extractTaskId (task-file `id:` frontmatter field, else filename stem)
// ---------------------------------------------------------------------------

test("extractTaskId: extracts `id:` field from frontmatter", () => {
  const text = "---\nid: t7-5-ops-ts\nstage: execute\n---\n# body";
  assert.equal(extractTaskId(text, "fallback-stem"), "t7-5-ops-ts");
});

test("extractTaskId: trims surrounding whitespace on the id value", () => {
  const text = "id:   t7-5   \n";
  assert.equal(extractTaskId(text, "fallback"), "t7-5");
});

test("extractTaskId: no `id:` field -> falls back to the given stem", () => {
  const text = "---\nstage: execute\n---\n";
  assert.equal(extractTaskId(text, "money-abs-2026"), "money-abs-2026");
});

test("extractTaskId: matches `id:` on any line (multiline flag), not just the first", () => {
  const text = "stage: execute\nid: t2\ncapability: money\n";
  assert.equal(extractTaskId(text, "fallback"), "t2");
});

// ---------------------------------------------------------------------------
// allTerminal (queue-drained check)
// ---------------------------------------------------------------------------

test("allTerminal: empty ids -> false (never 'drained' with zero tasks)", () => {
  assert.equal(allTerminal(new Set(), {}), false);
});

test("allTerminal: all ids done/blocked -> true", () => {
  const ids = new Set(["a", "b"]);
  assert.equal(allTerminal(ids, { a: "done", b: "blocked" }), true);
});

test("allTerminal: any id missing/pending/active -> false", () => {
  const ids = new Set(["a", "b"]);
  assert.equal(allTerminal(ids, { a: "done", b: "active" }), false);
  assert.equal(allTerminal(ids, { a: "done" }), false); // b missing from state
});

// ---------------------------------------------------------------------------
// isErrorEvent (parsed-event shape preferred, raw-line regex fallback)
// ---------------------------------------------------------------------------

test("isErrorEvent: ev.type === 'error' -> true", () => {
  assert.equal(isErrorEvent("{}", { type: "error" }), true);
});

test("isErrorEvent: ev.isError === true -> true", () => {
  assert.equal(isErrorEvent("{}", { isError: true }), true);
});

test("isErrorEvent: ev.level === 'error' -> true", () => {
  assert.equal(isErrorEvent("{}", { level: "error" }), true);
});

test("isErrorEvent: ev.error is a non-empty dict/string -> true", () => {
  assert.equal(isErrorEvent("{}", { error: { message: "x" } }), true);
  assert.equal(isErrorEvent("{}", { error: "boom" }), true);
});

test("isErrorEvent: ev.error empty string -> false (falsy, same as Python truthiness)", () => {
  assert.equal(isErrorEvent("{}", { error: "" }), false);
});

test("isErrorEvent: ev.subtype/kind containing 'error' (case-insensitive) -> true", () => {
  assert.equal(isErrorEvent("{}", { subtype: "ToolError" }), true);
  assert.equal(isErrorEvent("{}", { kind: "stream_error" }), true);
});

test("isErrorEvent: clean event shape -> false", () => {
  assert.equal(isErrorEvent("{}", { type: "agent_start" }), false);
});

test("isErrorEvent: ev=null -> falls back to raw-line regex", () => {
  assert.equal(isErrorEvent('{"type": "error", "detail": "x"}', null), true);
  assert.equal(isErrorEvent('{"isError": true}', null), true);
  assert.equal(isErrorEvent("plain non-json line", null), false);
});
