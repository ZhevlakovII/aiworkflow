#!/usr/bin/env python3
"""audit_commits — bypass-скан: коммиты БЕЗ rail-подписи = потенциальный обход рельса.

Rail-коммиты несут трейлер `[omp-rail:<tool>]` (gated_commit/execute_worker/codex_worker/
design_worker/archive). Коммит без него (и без legacy-паттернов) = НЕ через рельс — в автономном
окне это обход (ось 3 качества/безопасности); в human-репо это нормальные ручные коммиты, читать
с суждением. Осмысленно как `--since <pre-run-HEAD>` вокруг автономного прогона.

Прогон:  python tools/audit_commits.py --since HEAD~20
         python tools/audit_commits.py --repo <path> --since <ref> --emit   # + guard в telemetry
"""
from __future__ import annotations
import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

try:  # Windows-консоль cp1251 → non-ascii (✓/→) падает; форсим utf-8.
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

RAIL = re.compile(r"\[omp-rail:")
LEGACY = re.compile(r"via (execute|codex)_worker|^design\([^)]+\): spec\+ADR locked", re.I)
NUL = "\x00"
REC = "\x1e"  # record sep


def git_log(repo: Path, since: str | None) -> list[tuple[str, str, str, str]]:
    rng = [f"{since}..HEAD"] if since else []
    # %x00/%x1e — git-escape: NUL/RS попадают в ВЫВОД, не в arg (Windows CreateProcess запрещает NUL в args).
    fmt = "%H%x00%an%x00%s%x00%b%x1e"
    out = subprocess.run(
        ["git", "-C", str(repo), "log", f"--format={fmt}", *rng],
        capture_output=True, text=True, encoding="utf-8",
    )
    if out.returncode != 0:
        print(f"git log failed: {out.stderr.strip()}", file=sys.stderr)
        raise SystemExit(2)
    commits = []
    for rec in out.stdout.split(REC):
        rec = rec.strip("\n")
        if not rec.strip():
            continue
        parts = rec.split(NUL)
        if len(parts) < 4:
            continue
        commits.append((parts[0][:9], parts[1], parts[2], parts[3]))
    return commits


def emit_guard(repo: Path, sha: str, subject: str) -> None:
    row = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "kind": "guard", "event": "bypass-suspected",
        "tool": "audit_commits", "detail": f"{sha} {subject[:120]}",
    }
    line = json.dumps(row, ensure_ascii=False) + "\n"
    for t in (repo / ".workflow" / "telemetry.ndjson",
              Path.home() / ".omp" / "agent" / "telemetry.ndjson"):
        try:
            t.parent.mkdir(parents=True, exist_ok=True)
            with t.open("a", encoding="utf-8") as f:
                f.write(line)
        except OSError:
            pass


def main() -> int:
    ap = argparse.ArgumentParser(description="bypass-аудит коммитов (rail-подпись)")
    ap.add_argument("--repo", type=Path, default=Path.cwd())
    ap.add_argument("--since", help="ref: аудит <since>..HEAD (дефолт вся история)")
    ap.add_argument("--emit", action="store_true", help="писать bypass-suspected в telemetry")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    commits = git_log(args.repo, args.since)
    signed, suspect = [], []
    for sha, author, subject, body in commits:
        text = subject + "\n" + body
        (signed if (RAIL.search(text) or LEGACY.search(text)) else suspect).append(
            {"sha": sha, "author": author, "subject": subject})

    if args.emit:
        for c in suspect:
            emit_guard(args.repo, c["sha"], c["subject"])

    if args.json:
        print(json.dumps({"total": len(commits), "signed": len(signed),
                          "suspect": suspect}, ensure_ascii=False, indent=2))
    else:
        print(f"== BYPASS AUDIT == total={len(commits)} rail-signed={len(signed)} suspect={len(suspect)}")
        if suspect:
            print("-- НЕ через рельс (bypass-suspected / ручные) --")
            for c in suspect:
                print(f"  {c['sha']}  {c['author']:<12}  {c['subject'][:80]}")
        else:
            print("  все коммиты несут rail-подпись ✓")
    # exit 1 если есть подозрительные (для CI/скриптов)
    return 1 if suspect else 0


if __name__ == "__main__":
    raise SystemExit(main())
