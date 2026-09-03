#!/usr/bin/env python3
"""omp_stats — ридер telemetry-omp.ndjson (телеметрия САМОГО omp: запросы/lead/тулы/делегация/ошибки/затраты).

Отдельно от stats.py (та — по нашим customTool'ам). Источник пишет хук .omp/hooks/omp-telemetry.ts:
  <cwd>/.workflow/telemetry-omp.ndjson (проектно) или ~/.omp/agent/telemetry-omp.ndjson (глобал).
Записи kind: omp-provider (HTTP-запрос к модели: status), omp-usage (токены/cost), omp-tool
  (тул-исполнение), omp-agent (lifecycle lead/субагентов), omp-error (ошибки, с errClass), omp-event.

Прогон:  python tools/omp_stats.py                                  # глобал
         python tools/omp_stats.py --path .workflow/telemetry-omp.ndjson
         python tools/omp_stats.py --json
"""
from __future__ import annotations
import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def load(path: Path) -> list[dict]:
    rows = []
    if not path.exists():
        return rows
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def summarize(rows: list[dict]) -> dict:
    by_kind: dict[str, int] = defaultdict(int)
    status: dict[str, int] = defaultdict(int)       # provider HTTP-статусы
    err_class: dict[str, int] = defaultdict(int)    # omp-error по errClass
    err_samples: dict[str, str] = {}
    tools: dict[str, int] = defaultdict(int)        # тул-вызовы по имени
    tool_err: dict[str, int] = defaultdict(int)
    agents: dict[str, int] = defaultdict(int)       # agent-события по типу
    events: dict[str, int] = defaultdict(int)
    tok_in = tok_out = tok_total = 0
    cost = 0.0
    durs: list[float] = []
    providers = 0

    for r in rows:
        k = r.get("kind", "?")
        by_kind[k] += 1
        events[r.get("event", "?")] += 1
        # Токены/cost/длительность берём ТОЛЬКО с omp-usage: agent_end несёт те же messages[].usage
        # (агрегат хода) → суммирование по всем kind давало двойной счёт и раздутый avgReqMs.
        if k == "omp-usage":
            u = r.get("usage") or {}
            tok_in += int(u.get("inputTok") or 0)
            tok_out += int(u.get("outputTok") or 0)
            tok_total = max(tok_total, int(u.get("totalTok") or 0))
            cost += float(u.get("cost") or 0)
            if isinstance(u.get("durationMs"), (int, float)):
                durs.append(u["durationMs"])
        if k == "omp-provider" or r.get("status") is not None:
            providers += 1
            st = r.get("status")
            if st is not None:
                status[str(st)] += 1
        # errClass живёт на omp-error (запрос/модель/тул-события) И на omp-tool (фейл исполнения тула).
        # Считаем ОБА в err_class → headline errors= честный, причины видны в errByClass.
        if r.get("errClass"):
            ec = r.get("errClass")
            err_class[ec] += 1
            if ec not in err_samples and r.get("errMsg"):
                err_samples[ec] = str(r.get("errMsg"))[:100]
        if k == "omp-tool":
            tools[str(r.get("tool") or "?")] += 1
            if r.get("errClass"):
                tool_err[str(r.get("tool") or "?")] += 1
        if k == "omp-agent":
            agents[str(r.get("agentType") or r.get("event") or "?")] += 1

    return {
        "totals": {"rows": len(rows), "providerRequests": providers,
                   "tokIn": tok_in, "tokOut": tok_out, "ctxPeak": tok_total,
                   "cost": round(cost, 4), "avgReqMs": round(sum(durs) / len(durs)) if durs else 0,
                   "errors": sum(err_class.values())},
        "byKind": dict(sorted(by_kind.items(), key=lambda x: -x[1])),
        "providerStatus": dict(sorted(status.items())),
        "errByClass": dict(sorted(err_class.items(), key=lambda x: -x[1])),
        "errSamples": err_samples,
        "tools": dict(sorted(tools.items(), key=lambda x: -x[1])),
        "toolErrors": dict(sorted(tool_err.items(), key=lambda x: -x[1])),
        "agents": dict(sorted(agents.items(), key=lambda x: -x[1])),
        "events": dict(sorted(events.items(), key=lambda x: -x[1])),
    }


def render(s: dict) -> str:
    t = s["totals"]
    out = [f"== OMP TELEMETRY == rows={t['rows']} providerReqs={t['providerRequests']} "
           f"tokIn={t['tokIn']} tokOut={t['tokOut']} ctxPeak={t['ctxPeak']} cost=${t['cost']} "
           f"avgReqMs={t['avgReqMs']} errors={t['errors']}", ""]

    def kv(title: str, d: dict, samples: dict | None = None):
        out.append(title)
        if not d:
            out.append("  (нет)")
        for k, v in d.items():
            line = f"  {k:<24}{v:>6}"
            if samples and k in samples:
                line += f"   {samples[k]}"
            out.append(line)
        out.append("")

    kv("-- by kind --", s["byKind"])
    kv("-- provider HTTP status (>=400 = ошибка запроса) --", s["providerStatus"])
    kv("-- errors by class (причина) --", s["errByClass"], s["errSamples"])
    kv("-- tool calls --", s["tools"])
    if s["toolErrors"]:
        kv("-- tool errors --", s["toolErrors"])
    kv("-- agents / delegation --", s["agents"])
    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description="omp-telemetry reader")
    default = Path.home() / ".omp" / "agent" / "telemetry-omp.ndjson"
    ap.add_argument("--path", type=Path, default=default, help=f"NDJSON (дефолт {default})")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    rows = load(args.path)
    if not rows:
        print(f"нет данных: {args.path}", file=sys.stderr)
        return 1
    s = summarize(rows)
    print(json.dumps(s, ensure_ascii=False, indent=2) if args.json else render(s))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
