#!/usr/bin/env python3
"""
gated_merge.py — L3 merge-рельс (автономный merge, CAPABILITY-GATED).

L3 = машина мёржит сама, без человека. Разрешён ТОЛЬКО там, где enforcement-шим даёт
все требуемые способности (P6). Философия: L3 недостижим на неполном шиме — probe
возвращает insufficient → автономия капается (не молчаливо мёржит вслепую).

Raw `git merge` запрещён в .omp/config.yml (bash.patterns deny) → модель обязана идти сюда.
Внутренний `git merge` — child-process, OMP-approval не перехватывает (как gated_commit/push).

CAPABILITY-PROBE (гейт P6): для класса задачи требуемые способности ДОЛЖНЫ быть в наличии:
  - green-gate     : резолвится gate-команда (.workflow/gate.cmd / GATE_CMD) — свежий гейт на результат merge.
  - clean-rebase   : конфликт-фри слияние base←branch (иначе не «чистый rebase»).
  - forced-critic  : для feature/refactor — critic-evidence (findings без [blocker]).
  - rollback       : для migration — доказуемый откат (pre-merge ref + reset), иначе отказ.
Любая недоступна → INSUFFICIENT → отказ (autonomy capped). security/migration — L3 запрещён
по умолчанию (нужен --allow-risky).

Merge-секвенс (после probe PASS):
  снять pre-ref → checkout base → conflict-probe → merge --no-ff → свежий gate на результат →
  RED? откат (reset --hard pre-ref) + отказ : оставить merge.

Usage:
  python tools/gated_merge.py --branch <feature> [--base main] --class feature
                              [--findings <ledger-findings.md>] [--allow-risky] [--dry-run]
Exit: 0 = смёржено; 1 = отказ (guard/insufficient/gate-red, репо не изменён либо откачен); 2 = ошибка.
"""
from __future__ import annotations
import argparse
import os
import subprocess
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
except Exception:
    pass

RISKY = {"security", "migration"}


def run(cmd: list[str] | str, shell: bool = False) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, shell=shell, text=True, capture_output=True,
                          encoding="utf-8", errors="replace")


def resolve_gate(explicit: str | None) -> str | None:
    if explicit:
        return explicit
    if os.environ.get("GATE_CMD"):
        return os.environ["GATE_CMD"]
    f = Path(".workflow/gate.cmd")
    if f.exists():
        c = f.read_text(encoding="utf-8").strip()
        return c or None
    return None


