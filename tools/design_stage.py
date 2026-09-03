#!/usr/bin/env python3
"""
design_stage.py — детерминированный драйвер design-стадии (P5, автономный флоу).

Зачем: design/critic-оркестрацию НЕЛЬЗЯ доверять Qwen-lead (P2/P3-probe: split
producer'ов, rubber-stamp гейта, дрейф). Thesis проекта — enforcement > инструкции.
Драйвер выносит последовательность из модели в Python: producer→gate_lint→(bounce-retry)
→critic→ledger→gated_commit. Модель делает мышление (claude -p, сильная), Python — поток.

Дизайн-мышление идёт через `claude_worker.py` (ToS-safe `claude -p`, сильная модель),
не через OMP-субагента на Qwen. Механический гейт — `gate_lint.py`. Коммит — `gated_commit.py`
(zone-check на коммите = настоящий рельс).

Поток:
  1. gate_setup     → .workflow/gate.cmd (zone-check из зоны task-file)
  2. producer       → spec + ADR (валидные source-ref)
  3. gate_lint      → PASS | BOUNCE; на BOUNCE — 1 retry producer'а с findings
  4. critic         → findings по severity (свежий контекст)
  5. ledger         → вердикт гейта + critic-findings + статус
  6. если locked (gate PASS + нет blocker/major) → gated_commit; иначе exit 1 (blocked)

Usage:
  python tools/design_stage.py --task .workflow/tasks/design-cache-2026-08-24.md [--model sonnet]
Exit: 0 = design locked+committed; 1 = bounced/blocked (не закоммичено); 2 = ошибка.
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

REPO = Path(__file__).resolve().parent.parent
TOOLS = REPO / "tools"
PY = sys.executable


def sh(args: list[str], **kw) -> subprocess.CompletedProcess:
    """Запуск дочернего тула; вывод стримим (не глушим — автономный прогон должен быть виден)."""
    print(f"  $ {' '.join(Path(a).name if a.endswith('.py') else a for a in args)}", flush=True)
    return subprocess.run(args, cwd=str(REPO), text=True,
                          encoding="utf-8", errors="replace", **kw)


def parse_task(task: Path) -> dict:
    """Минимальный парс frontmatter: id, zone.allow[0], stage, class, design-model."""
    text = task.read_text(encoding="utf-8")
    fm = text.split("---", 2)[1] if text.startswith("---") else text
    d: dict = {}

    def scalar(key: str) -> str:
        m = re.search(rf"^\s*{key}:\s*(.+?)\s*$", fm, re.MULTILINE)
        if not m:
            return ""
        return re.sub(r"\s+#\s.*$", "", m.group(1)).strip()  # срезаем inline-коммент

    d["id"] = scalar("id") or task.stem
    d["stage"] = scalar("stage")
    d["class"] = scalar("class")
    d["model"] = scalar("design-model")
    # zone.allow — берём первый glob-путь как out-dir дизайна
    m = re.search(r"allow:\s*\[([^\]]*)\]", fm)
    allow0 = ""
    if m:
        items = re.findall(r'["\']([^"\']+)["\']', m.group(1))
        allow0 = items[0] if items else ""
    d["out_dir"] = allow0.replace("/**", "").replace("/*", "").strip() or "docs/design"
    return d


def critic_severity(findings_file: Path) -> tuple[list[str], list[str]]:
    """Возвращает (blocking, other): blocker/major блокируют лок, minor/none — нет."""
    if not findings_file.exists():
        return ["критик не создал findings-файл"], []
    blocking, other = [], []
    for line in findings_file.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s:
            continue
        low = s.lower()
        if low.startswith("[none]"):
            continue
        if low.startswith("[blocker]") or low.startswith("[major]"):
            blocking.append(s)
        elif low.startswith("[minor]"):
            other.append(s)
    return blocking, other


def write_ledger(led: Path, t: dict, gate_verdict: str, gate_out: str,
                 blocking: list[str], other: list[str], status: str) -> None:
    led.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        f"---", f"id: {t['id']}", f"stage: design", f"status: {status}",
        f"model: {t['model']}", f"date: 2026-08-26", f"---", "",
        "## Design ledger (deterministic driver)", "",
        f"**Contract:** `.workflow/tasks/{t['id']}.md` (locked, INV-1)", "",
        f"### Gate-1/2 (gate_lint.py — механический)",
        f"Вердикт: **{gate_verdict}**", "```", gate_out.strip(), "```", "",
        f"### Critic (свежий контекст, сильная модель — семантика)",
    ]
    if blocking:
        lines.append("**Blocking (blocker/major):**")
        lines += [f"- {b}" for b in blocking]
    if other:
        lines.append("**Non-blocking (minor):**")
        lines += [f"- {o}" for o in other]
    if not blocking and not other:
        lines.append("clean")
    lines += ["", f"### Итог: **{status}**"]
    led.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--task", required=True)
    ap.add_argument("--model", default="", help="override design-model (иначе из task-file / sonnet)")
    ap.add_argument("--timeout", type=int, default=600)
    ap.add_argument("--no-commit", action="store_true", help="не коммитить (для теста)")
    args = ap.parse_args()

    task = Path(args.task).resolve()
    if not task.exists():
        print(f"ERROR: task-file не найден: {task}", file=sys.stderr)
        return 2
    t = parse_task(task)
    t["model"] = args.model or t["model"] or "sonnet"
    tid = t["id"]
    out = REPO / t["out_dir"]
    spec = out / f"{tid}-spec.md"
    adr = out / f"{tid}-adr.md"
    findings = REPO / ".workflow" / "ledger" / f"{tid}-findings.md"
    ledger = REPO / ".workflow" / "ledger" / f"{tid}.md"

    print(f"=== DESIGN STAGE: {tid} (model={t['model']}, out={t['out_dir']}/) ===", flush=True)

    # 1. gate_setup → .workflow/gate.cmd (zone-check из зоны задачи)
    r = sh([PY, str(TOOLS / "gate_setup.py"), "--task", str(task)])
    if r.returncode != 0:
        print("ERROR: gate_setup упал", file=sys.stderr)
        return 2

    worker = [PY, str(TOOLS / "claude_worker.py")]
    gl = [PY, str(TOOLS / "gate_lint.py"), "--task", str(task),
          "--spec", str(spec), "--adr", str(adr)]

    # 2-3. producer → gate_lint, до 2 попыток (bounce-retry с findings)
    gate_out, gate_verdict = "", "BOUNCE"
    notes = ""
    for attempt in (1, 2):
        pr = sh(worker + ["--role", "producer", "--task", str(task),
                          "--spec", str(spec), "--adr", str(adr),
                          "--model", t["model"], "--timeout", str(args.timeout)]
                + (["--notes", notes] if notes else []))
        if pr.returncode != 0:
            print(f"ERROR: producer rc={pr.returncode}", file=sys.stderr)
            return 1 if pr.returncode == 1 else 2
        g = sh(gl, capture_output=True)
        gate_out = (g.stdout or "") + (g.stderr or "")
        print(gate_out, flush=True)
        if g.returncode == 0:
            gate_verdict = "PASS"
            break
        gate_verdict = "BOUNCE"
        notes = gate_out
        print(f"  gate_lint BOUNCE (попытка {attempt}) → "
              + ("retry producer с findings" if attempt == 1 else "исчерпано"), flush=True)

    # 4. critic (свежий контекст) — даже при PASS: ловит семантику, что гейт не видит
    cr = sh(worker + ["--role", "critic", "--task", str(task),
                      "--spec", str(spec), "--adr", str(adr),
                      "--findings", str(findings),
                      "--model", t["model"], "--timeout", str(args.timeout)])
    if cr.returncode not in (0,):
        print(f"WARN: critic rc={cr.returncode} (findings могут быть неполными)", file=sys.stderr)
    blocking, other = critic_severity(findings)

    # 5. статус: locked только если gate PASS И нет blocker/major
    locked = (gate_verdict == "PASS") and not blocking
    status = "locked" if locked else "blocked"
    write_ledger(ledger, t, gate_verdict, gate_out, blocking, other, status)
    print(f"\n--- DESIGN {status.upper()}: gate={gate_verdict}, "
          f"blocking={len(blocking)}, minor={len(other)} ---", flush=True)

    if not locked:
        print("Design НЕ залочен → не коммичу (blocked). Артефакты+ledger на диске для ревью/итерации.")
        return 1

    # 6. commit через рельс (zone-check на коммите)
    if args.no_commit:
        print("--no-commit: пропускаю коммит.")
        return 0
    c = sh([PY, str(TOOLS / "gated_commit.py"), "-m",
            f"design({tid}): spec+ADR locked (gate PASS, critic clean)"])
    if c.returncode != 0:
        print(f"ERROR: gated_commit rc={c.returncode}", file=sys.stderr)
        return 1
    print("DESIGN STAGE: locked + committed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
