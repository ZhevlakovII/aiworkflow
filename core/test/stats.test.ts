import { test } from "node:test";
import assert from "node:assert/strict";

import { load, pyRound, summarize, render, exportCsv, drill } from "../src/ops/stats.ts";

// ---------------------------------------------------------------------------
// load (contract L-1: kind=guard -> guards, else -> runs; malformed/blank -> skip)
// ---------------------------------------------------------------------------

test("load: splits kind=guard vs everything else, skips blank/malformed lines", () => {
  const text = [
    JSON.stringify({ kind: "run", outcome: "committed" }),
    "",
    "   ",
    "{not json",
    JSON.stringify({ kind: "guard", event: "zone-violation" }),
    JSON.stringify({ tool: "x" }), // no kind -> run
  ].join("\n");
  const { runs, guards } = load(text);
  assert.equal(runs.length, 2);
  assert.equal(guards.length, 1);
  assert.equal(guards[0].event, "zone-violation");
});

test("load: empty text -> empty runs/guards", () => {
  assert.deepEqual(load(""), { runs: [], guards: [] });
});

// ---------------------------------------------------------------------------
// pyRound (round-half-to-even, best-effort — see stats.ts module doc-comment)
// ---------------------------------------------------------------------------

test("pyRound: half-to-even ties (ndigits=0)", () => {
  assert.equal(pyRound(0.5), 0);
  assert.equal(pyRound(1.5), 2);
  assert.equal(pyRound(2.5), 2);
  assert.equal(pyRound(3.5), 4);
});

test("pyRound: non-tie rounds normally", () => {
  assert.equal(pyRound(2.4), 2);
  assert.equal(pyRound(2.6), 3);
});

test("pyRound: ndigits > 0", () => {
  assert.equal(pyRound(1.005, 2), 1); // float-imprecision floor case (1.005 stored as slightly < 1.005)
  assert.equal(pyRound(1.25, 1), 1.2); // half-to-even at 1 decimal
  assert.equal(pyRound(3.14159, 4), 3.1416);
});

// ---------------------------------------------------------------------------
// summarize (contract L-1: perf/byModel grouping, outcomes, guard/error axes)
// ---------------------------------------------------------------------------

function run(o: Record<string, unknown>): Record<string, unknown> {
  return { kind: "run", backend: "claude", stage: "execute", model: "sonnet", outcome: "committed", durationMs: 100, ...o };
}

test("summarize: totals.runs/guards count, perf grouped by backend x stage", () => {
  const runs = [run({}), run({ backend: "codex" })];
  const guards = [{ kind: "guard", event: "zone-violation", backend: "claude" }];
  const s = summarize(runs, guards);
  assert.equal(s.totals.runs, 2);
  assert.equal(s.totals.guards, 1);
  assert.equal(s.perf.length, 2); // claude/execute, codex/execute
  const claudeRow = s.perf.find((p) => p.backend === "claude")!;
  assert.equal(claudeRow.runs, 1);
  assert.equal(claudeRow.okPct, 100);
});

test("summarize: verified requires outcome=committed AND testCmd!=red AND frCovered>=frTotal", () => {
  const runs = [
    run({ outcome: "committed" }), // verified
    run({ outcome: "committed", testCmd: "red" }), // not verified (red)
    run({ outcome: "committed", frTotal: 3, frCovered: 1 }), // not verified (fr gap)
    run({ outcome: "blocked" }), // not verified (not committed)
  ];
  const s = summarize(runs, []);
  const row = s.perf[0];
  assert.equal(row.runs, 4);
  assert.equal(row.verified, 1);
});

test("summarize: outcomes/guardByEvent sorted desc by count (stable on ties)", () => {
  const runs = [run({ outcome: "committed" }), run({ outcome: "committed" }), run({ outcome: "blocked" })];
  const guards = [
    { kind: "guard", event: "gate-red", backend: "claude" },
    { kind: "guard", event: "zone-violation", backend: "claude" },
    { kind: "guard", event: "zone-violation", backend: "codex" },
  ];
  const s = summarize(runs, guards);
  assert.deepEqual(s.outcomes, { committed: 2, blocked: 1 });
  assert.deepEqual(s.guardByEvent, { "zone-violation": 2, "gate-red": 1 });
  assert.deepEqual(s.guardByBackendEvent, { "claude/zone-violation": 1, "codex/zone-violation": 1, "claude/gate-red": 1 });
});

