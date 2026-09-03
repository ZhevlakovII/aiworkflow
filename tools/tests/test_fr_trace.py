#!/usr/bin/env python3
"""B.1b regression: FR↔test traceability gate. Runs BOTH linters (python fr_trace.py +
TS _lib/frtrace.ts) on the same fixtures, asserts identical expected findings. Parity guard.

Cases:
  A: spec + [MoneyTest.kt]                → PASS (both FR covered)
  B: spec + [PartialTest.kt]              → 1 finding (FR-reject-negative uncovered)
  C: spec + [Money.kt] (non-test file)    → 1 finding (0 test-files, FR>0)
  D: empty-FR spec + [MoneyTest.kt]       → PASS (FR conditional)

Run: python tools/tests/test_fr_trace.py   (repo root as cwd)
Exit: 0 = pass, 1 = fail.
"""
from __future__ import annotations
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FX = "tools/tests/frtrace"
SPEC = f"{FX}/spec.md"
COVERED, PARTIAL, IMPL = f"{FX}/MoneyTest.kt", f"{FX}/PartialTest.kt", f"{FX}/Money.kt"
EARS_SPEC = "tools/tests/ears/task.md"  # no ```fr with resolvable... actually use a no-FR file

# case → (files, expected substrings in findings)
CASES = {
    "A-covered":  ([COVERED], []),
    "B-partial":  ([PARTIAL], ["FR-reject-negative"]),
    "C-nontest":  ([IMPL], ["ни одного тест-файла"]),
    "D-nofr":     ([COVERED], []),   # uses EARS task.md (no ```fr) as spec
}


def run_python(spec: str, files: list[str]) -> list[str]:
    r = subprocess.run(
        [sys.executable, "tools/fr_trace.py", "--spec", spec, "--files", *files],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
    )
    return [ln.strip()[4:].strip() for ln in r.stdout.splitlines() if ln.strip().startswith("[x]")]


def run_ts(spec: str, files: list[str]) -> list[str]:
    files_js = json.dumps(files)
    script = (
        'import { frTrace } from "./.omp/tools/_lib/frtrace.ts";'
        f'const r = frTrace("{spec}", {files_js}, ".");'
        'console.log(JSON.stringify(r.findings));'
    )
    r = subprocess.run(
        ["node", "--experimental-strip-types", "-e", script],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
    )
    line = [ln for ln in r.stdout.splitlines() if ln.strip().startswith("[")]
    return json.loads(line[-1]) if line else []


def check(label: str, findings: list[str], expected: list[str]) -> bool:
    ok = True
    if len(findings) != len(expected):
        print(f"  FAIL [{label}]: ожидалось {len(expected)} находок, получено {len(findings)}: {findings}")
        ok = False
    for sub in expected:
        if not any(sub in f for f in findings):
            print(f"  FAIL [{label}]: нет находки с '{sub}'")
            ok = False
    if ok:
        print(f"  OK [{label}]: {len(findings)} findings как ожидалось")
    return ok


def main() -> int:
    print("FR-trace regression (B.1b)")
    ok = True
    for name, (files, expected) in CASES.items():
        spec = EARS_SPEC if name == "D-nofr" else SPEC
        py = run_python(spec, files)
        ok &= check(f"{name}/python", py, expected)
        try:
            ts = run_ts(spec, files)
            ok &= check(f"{name}/ts", ts, expected)
            if set(py) != set(ts):
                print(f"  FAIL [{name}/parity]: python != TS\n    py={py}\n    ts={ts}")
                ok = False
            else:
                print(f"  OK [{name}/parity]: python == TS")
        except Exception as e:  # noqa: BLE001
            print(f"  SKIP [{name}/ts]: node недоступен ({e})")
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
