#!/usr/bin/env python3
"""B.2b #4c regression: deterministic parts of cross-ID semantic dedupe (buildDedupePrompt +
applyDedupe in _lib/archivespec.ts). The claude call itself is validated live (harness);
here we lock the pure logic: prompt lists blocks, apply drops flagged pairs, bad/empty input is safe.

Run: python tools/tests/test_dedupe_unit.py   (repo root as cwd)
Exit: 0 = pass, 1 = fail.
"""
from __future__ import annotations
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

TS = r'''
import { applyDedupe, buildDedupePrompt } from "./.omp/tools/_lib/archivespec.ts";
const canon = [
  {kind:"fr", body:"id: FR-a\nstatement: X"},
  {kind:"fr", body:"id: FR-b\nstatement: Y"},
  {kind:"fr", body:"id: FR-c\nstatement: Z"},
];
const out = {
  promptListsAll: buildDedupePrompt(canon).includes("[0] id=FR-a") && buildDedupePrompt(canon).includes("[2] id=FR-c"),
  dropOne: (() => { const d = applyDedupe(canon, "```json\n[{\"keep\":0,\"drop\":1,\"reason\":\"dup\"}]\n```");
    return d.canon.map(b=>b.body.match(/id: (\S+)/)[1]).join(",") === "FR-a,FR-c" && d.notes.length === 1; })(),
  badJsonSafe: applyDedupe(canon, "garbage").canon.length === 3,
  emptySafe: (() => { const d = applyDedupe(canon, "[]"); return d.canon.length === 3 && d.notes.length === 0; })(),
  outOfRangeSafe: applyDedupe(canon, "[{\"keep\":0,\"drop\":9,\"reason\":\"x\"}]").canon.length === 3,
};
console.log(JSON.stringify(out));
'''


def main() -> int:
    r = subprocess.run(["node", "--experimental-strip-types", "-e", TS],
                       cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
    line = [ln for ln in r.stdout.splitlines() if ln.strip().startswith("{")]
    if not line:
        print(f"  FAIL: no TS output\n{r.stdout}\n{r.stderr}"); print("FAIL"); return 1
    d = json.loads(line[-1])
    ok = True
    for k in ("promptListsAll", "dropOne", "badJsonSafe", "emptySafe", "outOfRangeSafe"):
        if not d.get(k):
            print(f"  FAIL: {k}")
            ok = False
        else:
            print(f"  OK: {k}")
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
