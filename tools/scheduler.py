#!/usr/bin/env python3
"""
scheduler.py — внешний автономный луп (P4, автономия L1).

D10: пока в очереди есть pending — брать следующую, гнать omp headless до коммита;
done → next; упор (ненулевой exit/timeout) → blocked → next. Поток не встаёт на одной задаче.

Task-file ИММУТАБЕЛЕН (INV-1) → статус НЕ пишем в него. Состояние очереди — отдельный
`.workflow/queue-state.json` {task_id: pending|active|done|blocked}.

Драйвер задаётся шаблоном (--omp-cmd); {task} и {prompt} подставляются. Дефолт — autonomous-профиль
(`omp -p --approval-mode yolo`). Для теста логики очереди --omp-cmd можно подменить (echo/скрипт).

Usage:
  python tools/scheduler.py [--tasks-dir .workflow/tasks] [--state .workflow/queue-state.json]
                            [--omp-cmd "omp -p --approval-mode yolo {prompt}"]
                            [--max-tasks N] [--timeout SEC] [--rollback-on-block] [--dry-run]
Exit: 0 = очередь исчерпана; 2 = ошибка.
"""
from __future__ import annotations
import argparse
import collections
import json
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
except Exception:
    pass

PROMPT_TMPL = (
    "Execute the task contract in {task}. Follow .omp/AGENTS.md flow: classify, "
    "delegate to workers (isolated), run the gate, commit via tools/gated_commit.py, write the ledger. "
    "Do not produce yourself; do not exceed the contract."
)


def task_id(p: Path) -> str:
    text = p.read_text(encoding="utf-8")
    m = re.search(r"^\s*id:\s*(.+?)\s*$", text, re.MULTILINE)
    return (m.group(1).strip() if m else p.stem)


def is_design_stage(p: Path) -> bool:
    """design-стадийная задача (stage: design / design-only) → драйвер design_stage.py
    (сильная модель на producer/critic), не OMP-lead на Qwen."""
    text = p.read_text(encoding="utf-8")
    m = re.search(r"^\s*stage:\s*(.+?)\s*$", text, re.MULTILINE)
    return bool(m and m.group(1).strip().startswith("design"))


def load_state(sp: Path) -> dict:
    if sp.exists():
        try:
            return json.loads(sp.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_state(sp: Path, st: dict) -> None:
    sp.parent.mkdir(parents=True, exist_ok=True)
    sp.write_text(json.dumps(st, indent=2, ensure_ascii=False), encoding="utf-8")


def run(cmd: str, timeout: int) -> tuple[int, str]:
    """Стримит вывод omp построчно (live, префикс │) + держит tail + timeout-watchdog."""
    p = subprocess.Popen(cmd, shell=True, stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, text=True,
                         encoding="utf-8", errors="replace", bufsize=1)
    killed = {"v": False}
    timer = threading.Timer(timeout, lambda: (killed.__setitem__("v", True), p.kill()))
    timer.start()
    tail: collections.deque = collections.deque(maxlen=20)
    try:
        assert p.stdout is not None
        for line in p.stdout:
            line = line.rstrip("\n")
            print("  │ " + line, flush=True)   # live
            tail.append(line)
    finally:
        if p.stdout:
            p.stdout.close()
        rc = p.wait()
        timer.cancel()
    if killed["v"]:
        return 124, "TIMEOUT"
    return rc, "\n".join(tail)


def rollback() -> None:
    # D10: откат незакоммиченного. .workflow/ (state/ledger) сохраняем.
    subprocess.run(["git", "reset", "--hard", "-q", "HEAD"], capture_output=True)
    subprocess.run(["git", "clean", "-fdq", "-e", ".workflow"], capture_output=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tasks-dir", default=".workflow/tasks")
    ap.add_argument("--state", default=".workflow/queue-state.json")
    ap.add_argument("--omp-cmd", default='omp -p --approval-mode yolo "{prompt}"')
    ap.add_argument("--design-model", default="sonnet",
                    help="модель для design-стадии (claude -p воркер); default sonnet")
    ap.add_argument("--advisor", action="store_true",
                    help="включить OMP-advisor оверсайт на omp-lead route (модель=modelRoles.advisor; "
                         "дефолт off — Qwen-advisor слаб + латентность; вкл при сильной advisor-модели)")
    ap.add_argument("--max-tasks", type=int, default=50)
    ap.add_argument("--timeout", type=int, default=3600)
    ap.add_argument("--rollback-on-block", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    tasks_dir = Path(args.tasks_dir)
    state_p = Path(args.state)
    if not tasks_dir.is_dir():
        print(f"ERROR: нет tasks-dir: {tasks_dir}", file=sys.stderr)
        return 2

    done_count = 0
    for _ in range(args.max_tasks):
        st = load_state(state_p)
        # pending = task-файлы, чей id не в терминальном статусе
        pending = []
        for f in sorted(tasks_dir.glob("*.md")):
            tid = task_id(f)
            if st.get(tid) not in ("done", "blocked", "active"):
                pending.append((tid, f))
        if not pending:
            print(f"queue drained. processed={done_count}")
            return 0

        tid, f = pending[0]
        st[tid] = "active"
        save_state(state_p, st)
        # роутинг: design-стадия → детерминир. драйвер (claude -p воркер, сильная модель);
        # остальное → OMP-lead (Qwen оркестрирует execute-флоу).
        if is_design_stage(f):
            cmd = (f'"{sys.executable}" tools/design_stage.py --task {f.as_posix()} '
                   f'--model {args.design_model} --timeout {args.timeout}')
            route = "design_stage"
        else:
            omp_cmd = args.omp_cmd
            if args.advisor and "--advisor" not in omp_cmd:
                omp_cmd = omp_cmd.replace("omp ", "omp --advisor ", 1)  # оверсайт-ревью каждого хода
            prompt = PROMPT_TMPL.format(task=f.as_posix())
            cmd = omp_cmd.replace("{prompt}", prompt).replace("{task}", f.as_posix())
            route = "omp-lead" + (" +advisor" if args.advisor else "")
        print(f"\n=== RUN {done_count + 1}: {tid} ({f.name}) [{route}] ===", flush=True)
        if args.dry_run:
            print(f"  DRY: {cmd}")
            st[tid] = "done"
            save_state(state_p, st)
            done_count += 1
            continue

        t0 = time.time()
        rc, _ = run(cmd, args.timeout)   # вывод уже стримился live
        el = int(time.time() - t0)
        if rc == 0:
            st[tid] = "done"
            print(f"  >> {tid}: DONE ({el}s)", flush=True)
        else:
            if args.rollback_on_block:
                rollback()
            st[tid] = "blocked"
            note = " + rolled back" if args.rollback_on_block else ""
            print(f"  >> {tid}: BLOCKED rc={rc} ({el}s){note}", flush=True)
        save_state(state_p, st)
        done_count += 1

    print(f"max-tasks reached ({args.max_tasks}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
