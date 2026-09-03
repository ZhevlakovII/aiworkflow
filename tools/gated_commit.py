#!/usr/bin/env python3
"""
gated_commit.py — L1 commit-rail (INV: нет коммита без зелёного гейта).

Единственный разрешённый путь к коммиту. Raw `git commit` запрещён в .omp/config.yml
(bash.patterns), поэтому модель ОБЯЗАНА идти сюда. Скрипт гоняет проектный gate;
коммитит ТОЛЬКО при exit 0. Внутренний `git commit` — child-process, OMP-approval его не перехватывает.

Gate-команда (stack-agnostic, D5): берётся из (в порядке):
  1. env GATE_CMD
  2. файл .workflow/gate.cmd (одна shell-команда)
  3. нет ни того ни другого → gate-optional PASS (с предупреждением)

Usage:
  python tools/gated_commit.py -m "message" [--gate "pytest -q"] [--allow-empty]
Exit: 0 = закоммичено; 1 = gate red (нет коммита); 2 = ошибка.
"""
from __future__ import annotations
import argparse
import hashlib
import subprocess
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
except Exception:
    pass


def run(cmd: list[str] | str, shell: bool = False) -> subprocess.CompletedProcess:
    # encoding=utf-8: дочерние тулы пишут utf-8; без этого Windows cp1251 даёт мойибаке.
    return subprocess.run(cmd, shell=shell, text=True, capture_output=True,
                          encoding="utf-8", errors="replace")


def resolve_gate(explicit: str | None) -> str | None:
    if explicit:
        return explicit
    import os
    if os.environ.get("GATE_CMD"):
        return os.environ["GATE_CMD"]
    f = Path(".workflow/gate.cmd")
    if f.exists():
        c = f.read_text(encoding="utf-8").strip()
        return c or None
    return None


def pending_hash() -> str:
    """Хэш незакоммиченных изменений — маркер зафиксирует, что гейтили именно это дерево."""
    diff = run(["git", "diff", "HEAD"]).stdout
    untracked = run(["git", "ls-files", "--others", "--exclude-standard"]).stdout
    return hashlib.sha256((diff + "\n" + untracked).encode("utf-8")).hexdigest()[:16]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("-m", "--message", required=True)
    ap.add_argument("--gate", default=None, help="override gate command")
    ap.add_argument("--allow-empty", action="store_true")
    args = ap.parse_args()

    if run(["git", "rev-parse", "--git-dir"]).returncode != 0:
        print("ERROR: не git-репо", file=sys.stderr)
        return 2

    # Стейджим ДО гейта — иначе новые untracked-файлы не попадут в staged-набор,
    # и zone_check/тесты гейта их не увидят (дыра). На красном гейте — unstage (reset).
    add = run(["git", "add", "-A"])
    if add.returncode != 0:
        sys.stderr.write(add.stderr)
        return 2

    gate = resolve_gate(args.gate)
    if gate is None:
        print("WARN: gate-команда не задана (GATE_CMD / .workflow/gate.cmd) → gate-optional PASS")
    else:
        print(f"GATE: {gate}")
        res = run(gate, shell=True)
        sys.stdout.write(res.stdout)
        sys.stderr.write(res.stderr)
        if res.returncode != 0:
            run(["git", "reset", "-q"])  # unstage, рабочие изменения сохранены
            print(f"GATE RED (exit {res.returncode}) — КОММИТ ОТМЕНЁН (staged сброшен).")
            return 1
        print("GATE GREEN.")

    marker = Path(".workflow/gate")
    marker.mkdir(parents=True, exist_ok=True)
    (marker / "PASS").write_text(pending_hash(), encoding="utf-8")

    commit_cmd = ["git", "commit", "-m", args.message]
    if args.allow_empty:
        commit_cmd.append("--allow-empty")
    c = run(commit_cmd)
    sys.stdout.write(c.stdout)
    sys.stderr.write(c.stderr)
    if c.returncode != 0:
        print("git commit failed.")
        return 2
    print("COMMITTED (gate green).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
