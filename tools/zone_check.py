#!/usr/bin/env python3
"""
zone_check.py — детерминированный zone-линт (P3b).

Реальная зонная граница воркера — проверка его ИЗМЕНЕНИЙ против allow/deny зоны
(на merge/после isolated-run), а не мид-воркер хук (bash обходит). Код не рационализирует.

Каждый изменённый путь: должен матчить ≥1 allow-glob И ни один deny-glob. Иначе VIOLATION.

Пути: из stdin (по одному на строку) ИЛИ `--from-git <base>` (git diff --name-only base).
Globs: gitignore-подобные — `**` (любые сегменты), `*` (в пределах сегмента), `?`.

Usage:
  git diff --name-only HEAD | python tools/zone_check.py --allow "sandbox/**" --deny ".git/**,.omp/**"
  python tools/zone_check.py --from-git HEAD --allow "src/auth/**,tests/auth/**"
Exit: 0 = чисто; 1 = violations; 2 = ошибка.
"""
from __future__ import annotations
import argparse
import re
import subprocess
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
except Exception:
    pass


def glob_to_re(glob: str) -> re.Pattern:
    g = glob.strip().replace("\\", "/")
    out = ["^"]
    i = 0
    while i < len(g):
        c = g[i]
        if c == "*":
            if g[i:i + 2] == "**":
                out.append(".*")
                i += 2
                if i < len(g) and g[i] == "/":
                    i += 1  # `**/` съедает и слэш
                continue
            out.append("[^/]*")
        elif c == "?":
            out.append("[^/]")
        else:
            out.append(re.escape(c))
        i += 1
    out.append("$")
    return re.compile("".join(out))


def norm(p: str) -> str:
    p = p.strip().replace("\\", "/")
    while p.startswith("./"):
        p = p[2:]
    return p


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--allow", default="", help="comma-separated allow globs")
    ap.add_argument("--deny", default="", help="comma-separated deny globs")
    ap.add_argument("--from-git", default=None, help="base ref → git diff --name-only <ref>")
    ap.add_argument("--staged", action="store_true", help="staged set → git diff --cached --name-only (видит новые файлы)")
    args = ap.parse_args()

    allow = [glob_to_re(x) for x in args.allow.split(",") if x.strip()]
    deny = [glob_to_re(x) for x in args.deny.split(",") if x.strip()]
    if not allow:
        print("ERROR: пустой --allow (зона обязательна)", file=sys.stderr)
        return 2

    if args.staged:
        res = subprocess.run(["git", "diff", "--cached", "--name-only"],
                             text=True, capture_output=True)
        if res.returncode != 0:
            sys.stderr.write(res.stderr)
            return 2
        paths = res.stdout.splitlines()
    elif args.from_git:
        res = subprocess.run(["git", "diff", "--name-only", args.from_git],
                             text=True, capture_output=True)
        if res.returncode != 0:
            sys.stderr.write(res.stderr)
            return 2
        paths = res.stdout.splitlines()
    else:
        paths = sys.stdin.read().splitlines()

    paths = [norm(p) for p in paths if p.strip()]
    violations: list[str] = []
    for p in paths:
        if any(d.match(p) for d in deny):
            violations.append(f"{p}: matches deny-zone")
        elif not any(a.match(p) for a in allow):
            violations.append(f"{p}: вне allow-zone")

    print(f"paths: {len(paths)} | violations: {len(violations)}")
    for v in violations:
        print("  [x] " + v)
    if violations:
        print("ZONE: VIOLATION")
        return 1
    print("ZONE: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
