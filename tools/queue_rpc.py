#!/usr/bin/env python3
"""
queue_rpc.py — тонкий session-keeper для in-process очереди (P7 Phase-3).

НЕ оркестратор (в отличие от scheduler.py, который спавнил `omp -p` на каждую задачу и решал
routing/verdict СНАРУЖИ). Вся логика очереди — select/dispatch/verdict(HEAD-advance)/advance/routing —
живёт ВНУТРИ OMP в hook'е `.omp/hooks/queue-runner.ts`. Этот драйвер только:
  1. поднимает ОДИН персистентный `omp --mode=rpc` (armed env OMP_QUEUE),
  2. шлёт один kick-prompt (дальше hook сам гонит очередь через agent_end→sendMessage),
  3. держит stdin открытым (иначе rpc disposes сессию), стримит события,
  4. закрывает stdin когда очередь дренирована (все task-id из tasks-dir терминальны в state).

Зачем rpc, не `-p`: `omp -p` = single-shot (dispose сразу после agent_end) → re-driven ход
аборти(ру)ется. `--mode=rpc` держит сессию живой на открытом stdin → hook re-drive работает.

Usage:
  python tools/queue_rpc.py [--tasks-dir DIR] [--state FILE] [--model M] [--advisor]
                            [--rollback-on-block] [--timeout SEC]
Exit: 0 = очередь дренирована; 124 = timeout; 2 = ошибка.
"""
from __future__ import annotations
import argparse
import json
import os
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

REPO = Path(__file__).resolve().parent.parent
KICK = ("Autonomous queue mode armed. Reply exactly QUEUE-READY, then process each injected "
        "task prompt as it arrives. Do nothing else on your own.")


def task_ids(tasks_dir: Path) -> set[str]:
    ids: set[str] = set()
    if not tasks_dir.is_dir():
        return ids
    for f in tasks_dir.glob("*.md"):
        m = re.search(r"^\s*id:\s*(.+?)\s*$", f.read_text(encoding="utf-8"), re.MULTILINE)
        ids.add((m.group(1).strip() if m else f.stem))
    return ids


def load_state(sp: Path) -> dict:
    try:
        return json.loads(sp.read_text(encoding="utf-8"))
    except Exception:
        return {}


