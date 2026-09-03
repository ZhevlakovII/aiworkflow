#!/usr/bin/env python3
"""B.1a regression: EARS FR gate-lint (Gate-3). Runs BOTH linters (python + TS) on the
same fixtures and asserts identical, expected findings. Parity guard for gate_lint.py
<-> _lib/gatelint.ts.

Run: python tools/tests/test_ears_gate.py   (repo root as cwd)
Exit: 0 = pass, 1 = fail.
"""
from __future__ import annotations
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FX = "tools/tests/ears"
TASK, SPEC, ADR = f"{FX}/task.md", f"{FX}/spec.md", f"{FX}/adr.md"

# 4 broken FR expected; 3 valid FR + SP/AD clean. Match on (id, substring).
EXPECT = [
    ("FR-bad-noshall", 'нет "SHALL"'),
    ("FR-bad-emptytrigger", "пустой trigger"),
    ("FR-bad-pattern", "неизвестный pattern"),
    ("FR-bad-source", "L999"),
]


def assert_findings(label: str, findings: list[str]) -> bool:
    ok = True
    if len(findings) != len(EXPECT):
        print(f"  FAIL [{label}]: ожидалось {len(EXPECT)} находок, получено {len(findings)}")
        for f in findings:
            print("    - " + f)
        ok = False
    for fid, sub in EXPECT:
        if not any(fid in f and sub in f for f in findings):
            print(f"  FAIL [{label}]: нет находки {fid} со '{sub}'")
            ok = False
    if ok:
        print(f"  OK [{label}]: {len(findings)} findings как ожидалось")
    return ok


def run_python() -> list[str]:
    r = subprocess.run(
        [sys.executable, "tools/gate_lint.py", "--task", TASK, "--spec", SPEC, "--adr", ADR],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
    )
    return [ln.strip()[4:].strip() for ln in r.stdout.splitlines() if ln.strip().startswith("[x]")]


def run_ts() -> list[str]:
    script = (
        'import { gateLint } from "./.omp/tools/_lib/gatelint.ts";'
        'const g = gateLint("%s","%s","%s",".");'
        'console.log(JSON.stringify(g.findings));' % (TASK, SPEC, ADR)
    )
    r = subprocess.run(
        ["node", "--experimental-strip-types", "-e", script],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
    )
    line = [ln for ln in r.stdout.splitlines() if ln.strip().startswith("[")]
    return json.loads(line[-1]) if line else []


def main() -> int:
    print("EARS gate-lint regression (B.1a)")
    py = run_python()
    ok = assert_findings("python", py)
    try:
        ts = run_ts()
        ok &= assert_findings("ts", ts)
        # паритет семантический: python repr даёт '...', TS JSON.stringify — "..." → нормализуем кавычки
        norm = lambda xs: {f.replace("'", "\"") for f in xs}
        if norm(py) != norm(ts):
            print("  FAIL: python/TS findings расходятся (parity)")
            for f in sorted(norm(py) ^ norm(ts)):
                print("    ~ " + f)
            ok = False
        else:
            print("  OK [parity]: python == TS (кавычки нормализованы)")
    except Exception as e:  # noqa: BLE001 — node может быть недоступен в CI
        print(f"  SKIP [ts]: node недоступен ({e})")
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
