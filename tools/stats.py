#!/usr/bin/env python3
"""stats — ридер telemetry.ndjson по 3 осям (perf / consumption / quality-safety).

Источник: ~/.omp/agent/telemetry.ndjson (глобал, дефолт) или --path FILE (проектный
<repo>/.workflow/telemetry.ndjson). Строки двух видов: kind=run (per stage-run) и
kind=guard (per срабатывание рельса). Формат пишут .omp/tools/_lib/telemetry.ts.

Прогон:  python tools/stats.py            # глобал
         python tools/stats.py --path .workflow/telemetry.ndjson
         python tools/stats.py --json     # сырые агрегаты
"""
from __future__ import annotations
import argparse
import csv
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

try:  # Windows-консоль дефолтит cp1251 → non-ascii вывод падает; форсим utf-8.
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def load(path: Path) -> tuple[list[dict], list[dict]]:
    runs, guards = [], []
    if not path.exists():
        return runs, guards
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
        except json.JSONDecodeError:
            continue
        (guards if o.get("kind") == "guard" else runs).append(o)
    return runs, guards


def _avg(xs: list[float]) -> float:
    return sum(xs) / len(xs) if xs else 0.0


def _verified(r: dict) -> bool:
    if r.get("outcome") != "committed":
        return False
    if r.get("testCmd") == "red":
        return False
    ft, fc = r.get("frTotal"), r.get("frCovered")
    if isinstance(ft, int) and isinstance(fc, int) and fc < ft:
        return False
    return True


def _wnum(r: dict, key: str) -> float | None:
    w = r.get("worker")
    if isinstance(w, dict) and isinstance(w.get(key), (int, float)):
        return w[key]
    return None


def _agg(label: dict, rs: list[dict]) -> dict:
    durs = [r["durationMs"] for r in rs if isinstance(r.get("durationMs"), (int, float))]
    wdurs = [v for r in rs if (v := _wnum(r, "durationMs")) is not None]
    bounces = [r["bounces"] for r in rs if isinstance(r.get("bounces"), int)]
    ok = sum(1 for r in rs if r.get("outcome") == "committed")
    ver = sum(1 for r in rs if _verified(r))
    costs = [v for r in rs if (v := _wnum(r, "costUsd")) is not None]
    toks = [v for r in rs if (v := _wnum(r, "totalTok")) is not None]
    return {**label, "runs": len(rs),
            "ok": ok, "okPct": round(100 * ok / len(rs)) if rs else 0,
            "verified": ver, "verPct": round(100 * ver / len(rs)) if rs else 0,
            "avgStageMs": round(_avg(durs)), "avgWorkerMs": round(_avg(wdurs)),
            "avgBounces": round(_avg(bounces), 2),
            "totalCost": round(sum(costs), 4), "avgCost": round(_avg(costs), 4),
            "avgTok": round(_avg(toks)),
            "costPerVerified": round(sum(costs) / ver, 4) if ver else None}


def _group(runs: list[dict], keyfn) -> dict:
    d: dict = defaultdict(list)
    for r in runs:
        d[keyfn(r)].append(r)
    return d