def all_terminal(ids: set[str], st: dict) -> bool:
    """Дренирована ли очередь: каждый task-id терминальный (done|blocked)."""
    if not ids:
        return False
    return all(st.get(i) in ("done", "blocked") for i in ids)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cwd", default="", help="рабочая дир для omp (дефолт = репо этого скрипта; для target укажи явно)")
    ap.add_argument("--tasks-dir", default=".workflow/tasks")
    ap.add_argument("--state", default=".workflow/queue-state.json")
    ap.add_argument("--model", default="", help="lead-модель (иначе дефолт config/modelRoles)")
    ap.add_argument("--advisor", action="store_true", help="включить OMP-advisor оверсайт")
    ap.add_argument("--rollback-on-block", action="store_true")
    ap.add_argument("--timeout", type=int, default=1800)
    ap.add_argument("--quiet", action="store_true", help="не печатать событийный стрим")
    args = ap.parse_args()

    base = Path(args.cwd).resolve() if args.cwd else REPO
    tasks_dir = (base / args.tasks_dir).resolve() if not Path(args.tasks_dir).is_absolute() else Path(args.tasks_dir)
    state_p = (base / args.state).resolve() if not Path(args.state).is_absolute() else Path(args.state)
    ids = task_ids(tasks_dir)
    if not ids:
        print(f"нет задач в {tasks_dir} — нечего гнать.", file=sys.stderr)
        return 2

    # Логи ПРОЕКТНО в .workflow/logs (раньше rpc-стрим уходил только в консоль → терялся; ошибки не писались).
    logs_dir = base / ".workflow" / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    ts = time.strftime("%Y%m%d-%H%M%S")
    sess_log = logs_dir / f"rr-session-{ts}.jsonl"   # полный сырой rpc-стрим
    err_log = logs_dir / f"err-{ts}.log"             # только ошибки (error-фреймы + ненулевой exit)
    print(f"  logs: {sess_log.name} / {err_log.name} (в .workflow/logs)", flush=True)

    env = dict(os.environ)
    env["OMP_QUEUE"] = "1"
    env["OMP_QUEUE_TASKS_DIR"] = str(tasks_dir)
    env["OMP_QUEUE_STATE"] = str(state_p)
    if args.rollback_on_block:
        env["OMP_QUEUE_ROLLBACK"] = "1"

    cmd = ["omp", "--mode=rpc", "--approval-mode", "yolo"]
    if args.model:
        cmd += ["--model", args.model]
    if args.advisor:
        cmd.insert(1, "--advisor")

    print(f"=== QUEUE-RPC: {len(ids)} задач, model={args.model or 'default'}"
          f"{' +advisor' if args.advisor else ''} ===", flush=True)
    p = subprocess.Popen(cmd, cwd=str(base), env=env, text=True, bufsize=1,
                         encoding="utf-8", errors="replace",
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    assert p.stdin and p.stdout

    done = {"v": False}
    err_count = {"v": 0}
    ERR_RE = re.compile(r'"type"\s*:\s*"error"|"error"\s*:\s*\{|"level"\s*:\s*"error"|"isError"\s*:\s*true', re.I)

    def is_error_event(line: str, ev: dict | None) -> bool:
        if ev is not None:
            if ev.get("type") == "error" or ev.get("isError") is True or ev.get("level") == "error":
                return True
            if isinstance(ev.get("error"), (dict, str)) and ev.get("error"):
                return True
            sub = ev.get("subtype") or ev.get("kind")
            if isinstance(sub, str) and "error" in sub.lower():
                return True
            return False
        return bool(ERR_RE.search(line))

    def reader() -> None:
        # Каждую строку rpc-стрима пишем в session-log; ошибки — дублируем в err-log. Best-effort.
        with sess_log.open("w", encoding="utf-8") as sf, err_log.open("w", encoding="utf-8") as ef:
            for line in p.stdout:  # type: ignore[union-attr]
                line = line.rstrip("\n")
                if not line.strip():
                    continue
                sf.write(line + "\n"); sf.flush()
                ev = None
                try:
                    ev = json.loads(line)
                except Exception:
                    ev = None
                if is_error_event(line, ev):
                    err_count["v"] += 1
                    ef.write(line + "\n"); ef.flush()
                if not args.quiet and ev is not None:
                    t = ev.get("type", "?")
                    if t in ("agent_start", "agent_end", "response", "prompt_result", "error"):
                        print(f"  ‹{t}›" + ("  [ERROR]" if t == "error" else ""), flush=True)
        done["v"] = True

    threading.Thread(target=reader, daemon=True).start()

    # ждём ready-фрейм чуть, потом kick
    time.sleep(0.5)
    p.stdin.write(json.dumps({"id": "kick", "type": "prompt", "message": KICK}) + "\n")
    p.stdin.flush()

    t0 = time.time()
    rc = 0
    while True:
        if done["v"]:
            print("  rpc-стрим закрыт (сессия завершилась).", flush=True)
            break
        if all_terminal(ids, load_state(state_p)):
            print("  очередь дренирована → закрываю stdin.", flush=True)
            break
        if time.time() - t0 > args.timeout:
            print(f"  TIMEOUT ({args.timeout}s).", file=sys.stderr, flush=True)
            rc = 124
            break
        time.sleep(2)

    try:
        p.stdin.close()
    except Exception:
        pass
    try:
        p.wait(timeout=30)
    except Exception:
        p.kill()

    # Ненулевой exit omp — тоже ошибка: фиксируем в err-log (иначе терялся).
    if p.returncode not in (0, None):
        try:
            with err_log.open("a", encoding="utf-8") as ef:
                ef.write(json.dumps({"type": "error", "source": "queue_rpc", "detail": f"omp exit {p.returncode}"}) + "\n")
            err_count["v"] += 1
        except Exception:
            pass

    st = load_state(state_p)
    done_n = sum(1 for i in ids if st.get(i) == "done")
    blocked_n = sum(1 for i in ids if st.get(i) == "blocked")
    print(f"=== ИТОГ: done={done_n} blocked={blocked_n} / {len(ids)}, errors={err_count['v']} "
          f"(logs: {logs_dir}) ===", flush=True)
    return rc


if __name__ == "__main__":
    sys.exit(main())