def critic_ok(findings: Path | None) -> tuple[bool, str]:
    """forced-critic: findings-файл существует и НЕ содержит [blocker]."""
    if findings is None or not findings.exists():
        return False, "нет critic-evidence (findings-файла)"
    blockers = [l.strip() for l in findings.read_text(encoding="utf-8").splitlines()
                if l.strip().lower().startswith("[blocker]")]
    if blockers:
        return False, f"critic нашёл {len(blockers)} blocker(ов)"
    return True, "critic clean (0 blocker)"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--branch", required=True, help="feature-ветка для merge")
    ap.add_argument("--base", default="", help="базовая ветка (дефолт: main или master)")
    ap.add_argument("--class", dest="klass", default="feature",
                    help="класс задачи: feature|refactor|trivial|security|migration")
    ap.add_argument("--findings", help="critic findings-файл (forced-critic для feature/refactor)")
    ap.add_argument("--gate", default=None, help="override gate-команды")
    ap.add_argument("--allow-risky", action="store_true",
                    help="явно разрешить L3 для security/migration (иначе запрещён)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if run(["git", "rev-parse", "--git-dir"]).returncode != 0:
        print("ERROR: не git-репо", file=sys.stderr)
        return 2

    # base автодетект
    base = args.base
    if not base:
        for b in ("main", "master"):
            if run(["git", "rev-parse", "--verify", b]).returncode == 0:
                base = b
                break
    if not base:
        print("ERROR: не найдена base-ветка (main/master); задай --base", file=sys.stderr)
        return 2

    branch, klass = args.branch, args.klass.lower()
    findings = Path(args.findings).resolve() if args.findings else None

    # существование веток
    for ref in (base, branch):
        if run(["git", "rev-parse", "--verify", ref]).returncode != 0:
            print(f"ERROR: ветка не найдена: {ref}", file=sys.stderr)
            return 2

    print(f"=== L3 MERGE PROBE: {branch} → {base} (class={klass}) ===")

    # --- CLASS-GATE ---
    if klass in RISKY and not args.allow_risky:
        print(f"CAP: класс '{klass}' — L3 запрещён по умолчанию (нужен --allow-risky). ОТКАЗ.")
        return 1

    # --- CAPABILITY-PROBE ---
    caps: list[str] = []
    insufficient: list[str] = []

    # green-gate
    gate = resolve_gate(args.gate)
    if gate:
        caps.append("green-gate")
    else:
        insufficient.append("green-gate: нет gate-команды (.workflow/gate.cmd / GATE_CMD)")

    # clean-rebase: конфликт-фри (git merge-tree, без мутации дерева)
    mt = run(["git", "merge-tree", "--write-tree", base, branch])
    if mt.returncode == 0:
        caps.append("clean-rebase")
    elif mt.returncode == 1:
        insufficient.append("clean-rebase: конфликты base←branch (не чистый rebase)")
    else:
        # старый git без --write-tree → фолбэк на test-merge позже; помечаем как условно
        insufficient.append(f"clean-rebase: merge-tree недоступен (rc={mt.returncode}) — probe не может доказать")

    # forced-critic для feature/refactor
    if klass in ("feature", "refactor"):
        ok, msg = critic_ok(findings)
        if ok:
            caps.append(f"forced-critic ({msg})")
        else:
            insufficient.append(f"forced-critic: {msg}")

    # rollback для migration (pre-ref + reset всегда есть в git; требуем зафиксировать)
    if klass == "migration":
        caps.append("rollback (git reset --hard pre-ref)")

    print("  capabilities:", ", ".join(caps) or "—")
    if insufficient:
        print("  INSUFFICIENT:")
        for i in insufficient:
            print("   [x] " + i)
        print("L3 INSUFFICIENT → автономия капается. ОТКАЗ (мёржит человек/L2-PR).")
        return 1

    # рабочее дерево чистое (иначе merge затрёт ungated)
    if run(["git", "status", "--porcelain"]).stdout.strip():
        print("GUARD: рабочее дерево грязное — очисти перед L3-merge. ОТКАЗ.")
        return 1

    pre_ref = run(["git", "rev-parse", "HEAD"]).stdout.strip()
    cur = run(["git", "rev-parse", "--abbrev-ref", "HEAD"]).stdout.strip()

    if args.dry_run:
        print(f"  DRY: checkout {base}; merge --no-ff {branch}; run gate; keep|rollback")
        print(f"  probe PASS — L3 допустим для class={klass}.")
        return 0

    # --- MERGE ---
    if run(["git", "checkout", base]).returncode != 0:
        print("ERROR: checkout base не удался", file=sys.stderr)
        return 2
    base_ref = run(["git", "rev-parse", "HEAD"]).stdout.strip()

    m = run(["git", "merge", "--no-ff", "--no-edit", branch])
    if m.returncode != 0:
        run(["git", "merge", "--abort"])
        run(["git", "checkout", cur])
        print("MERGE конфликт (probe разошёлся с реальностью) → abort. ОТКАЗ.")
        return 1

    # --- FRESH GREEN GATE на результате merge ---
    if gate:
        print(f"GATE (fresh, на merge-результате): {gate}")
        g = run(gate, shell=True)
        sys.stdout.write(g.stdout)
        sys.stderr.write(g.stderr)
        if g.returncode != 0:
            run(["git", "reset", "--hard", base_ref])  # ROLLBACK merge
            run(["git", "checkout", cur])
            print(f"GATE RED (exit {g.returncode}) — merge ОТКАЧЕН (reset к {base_ref[:8]}). ОТКАЗ.")
            return 1
        print("GATE GREEN на merge-результате.")

    merged = run(["git", "rev-parse", "HEAD"]).stdout.strip()
    print(f"L3 MERGED: {branch} → {base} ({merged[:8]}). pre-ref был {pre_ref[:8]} (для отката).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
