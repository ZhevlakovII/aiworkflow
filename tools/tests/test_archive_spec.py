#!/usr/bin/env python3
"""B.2a regression: deterministic archive-merge (delta->canonical living spec).
Runs archive_spec.py twice into a temp canon and asserts add/skip/collision behavior
+ provenance injection. Model-reconcile (--reconcile, B.2b) not covered here.

Run: python tools/tests/test_archive_spec.py   (repo root as cwd)
Exit: 0 = pass, 1 = fail.
"""
from __future__ import annotations
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FX = ROOT / "tools/tests/archive"


def run(change: str, canon_dir: Path) -> tuple[int, str]:
    r = subprocess.run(
        [sys.executable, "tools/archive_spec.py", "--change", str(FX / change),
         "--spec-dir", str(canon_dir), "--capability", "theme"],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
    )
    return r.returncode, r.stdout


def main() -> int:
    ok = True
    with tempfile.TemporaryDirectory() as td:
        canon_dir = Path(td)
        # A: empty canon -> ADD 2, exit 0
        codeA, outA = run("changeA-spec.md", canon_dir)
        if not (codeA == 0 and "ADD:2" in outA and "COLLISION:0" in outA):
            print(f"  FAIL [A]: expected exit0 ADD:2 COLLISION:0\n{outA}")
            ok = False
        else:
            print("  OK [A]: ADD:2, exit 0")
        # B: SKIP FR-y (same), COLLISION SP-x (diff), ADD FR-z (new), exit 1
        codeB, outB = run("changeB-spec.md", canon_dir)
        checks = [
            ("exit 1", codeB == 1),
            ("ADD:1", "ADD:1" in outB),
            ("SKIP:1", "SKIP:1" in outB),
            ("COLLISION:1", "COLLISION:1" in outB),
            ("SP-x collision", "! SP-x" in outB),
            ("FR-z added", "+ FR-z" in outB),
        ]
        for label, cond in checks:
            if not cond:
                print(f"  FAIL [B]: {label}\n{outB}")
                ok = False
        if all(c for _, c in checks):
            print("  OK [B]: SKIP:1 COLLISION:1 ADD:1, exit 1")
        # provenance: canon carries from: for both changes; collision kept OLD statement
        canon = (canon_dir / "theme.md").read_text(encoding="utf-8")
        prov = [
            ("from: changeA", "from: changeA" in canon),
            ("from: changeB", "from: changeB" in canon),
            ("collision kept old", "single source of truth" in canon and "cache mirror" not in canon),
        ]
        for label, cond in prov:
            if not cond:
                print(f"  FAIL [canon]: {label}")
                ok = False
        if all(c for _, c in prov):
            print("  OK [canon]: provenance from:, collision kept old statement")
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
