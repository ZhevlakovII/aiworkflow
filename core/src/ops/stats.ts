/**
 * stats core (T7-5, contract L-1) — pure TS port of `tools/stats.py`'s
 * reader/aggregator/renderer (3 axes: perf / consumption / quality-safety)
 * over `.workflow/telemetry.ndjson` (`kind:run` per stage-run, `kind:guard`
 * per rail-firing — format written by the rails/queue drivers).
 *
 * fs/argv/CLI shell lives in `./stats-cli.ts` (same pure-core + thin-cli
 * split as `../zone/zone-check{,-cli}.ts`).
 *
 * Known deviation (contract L-1, flagged — not a fix, this module is
 * best-effort ops tooling, not a governance chokepoint): Python's `round()`
 * is round-half-to-even on the EXACT binary double; `pyRound` below
 * approximates that (round-half-to-even on the scaled decimal) but is not a
 * bit-for-bit port of CPython's correctly-rounded-decimal algorithm — ties
 * introduced by float imprecision can, in rare cases, round differently.
 * Likewise Python's `str(float)` always shows a `.0`/trailing digits for a
 * float-typed value (e.g. `5.0`) where a bare JS `String(5)` would print
 * `5`; `pyFloatStr` restores the `.0` for the float-typed columns
 * (avgBounces/totalCost/avgCost/costPerVerified) in `render()`'s TEXT
 * output. The `--json` path does NOT restore this (plain JS numbers,
 * `JSON.stringify(5)` -> `"5"` not `"5.0"`) — numerically identical,
 * byte-different from Python's `json.dumps`; downstream JSON consumers
 * parse both as the same number.
 */

export type Row = Record<string, unknown>;

export interface LoadResult {
  runs: Row[];
  guards: Row[];
}

export function load(text: string): LoadResult {
  const runs: Row[] = [];
  const guards: Row[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let o: Row;
    try {
      o = JSON.parse(line) as Row;
    } catch {
      continue;
    }
    (o.kind === "guard" ? guards : runs).push(o);
  }
  return { runs, guards };
}

/** Round-half-to-even, best-effort port of Python's `round(x[, ndigits])` (see module doc-comment for the known deviation). `ndigits` omitted (0) -> Python returns `int`; here it's still a JS `number`, integral. */
export function pyRound(x: number, ndigits = 0): number {
  if (!Number.isFinite(x)) return x;
  const m = Math.pow(10, ndigits);
  const scaled = x * m;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let rounded: number;
  const EPS = 1e-9;
  if (diff > 0.5 + EPS) rounded = floor + 1;
  else if (diff < 0.5 - EPS) rounded = floor;
  else rounded = floor % 2 === 0 ? floor : floor + 1;
  return rounded / m;
}

