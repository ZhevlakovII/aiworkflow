#!/usr/bin/env python3
"""
gated_push.py — L2 push/PR-рельс (автономия до PR; человек апрувит merge).

Единственный разрешённый путь к push. Raw `git push` запрещён в .omp/config.yml
(bash.patterns deny), поэтому модель ОБЯЗАНА идти сюда. Внутренний `git push` —
child-process, OMP-approval его не перехватывает (как gated_commit.py).

Гейт push'а (гейт КОРРЕКТНОСТИ уже прошёл на commit-рельсе — gated_commit; здесь — гейт
БЕЗОПАСНОСТИ доставки):
  1. Ветка НЕ protected (main/master/… — туда пушить автономно нельзя; L3-территория).
  2. Рабочее дерево ЧИСТОЕ — грязь = ungated-контент (не прошёл commit-рельс) → отказ.
  3. Есть коммиты вперёд remote (иначе нечего пушить).
  → пушим feature-ветку; опц. открываем PR (gh). Merge — человек (L2), не тул.

Usage:
  python tools/gated_push.py [--remote origin] [--pr --base main --title T --body B]
                             [--protected main,master] [--dry-run]
Exit: 0 = запушено (+PR если просили); 1 = guard-fail (нет push); 2 = ошибка.
"""
from __future__ import annotations
import argparse
import subprocess
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
except Exception:
    pass


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, text=True, capture_output=True,
                          encoding="utf-8", errors="replace")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--remote", default="origin")
    ap.add_argument("--protected", default="main,master",
                    help="ветки, куда автономный push запрещён (L3-территория)")
    ap.add_argument("--pr", action="store_true", help="открыть PR через gh после push")
    ap.add_argument("--base", default="main", help="базовая ветка PR")
    ap.add_argument("--title", default="")
    ap.add_argument("--body", default="")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if run(["git", "rev-parse", "--git-dir"]).returncode != 0:
        print("ERROR: не git-репо", file=sys.stderr)
        return 2

    # remote существует?
    remotes = run(["git", "remote"]).stdout.split()
    if args.remote not in remotes:
        print(f"GUARD: remote '{args.remote}' не настроен (remotes: {remotes or 'нет'})")
        return 1

    branch = run(["git", "rev-parse", "--abbrev-ref", "HEAD"]).stdout.strip()
    protected = {p.strip() for p in args.protected.split(",") if p.strip()}
    if branch in protected:
        print(f"GUARD: ветка '{branch}' protected — автономный push запрещён (L3). "
              f"Переключись на feature-ветку.")
        return 1
    if branch in ("HEAD", ""):
        print("GUARD: detached HEAD — нет ветки для push")
        return 1

    # рабочее дерево чистое? грязь = ungated-контент (мимо commit-рельса)
    porcelain = run(["git", "status", "--porcelain"]).stdout.strip()
    if porcelain:
        print("GUARD: рабочее дерево грязное (ungated-изменения не прошли commit-рельс):")
        print("\n".join("  " + l for l in porcelain.splitlines()[:20]))
        print("Закоммить через tools/gated_commit.py или почисти перед push.")
        return 1

    # есть что пушить? (коммиты вперёд upstream, либо ветки ещё нет на remote)
    upstream = run(["git", "rev-parse", "--abbrev-ref", f"{branch}@{{upstream}}"])
    if upstream.returncode == 0:
        ahead = run(["git", "rev-list", "--count", f"{upstream.stdout.strip()}..HEAD"]).stdout.strip()
        if ahead == "0":
            print(f"GUARD: нет коммитов вперёд {upstream.stdout.strip()} — нечего пушить")
            return 1
        print(f"push: {branch} +{ahead} коммит(ов) → {args.remote}")
    else:
        print(f"push: новая ветка {branch} → {args.remote} (upstream ещё нет)")

    if args.dry_run:
        print(f"  DRY: git push -u {args.remote} {branch}")
        if args.pr:
            print(f"  DRY: gh pr create --base {args.base} --head {branch} "
                  f"--title {args.title!r} --body <...>")
        return 0

    push = run(["git", "push", "-u", args.remote, branch])
    sys.stdout.write(push.stdout)
    sys.stderr.write(push.stderr)
    if push.returncode != 0:
        print("PUSH FAILED.")
        return 1
    print("PUSHED (feature-ветка).")

    if args.pr:
        title = args.title or f"{branch}: automated change (L2, human approves merge)"
        body = args.body or ("Autonomous L2 flow: commits went through the zone-gated "
                             "commit-rail. Human approves merge.")
        pr = run(["gh", "pr", "create", "--base", args.base, "--head", branch,
                  "--title", title, "--body", body])
        sys.stdout.write(pr.stdout)
        sys.stderr.write(pr.stderr)
        if pr.returncode != 0:
            print("PR CREATE FAILED (push прошёл; открой PR вручную).")
            return 1
        print("PR OPENED (human approves merge).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