def summarize(runs: list[dict], guards: list[dict]) -> dict:
    perf = [_agg({"backend": b, "stage": s}, rs) for (b, s), rs
            in sorted(_group(runs, lambda r: (r.get("backend") or "?", r.get("stage") or "?")).items())]
    by_model = [_agg({"model": m}, rs) for m, rs
                in sorted(_group(runs, lambda r: r.get("model") or "?").items())]

    # outcome-распределение
    outcomes: dict[str, int] = defaultdict(int)
    for r in runs:
        outcomes[r.get("outcome") or "?"] += 1

    # guard-топ: по event, и по backend×event
    g_event: dict[str, int] = defaultdict(int)
    g_be: dict[tuple[str, str], int] = defaultdict(int)
    for g in guards:
        g_event[g.get("event") or "?"] += 1
        g_be[(g.get("backend") or "?", g.get("event") or "?")] += 1

    # ошибки (task-4): классификация фейлов + «тихие» request-ошибки в потоке.
    err_class: dict[str, int] = defaultdict(int)          # runs с outcome=*error* по errClass
    err_be: dict[tuple[str, str], int] = defaultdict(int)  # backend×errClass
    err_samples: dict[str, str] = {}                       # пример errMsg на класс
    req_total = 0                                          # сумма reqErrors по всем runs
    req_runs = 0                                           # сколько runs имели ≥1 request-error
    req_by_class: dict[str, int] = defaultdict(int)        # request-ошибки по классу
    for r in runs:
        ec = r.get("errClass")
        if ec:
            err_class[ec] += 1
            err_be[(r.get("backend") or "?", ec)] += 1
            if ec not in err_samples and r.get("errMsg"):
                err_samples[ec] = str(r.get("errMsg"))[:80]
        re_n = r.get("reqErrors")
        if isinstance(re_n, int) and re_n > 0:
            req_total += re_n
            req_runs += 1
            for c in str(r.get("reqErrClasses") or "").split(","):
                if c.strip():
                    req_by_class[c.strip()] += re_n

    total_cost = round(sum(p["totalCost"] for p in perf), 4)
    total_ver = sum(p["verified"] for p in perf)
    return {
        "totals": {"runs": len(runs), "guards": len(guards), "totalCost": total_cost,
                   "verified": total_ver,
                   "costPerVerified": round(total_cost / total_ver, 4) if total_ver else None},
        "perf": perf,
        "byModel": by_model,
        "outcomes": dict(sorted(outcomes.items(), key=lambda x: -x[1])),
        "guardByEvent": dict(sorted(g_event.items(), key=lambda x: -x[1])),
        "guardByBackendEvent": {f"{b}/{e}": n for (b, e), n in sorted(g_be.items(), key=lambda x: -x[1])},
        "errors": {
            "byClass": dict(sorted(err_class.items(), key=lambda x: -x[1])),
            "byBackendClass": {f"{b}/{c}": n for (b, c), n in sorted(err_be.items(), key=lambda x: -x[1])},
            "samples": err_samples,
            "reqErrTotal": req_total,
            "reqErrRuns": req_runs,
            "reqErrByClass": dict(sorted(req_by_class.items(), key=lambda x: -x[1])),
        },
    }


def render(s: dict) -> str:
    t = s["totals"]
    out = []
    out.append(f"== TELEMETRY == runs={t['runs']} guards={t['guards']} "
               f"cost=${t['totalCost']} verified={t['verified']} "
               f"cost/verified={'$' + str(t['costPerVerified']) if t['costPerVerified'] is not None else 'n/a'}")
    out.append("")
    def table(title: str, rows: list[dict], cols: list[tuple[str, str]]):
        out.append(title)
        hdr = "".join(f"{h:<12}" if i < len(cols) - 0 and c in ("backend", "stage", "model")
                      else f"{h:>9}" for i, (c, h) in enumerate(cols))
        out.append(hdr)
        out.append("-" * len(hdr))
        for p in rows:
            line = ""
            for c, _ in cols:
                v = p.get(c)
                if c in ("backend", "stage", "model"):
                    line += f"{str(v):<12}"
                elif c == "costPerVerified":
                    line += f"{v if v is not None else '-':>9}"
                else:
                    line += f"{v:>9}"
            out.append(line)
        out.append("")

    metric_cols = [("runs", "runs"), ("okPct", "ok%"), ("verPct", "ver%"),
                   ("avgStageMs", "stageMs"), ("avgWorkerMs", "wrkMs"), ("avgBounces", "bounce"),
                   ("totalCost", "cost$"), ("costPerVerified", "c/ver$"), ("avgTok", "tok")]
    table("-- perf + consumption (backend x stage) --", s["perf"], [("backend", "backend"), ("stage", "stage")] + metric_cols)
    table("-- by model --", s["byModel"], [("model", "model")] + metric_cols)
    out.append("-- outcomes --")
    out.append("  " + "  ".join(f"{k}={v}" for k, v in s["outcomes"].items()) or "  (none)")
    out.append("")
    out.append("-- quality/safety: guard-firings (куда харденить) --")
    if s["guardByEvent"]:
        for ev, n in s["guardByEvent"].items():
            out.append(f"  {ev:<20}{n:>5}")
        out.append("  -- by backend x event --")
        for k, n in s["guardByBackendEvent"].items():
            out.append(f"  {k:<28}{n:>5}")
    else:
        out.append("  (нет срабатываний рельсов — чисто)")
    out.append("")

    # -- errors (task-4): классификация фейлов + request-ошибки причина/тренд --
    e = s["errors"]
    out.append("-- errors: failed runs by class (причина фейла) --")
    if e["byClass"]:
        for cls, n in e["byClass"].items():
            smp = e["samples"].get(cls, "")
            out.append(f"  {cls:<18}{n:>5}   {smp}")
        out.append("  -- by backend x class --")
        for k, n in e["byBackendClass"].items():
            out.append(f"  {k:<28}{n:>5}")
    else:
        out.append("  (нет фейлов с errClass)")
    out.append("")
    out.append("-- request-errors in stream (тихие, при любом outcome — «работает, но ошибки запроса») --")
    if e["reqErrTotal"]:
        out.append(f"  total={e['reqErrTotal']}  runs_affected={e['reqErrRuns']}")
        for cls, n in e["reqErrByClass"].items():
            out.append(f"    {cls:<18}{n:>5}")
    else:
        out.append("  (чисто — request-ошибок в потоке не зафиксировано)")
    return "\n".join(out)


