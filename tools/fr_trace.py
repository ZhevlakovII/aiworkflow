#!/usr/bin/env python3
"""
fr_trace.py — детерминир. FR↔test traceability-гейт (P9 B.1b). Parity-эталон для
.omp/tools/_lib/frtrace.ts (рантайм-путь — TS в execute_worker).

Каждый FR-* из change-spec ДОЛЖЕН упоминаться (FR-id как токен) в ≥1 staged тест-файле.
Enforcement > инструкция: execute_worker велит воркеру покрыть FR тестом, но гарантирует ЭТОТ гейт.
FR УСЛОВЕН (как B.1a): 0 FR → PASS. Механика (id-токен), не семантика («тот ли тест») — та на critic.

Usage:
  python tools/fr_trace.py --spec docs/design/<id>-spec.md --files a_test.kt b.kt ...
  python tools/fr_trace.py --spec <spec> --staged        # тест-файлы из git staged
Exit: 0 = PASS (все FR трассируются / 0 FR), 1 = найдены непокрытые FR, 2 = ошибка ввода.
"""
from __future__ import annotations
import argparse
import re
import subprocess
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
except Exception:
    pass

FR_ID_RE = re.compile(r"```fr\s*\n(.*?)```", re.DOTALL)
ID_LINE_RE = re.compile(r"^\s*id:\s*(\S+)", re.MULTILINE)
TEST_BASENAME_RE = re.compile(r"(^test[_.]|[._-]?test[s]?[._]|spec[._]|[._]spec\.|Test\.|Tests\.)", re.IGNORECASE)


def fr_ids_from_spec(spec: Path) -> list[str]:
    if not spec.exists():
        return []
    text = spec.read_text(encoding="utf-8")
    ids: list[str] = []
    for m in FR_ID_RE.finditer(text):
        im = ID_LINE_RE.search(m.group(1))
        if im:
            ids.append(im.group(1))
    return ids


def is_test_file(p: str) -> bool:
    return bool(TEST_BASENAME_RE.search(Path(p).name))


def fr_trace(spec: Path, staged: list[str], repo_root: Path) -> tuple[list[str], list[str], list[str], list[str]]:
    """→ (findings, fr_ids, covered, test_files)."""
    fr_ids = fr_ids_from_spec(spec)
    test_files = [f for f in staged if is_test_file(f)]
    if not fr_ids:
        return [], fr_ids, [], test_files
    findings: list[str] = []
    if not test_files:
        findings.append(f"FR-trace: {len(fr_ids)} FR в spec, но ни одного тест-файла в staged (покрой FR тестом)")
    blob = ""
    for f in test_files:
        try:
            blob += (repo_root / f).read_text(encoding="utf-8") + "\n"
        except Exception:  # noqa: BLE001
            pass
    covered: list[str] = []
    for fid in fr_ids:
        if fid in blob:
            covered.append(fid)
        elif test_files:
            findings.append(f"FR-trace: {fid} не упомянут ни в одном тест-файле (не трассируется)")
    return findings, fr_ids, covered, test_files


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", required=True)
    ap.add_argument("--files", nargs="*", default=[])
    ap.add_argument("--staged", action="store_true", help="взять тест-файлы из git staged")
    ap.add_argument("--repo-root", default=".")
    args = ap.parse_args()

    repo_root = Path(args.repo_root).resolve()
    spec = Path(args.spec)
    if not spec.exists():
        print(f"ERROR: spec не найден: {spec}", file=sys.stderr)
        return 2

    staged = list(args.files)
    if args.staged:
        r = subprocess.run(["git", "diff", "--cached", "--name-only"], cwd=str(repo_root),
                           capture_output=True, text=True, encoding="utf-8")
        staged += [ln.strip() for ln in r.stdout.splitlines() if ln.strip()]

    findings, fr_ids, covered, test_files = fr_trace(spec, staged, repo_root)
    print(f"FR: {len(fr_ids)} | covered: {len(covered)} | test-files: {len(test_files)} | findings: {len(findings)}")
    for f in findings:
        print("  [x] " + f)
    if findings:
        print("FR-TRACE: FAIL")
        return 1
    print("FR-TRACE: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