/** Python's `str(float)` always keeps a decimal point for a float-typed value (e.g. `5.0`), unlike bare JS `String()`. Used only for the float-typed columns in `render()`'s text output. */
export function pyFloatStr(n: number): string {
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

function avg(xs: readonly number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function verified(r: Row): boolean {
  if (r.outcome !== "committed") return false;
  if (r.testCmd === "red") return false;
  const ft = r.frTotal;
  const fc = r.frCovered;
  if (typeof ft === "number" && Number.isInteger(ft) && typeof fc === "number" && Number.isInteger(fc) && fc < ft) {
    return false;
  }
  return true;
}

function wnum(r: Row, key: string): number | undefined {
  const w = r.worker;
  if (w && typeof w === "object") {
    const v = (w as Row)[key];
    if (isNum(v)) return v;
  }
  return undefined;
}

export interface AggRow extends Row {
  runs: number;
  ok: number;
  okPct: number;
  verified: number;
  verPct: number;
  avgStageMs: number;
  avgWorkerMs: number;
  avgBounces: number;
  totalCost: number;
  avgCost: number;
  avgTok: number;
  costPerVerified: number | null;
}

function agg(label: Row, rs: readonly Row[]): AggRow {
  const durs = rs.map((r) => r.durationMs).filter(isNum);
  const wdurs = rs.map((r) => wnum(r, "durationMs")).filter((v): v is number => v !== undefined);
  const bounces = rs.map((r) => r.bounces).filter((v): v is number => typeof v === "number" && Number.isInteger(v));
  const ok = rs.filter((r) => r.outcome === "committed").length;
  const ver = rs.filter(verified).length;
  const costs = rs.map((r) => wnum(r, "costUsd")).filter((v): v is number => v !== undefined);
  const toks = rs.map((r) => wnum(r, "totalTok")).filter((v): v is number => v !== undefined);
  return {
    ...label,
    runs: rs.length,
    ok,
    okPct: rs.length ? pyRound((100 * ok) / rs.length) : 0,
    verified: ver,
    verPct: rs.length ? pyRound((100 * ver) / rs.length) : 0,
    avgStageMs: pyRound(avg(durs)),
    avgWorkerMs: pyRound(avg(wdurs)),
    avgBounces: pyRound(avg(bounces), 2),
    totalCost: pyRound(costs.reduce((a, b) => a + b, 0), 4),
    avgCost: pyRound(avg(costs), 4),
    avgTok: pyRound(avg(toks)),
    costPerVerified: ver ? pyRound(costs.reduce((a, b) => a + b, 0) / ver, 4) : null,
  };
}

function group<K>(rows: readonly Row[], keyfn: (r: Row) => K): Map<K, Row[]> {
  const d = new Map<K, Row[]>();
  for (const r of rows) {
    const k = keyfn(r);
    const bucket = d.get(k);
    if (bucket) bucket.push(r);
    else d.set(k, [r]);
  }
  return d;
}

function sortMapByCountDesc<K>(m: Map<K, number>): Array<[K, number]> {
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

const SEP = "\u0000";

export interface ErrorsSummary {
  byClass: Record<string, number>;
  byBackendClass: Record<string, number>;
  samples: Record<string, string>;
  reqErrTotal: number;
  reqErrRuns: number;
  reqErrByClass: Record<string, number>;
}

export interface Summary {
  totals: { runs: number; guards: number; totalCost: number; verified: number; costPerVerified: number | null };
  perf: AggRow[];
  byModel: AggRow[];
  outcomes: Record<string, number>;
  guardByEvent: Record<string, number>;
  guardByBackendEvent: Record<string, number>;
  errors: ErrorsSummary;
}

export function summarize(runs: readonly Row[], guards: readonly Row[]): Summary {
  const perfGroups = group(runs, (r) => `${(r.backend as string) ?? "?"}${SEP}${(r.stage as string) ?? "?"}`);
  const perf = [...perfGroups.keys()]
    .sort()
    .map((k) => {
      const [backend, stage] = k.split(SEP);
      return agg({ backend, stage }, perfGroups.get(k)!);
    });

  const modelGroups = group(runs, (r) => (r.model as string) ?? "?");
  const byModel = [...modelGroups.keys()].sort().map((m) => agg({ model: m }, modelGroups.get(m)!));

  const outcomes = new Map<string, number>();
  for (const r of runs) {
    const k = (r.outcome as string) ?? "?";
    outcomes.set(k, (outcomes.get(k) || 0) + 1);
  }

  const gEvent = new Map<string, number>();
  const gBe = new Map<string, number>();
  for (const g of guards) {
    const ev = (g.event as string) ?? "?";
    gEvent.set(ev, (gEvent.get(ev) || 0) + 1);
    const be = `${(g.backend as string) ?? "?"}${SEP}${ev}`;
    gBe.set(be, (gBe.get(be) || 0) + 1);
  }

  const errClass = new Map<string, number>();
  const errBe = new Map<string, number>();
  const errSamples = new Map<string, string>();
  let reqTotal = 0;
  let reqRuns = 0;
  const reqByClass = new Map<string, number>();
  for (const r of runs) {
    const ec = r.errClass;
    if (typeof ec === "string" && ec) {
      errClass.set(ec, (errClass.get(ec) || 0) + 1);
      const be = `${(r.backend as string) ?? "?"}${SEP}${ec}`;
      errBe.set(be, (errBe.get(be) || 0) + 1);
      if (!errSamples.has(ec) && r.errMsg) errSamples.set(ec, String(r.errMsg).slice(0, 80));
    }
    const reN = r.reqErrors;
    if (typeof reN === "number" && Number.isInteger(reN) && reN > 0) {
      reqTotal += reN;
      reqRuns += 1;
      for (const c of String(r.reqErrClasses ?? "").split(",")) {
        const t = c.trim();
        if (t) reqByClass.set(t, (reqByClass.get(t) || 0) + reN);
      }
    }
  }

  const asRecord = (entries: Array<[string, number]>): Record<string, number> => Object.fromEntries(entries);
  const asJoinedRecord = (entries: Array<[string, number]>): Record<string, number> =>
    Object.fromEntries(entries.map(([k, n]) => [k.replace(SEP, "/"), n]));

  const totalCost = pyRound(
    perf.reduce((a, p) => a + p.totalCost, 0),
    4,
  );
  const totalVer = perf.reduce((a, p) => a + p.verified, 0);

  return {
    totals: {
      runs: runs.length,
      guards: guards.length,
      totalCost,
      verified: totalVer,
      costPerVerified: totalVer ? pyRound(totalCost / totalVer, 4) : null,
    },
    perf,
    byModel,
    outcomes: asRecord(sortMapByCountDesc(outcomes)),
    guardByEvent: asRecord(sortMapByCountDesc(gEvent)),
    guardByBackendEvent: asJoinedRecord(sortMapByCountDesc(gBe)),
    errors: {
      byClass: asRecord(sortMapByCountDesc(errClass)),
      byBackendClass: asJoinedRecord(sortMapByCountDesc(errBe)),
      samples: Object.fromEntries(errSamples),
      reqErrTotal: reqTotal,
      reqErrRuns: reqRuns,
      reqErrByClass: asRecord(sortMapByCountDesc(reqByClass)),
    },
  };
}

// ---------------------------------------------------------------------------
// render — text table (contract L-1: text-format parity target, see the
// module doc-comment for the one known float-formatting deviation).
// ---------------------------------------------------------------------------

const LABEL_COLS = new Set(["backend", "stage", "model"]);
const FLOAT_COLS = new Set(["avgBounces", "totalCost", "avgCost", "costPerVerified"]);
const METRIC_COLS: Array<[string, string]> = [
  ["runs", "runs"],
  ["okPct", "ok%"],
  ["verPct", "ver%"],
  ["avgStageMs", "stageMs"],
  ["avgWorkerMs", "wrkMs"],
  ["avgBounces", "bounce"],
  ["totalCost", "cost$"],
  ["costPerVerified", "c/ver$"],
  ["avgTok", "tok"],
];

function ljust(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}
function rjust(s: string, w: number): string {
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

function numStr(v: unknown, col: string): string {
  if (v === null || v === undefined) return "-";
  if (typeof v === "number") return FLOAT_COLS.has(col) ? pyFloatStr(v) : String(v);
  return String(v);
}

function renderTable(title: string, rows: readonly AggRow[], cols: ReadonlyArray<[string, string]>): string[] {
  const out: string[] = [title];
  const hdr = cols.map(([c, h]) => (LABEL_COLS.has(c) ? ljust(h, 12) : rjust(h, 9))).join("");
  out.push(hdr);
  out.push("-".repeat(hdr.length));
  for (const r of rows) {
    let line = "";
    for (const [c] of cols) {
      const v = r[c];
      if (LABEL_COLS.has(c)) line += ljust(String(v), 12);
      else line += rjust(numStr(v, c), 9);
    }
    out.push(line);
  }
  out.push("");
  return out;
}

export function render(s: Summary): string {
  const t = s.totals;
  const out: string[] = [];
  out.push(
    `== TELEMETRY == runs=${t.runs} guards=${t.guards} cost=$${pyFloatStr(t.totalCost)} verified=${t.verified} ` +
      `cost/verified=${t.costPerVerified !== null ? "$" + pyFloatStr(t.costPerVerified) : "n/a"}`,
  );
  out.push("");
  out.push(...renderTable("-- perf + consumption (backend x stage) --", s.perf, [["backend", "backend"], ["stage", "stage"], ...METRIC_COLS]));
  out.push(...renderTable("-- by model --", s.byModel, [["model", "model"], ...METRIC_COLS]));
  out.push("-- outcomes --");
  out.push("  " + Object.entries(s.outcomes).map(([k, v]) => `${k}=${v}`).join("  "));
  out.push("");
  out.push("-- quality/safety: guard-firings (куда харденить) --");
  if (Object.keys(s.guardByEvent).length) {
    for (const [ev, n] of Object.entries(s.guardByEvent)) out.push(`  ${ljust(ev, 20)}${rjust(String(n), 5)}`);
    out.push("  -- by backend x event --");
    for (const [k, n] of Object.entries(s.guardByBackendEvent)) out.push(`  ${ljust(k, 28)}${rjust(String(n), 5)}`);
  } else {
    out.push("  (нет срабатываний рельсов — чисто)");
  }
  out.push("");

  const e = s.errors;
  out.push("-- errors: failed runs by class (причина фейла) --");
  if (Object.keys(e.byClass).length) {
    for (const [cls, n] of Object.entries(e.byClass)) {
      const smp = e.samples[cls] ?? "";
      out.push(`  ${ljust(cls, 18)}${rjust(String(n), 5)}   ${smp}`);
    }
    out.push("  -- by backend x class --");
    for (const [k, n] of Object.entries(e.byBackendClass)) out.push(`  ${ljust(k, 28)}${rjust(String(n), 5)}`);
  } else {
    out.push("  (нет фейлов с errClass)");
  }
  out.push("");
  out.push("-- request-errors in stream (тихие, при любом outcome — «работает, но ошибки запроса») --");
  if (e.reqErrTotal) {
    out.push(`  total=${e.reqErrTotal}  runs_affected=${e.reqErrRuns}`);
    for (const [cls, n] of Object.entries(e.reqErrByClass)) out.push(`    ${ljust(cls, 18)}${rjust(String(n), 5)}`);
  } else {
    out.push("  (чисто — request-ошибок в потоке не зафиксировано)");
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// CSV export + drill-down
// ---------------------------------------------------------------------------

export const CSV_COLS = [
  "ts", "tool", "tid", "stage", "capability", "backend", "backendSrc", "model",
  "agent", "outcome", "errClass", "errMsg", "errCode", "reqErrors", "reqErrClasses",
  "gate", "bounces", "criticBlocking", "criticMinor",
  "zoneViolations", "testCmd", "frCovered", "frTotal", "filesChanged", "durationMs",
  "worker.costUsd", "worker.totalTok", "worker.inputTok", "worker.outputTok",
  "worker.durationMs", "worker.sessionId", "commit",
];

function csvField(v: unknown): string {
  const s = v === undefined || v === null ? "" : String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** CSV text (Python `csv.writer` default dialect: `\r\n` row terminator, quote-on-demand). */
export function exportCsv(runs: readonly Row[]): string {
  const lines: string[] = [CSV_COLS.map(csvField).join(",")];
  for (const r of runs) {
    const row = CSV_COLS.map((c) => {
      if (c.startsWith("worker.")) {
        const wk = (r.worker as Row) || {};
        return csvField(wk[c.slice("worker.".length)]);
      }
      return csvField(r[c]);
    });
    lines.push(row.join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

export function drill(tid: string, runs: readonly Row[], guards: readonly Row[]): string {
  const rows: Array<Row & { _k: "run" | "guard" }> = [
    ...runs.filter((r) => r.tid === tid).map((r) => ({ ...r, _k: "run" as const })),
    ...guards.filter((g) => g.tid === tid).map((g) => ({ ...g, _k: "guard" as const })),
  ];
  rows.sort((a, b) => String(a.ts ?? "").localeCompare(String(b.ts ?? "")));
  if (!rows.length) return `нет строк для tid=${tid}`;
  const out = [`== tid=${tid} (${rows.length} строк) ==`];
  for (const x of rows) {
    if (x._k === "run") {
      const w = (x.worker as Row) || {};
      const errbit = x.errClass ? ` ERR[${x.errClass}]=${x.errMsg ?? ""}` : "";
      const reqbit = x.reqErrors ? ` req-err=${x.reqErrors}(${x.reqErrClasses ?? ""})` : "";
      out.push(
        `  [run]   ${String(x.ts ?? "").slice(0, 19)} ${x.tool}/${x.backend} → ${x.outcome} dur=${x.durationMs}ms ` +
          `cost=$${w.costUsd ?? "?"} commit=${x.commit ?? "-"}${errbit}${reqbit}`,
      );
    } else {
      const ec = x.errClass ? ` [${x.errClass}]` : "";
      out.push(`  [guard] ${String(x.ts ?? "").slice(0, 19)} ${x.event}${ec}: ${x.detail ?? ""}`);
    }
  }
  return out.join("\n");
}
