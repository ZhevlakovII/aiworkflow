#!/usr/bin/env python3
"""B.2b parity: TS archivespec.ts merge == python archive_spec.py semantics.
Runs the deterministic ID-merge (no reconcile/dedupe — those need claude) in TS over the
same fixtures and asserts identical ADD/SKIP/COLLISION + provenance as the python regression.

Run: python tools/tests/test_archive_parity.py   (repo root as cwd)
Exit: 0 = pass, 1 = fail.
"""
from __future__ import annotations
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FX = "tools/tests/archive"

# TS: merge A into empty canon, then B into that canon. Emit counts + canon of each step.
TS = r'''
import { readFileSync } from "node:fs";
import { mergeCanon, parseBlocksRaw, emitCanon } from "./.omp/tools/_lib/archivespec.ts";
const fxA = readFileSync("%s/changeA-spec.md","utf8");
const fxB = readFileSync("%s/changeB-spec.md","utf8");
const mA = mergeCanon(parseBlocksRaw(fxA), "", "changeA");
const canonA = emitCanon("theme", mA.canon);
const mB = mergeCanon(parseBlocksRaw(fxB), canonA, "changeB");
const canonB = emitCanon("theme", mB.canon);
console.log(JSON.stringify({
  A: {add: mA.added.length, skip: mA.skipped.length, coll: mA.collisions.length},
  B: {add: mB.added.length, skip: mB.skipped.length, coll: mB.collisions.length, collIds: mB.collisions, addIds: mB.added},
  canonB,
}));
''' % (FX, FX)


def main() -> int:
    r = subprocess.run(["node", "--experimental-strip-types", "-e", TS],
                       cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
    line = [ln for ln in r.stdout.splitlines() if ln.strip().startswith("{")]
    if not line:
        print(f"  FAIL: no TS output\nstdout={r.stdout}\nstderr={r.stderr}")
        print("FAIL"); return 1
    d = json.loads(line[-1])
    ok = True
    checks = [
        ("A ADD:2", d["A"]["add"] == 2 and d["A"]["coll"] == 0),
        ("B ADD:1", d["B"]["add"] == 1),
        ("B SKIP:1", d["B"]["skip"] == 1),
        ("B COLLISION:1", d["B"]["coll"] == 1),
        ("B collision=SP-x", d["B"]["collIds"] == ["SP-x"]),
        ("B added=FR-z", d["B"]["addIds"] == ["FR-z"]),
        ("prov from:changeA", "from: changeA" in d["canonB"]),
        ("prov from:changeB", "from: changeB" in d["canonB"]),
        ("collision kept old", "single source of truth" in d["canonB"] and "cache mirror" not in d["canonB"]),
    ]
    for label, cond in checks:
        if not cond:
            print(f"  FAIL [ts]: {label}")
            ok = False
    if ok:
        print("  OK [ts]: merge parity (ADD/SKIP/COLLISION + provenance + kept-old) == python")
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