test("summarize: errors axis — byClass/byBackendClass/samples, and reqErrors aggregation", () => {
  const runs = [
    run({ outcome: "error", errClass: "timeout", errMsg: "took too long and then some extra detail to truncate at eighty chars exactly here" }),
    run({ outcome: "error", errClass: "timeout" }),
    run({ reqErrors: 2, reqErrClasses: "rate-limit,timeout" }),
  ];
  const s = summarize(runs, []);
  assert.equal(s.errors.byClass.timeout, 2);
  assert.equal(s.errors.byBackendClass["claude/timeout"], 2);
  assert.ok(s.errors.samples.timeout.length <= 80);
  assert.equal(s.errors.reqErrTotal, 2);
  assert.equal(s.errors.reqErrRuns, 1);
  assert.equal(s.errors.reqErrByClass["rate-limit"], 2);
  assert.equal(s.errors.reqErrByClass.timeout, 2);
});

test("summarize: costPerVerified null when no verified runs, computed when there are", () => {
  const s0 = summarize([run({ outcome: "blocked" })], []);
  assert.equal(s0.totals.costPerVerified, null);
  const runs = [run({ outcome: "committed", worker: { costUsd: 0.5 } })];
  const s1 = summarize(runs, []);
  assert.equal(s1.totals.verified, 1);
  assert.equal(s1.totals.costPerVerified, 0.5);
});

// ---------------------------------------------------------------------------
// render (text formatting — column widths/labels, see stats.ts float deviation note)
// ---------------------------------------------------------------------------

test("render: header line + totals summary present", () => {
  const s = summarize([run({ outcome: "committed" })], []);
  const text = render(s);
  // ver=1 (truthy) with zero cost still computes costPerVerified=0 (not null) — only ZERO verified runs -> "n/a" (see the costPerVerified null-vs-computed test below).
  assert.match(text, /^== TELEMETRY == runs=1 guards=0 cost=\$0\.0 verified=1 cost\/verified=\$0\.0$/m);
  assert.match(text, /-- perf \+ consumption \(backend x stage\) --/);
  assert.match(text, /backend {5}stage/); // ljust(12) label columns concatenated ("backend".length=7 -> 5 pad-spaces)
});

test("render: empty guards/errors -> placeholder lines", () => {
  const s = summarize([run({ outcome: "committed" })], []);
  const text = render(s);
  assert.match(text, /\(нет срабатываний рельсов — чисто\)/);
  assert.match(text, /\(нет фейлов с errClass\)/);
  assert.match(text, /\(чисто — request-ошибок в потоке не зафиксировано\)/);
});

// ---------------------------------------------------------------------------
// exportCsv (Python csv.writer default dialect: \r\n terminator, quote-on-demand)
// ---------------------------------------------------------------------------

test("exportCsv: header row matches CSV_COLS, worker.* pulled from nested worker object", () => {
  const runs = [run({ tid: "t1", worker: { costUsd: 1.5, totalTok: 100 } })];
  const csv = exportCsv(runs);
  const lines = csv.split("\r\n");
  assert.equal(lines[0].startsWith("ts,tool,tid,stage"), true);
  const dataRow = lines[1].split(",");
  const tidIdx = lines[0].split(",").indexOf("tid");
  assert.equal(dataRow[tidIdx], "t1");
  assert.equal(csv.endsWith("\r\n"), true);
});

test("exportCsv: quotes fields containing comma/quote/newline", () => {
  const csv = exportCsv([run({ tid: "a,b", errMsg: 'say "hi"' })]);
  assert.match(csv, /"a,b"/);
  assert.match(csv, /"say ""hi"""/);
});

// ---------------------------------------------------------------------------
// drill (per-tid run+guard timeline, ts-sorted)
// ---------------------------------------------------------------------------

test("drill: no rows for tid -> placeholder message", () => {
  assert.equal(drill("missing", [], []), "нет строк для tid=missing");
});

test("drill: merges+sorts run/guard rows by ts, formats each line", () => {
  const runs = [{ tid: "t1", ts: "2026-01-01T00:00:02", tool: "execute", backend: "claude", outcome: "committed", durationMs: 10, commit: "abc1234" }];
  const guards = [{ tid: "t1", ts: "2026-01-01T00:00:01", event: "zone-violation", detail: "core/x.ts" }];
  const out = drill("t1", runs, guards);
  const lines = out.split("\n");
  assert.equal(lines[0], "== tid=t1 (2 строк) ==");
  assert.match(lines[1], /^ {2}\[guard\] 2026-01-01T00:00:01 zone-violation: core\/x\.ts$/);
  assert.match(lines[2], /^ {2}\[run\] {3}2026-01-01T00:00:02 execute\/claude → committed dur=10ms cost=\$\? commit=abc1234$/);
});