CSV_COLS = ["ts", "tool", "tid", "stage", "capability", "backend", "backendSrc", "model",
            "agent", "outcome", "errClass", "errMsg", "errCode", "reqErrors", "reqErrClasses",
            "gate", "bounces", "criticBlocking", "criticMinor",
            "zoneViolations", "testCmd", "frCovered", "frTotal", "filesChanged", "durationMs",
            "worker.costUsd", "worker.totalTok", "worker.inputTok", "worker.outputTok",
            "worker.durationMs", "worker.sessionId", "commit"]


def export_csv(runs: list[dict], path: Path) -> None:
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(CSV_COLS)
        for r in runs:
            row = []
            for c in CSV_COLS:
                if c.startswith("worker."):
                    wk = r.get("worker") or {}
                    row.append(wk.get(c.split(".", 1)[1], ""))
                else:
                    row.append(r.get(c, ""))
            w.writerow(row)


def drill(tid: str, runs: list[dict], guards: list[dict]) -> str:
    rows = sorted([*[{**r, "_k": "run"} for r in runs if r.get("tid") == tid],
                   *[{**g, "_k": "guard"} for g in guards if g.get("tid") == tid]],
                  key=lambda x: x.get("ts", ""))
    if not rows:
        return f"нет строк для tid={tid}"
    out = [f"== tid={tid} ({len(rows)} строк) =="]
    for x in rows:
        if x["_k"] == "run":
            w = x.get("worker") or {}
            errbit = f" ERR[{x.get('errClass')}]={x.get('errMsg','')}" if x.get("errClass") else ""
            reqbit = f" req-err={x.get('reqErrors')}({x.get('reqErrClasses','')})" if x.get("reqErrors") else ""
            out.append(f"  [run]   {x.get('ts','')[:19]} {x.get('tool')}/{x.get('backend')} "
                       f"→ {x.get('outcome')} dur={x.get('durationMs')}ms cost=${w.get('costUsd','?')} commit={x.get('commit','-')}{errbit}{reqbit}")
        else:
            ec = f" [{x.get('errClass')}]" if x.get("errClass") else ""
            out.append(f"  [guard] {x.get('ts','')[:19]} {x.get('event')}{ec}: {x.get('detail','')}")
    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description="telemetry reader (3 оси)")
    default = Path.home() / ".omp" / "agent" / "telemetry.ndjson"
    ap.add_argument("--path", type=Path, default=default, help=f"NDJSON (дефолт {default})")
    ap.add_argument("--json", action="store_true", help="сырые агрегаты JSON")
    ap.add_argument("--csv", type=Path, help="экспорт run-строк в CSV (под внешний анализ)")
    ap.add_argument("--tid", help="drill-down: все run+guard строки одной задачи")
    args = ap.parse_args()

    runs, guards = load(args.path)
    if not runs and not guards:
        print(f"нет данных: {args.path}", file=sys.stderr)
        return 1
    if args.csv:
        export_csv(runs, args.csv)
        print(f"CSV: {len(runs)} run-строк → {args.csv}")
        return 0
    if args.tid:
        print(drill(args.tid, runs, guards))
        return 0
    s = summarize(runs, guards)
    if args.json:
        print(json.dumps(s, ensure_ascii=False, indent=2))
    else:
        print(render(s))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
