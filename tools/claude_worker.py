#!/usr/bin/env python3
"""
claude_worker.py — dsh-seam (P5): `claude -p` как ВОРКЕР сильной модели для design/critic.

Зачем: local Qwen слаб для design/critic/gate (P2/P3-probe). Producer/critic требуют
сильную модель. ToS-чисто: официальный `claude`-бинарь аутентится в СВОЁМ клиенте —
подписка НЕ покидает официальный клиент (в отличие от OMP `/login` OAuth = ban-риск).
Контракт через файлы + структурированный stdout (roadmap dsh-seam, INV-1/INV-3).

Роли:
  producer — читает locked task-file, пишет spec+ADR файлы с machine-readable
             ```spec/```adr блоками (их парсит gate_lint.py). Read → верные source-ref.
  critic   — читает {task, spec, adr} свежим контекстом, эмитит findings по severity.
             Не правит, не решает (INV-5/INV-6). Пишет findings-файл + stdout.

Контейнмент: воркеру дан ТОЛЬКО {Read,Write,Glob,Grep} (нет Bash → нет escape).
Настоящий рельс — не доверие воркеру, а zone-check на commit-чокпоинте (gated_commit.py):
запись вне зоны ловится детерминированно независимо от того, что написал воркер.

Usage:
  producer: python tools/claude_worker.py --role producer --task T.md --spec S.md --adr A.md [--model sonnet]
  critic:   python tools/claude_worker.py --role critic   --task T.md --spec S.md --adr A.md --findings F.md [--model sonnet]

Exit: 0 = воркер отработал (файлы на месте); 1 = воркер не выдал ожидаемых файлов; 2 = ошибка ввода/запуска.
Печатает финальной строкой JSON: {"role","model","cost_usd","exit","files":[...]}.
"""
from __future__ import annotations
import argparse
import json
import subprocess
import sys
from pathlib import Path

# Windows-консоль cp1251 → форсим UTF-8 (иначе кириллица/глифы падают).
try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
except Exception:
    pass

REPO = Path(__file__).resolve().parent.parent
AGENTS = REPO / ".omp" / "agents"


def role_prompt(role: str) -> str:
    """Системный промпт роли из .omp/agents/<role>.md (без YAML-фронтматтера)."""
    p = AGENTS / f"{role}.md"
    if not p.exists():
        raise FileNotFoundError(f"role-spec не найден: {p}")
    text = p.read_text(encoding="utf-8")
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) == 3:
            text = parts[2]
    return text.strip()


def build_task_prompt(role: str, task: Path, spec: Path, adr: Path,
                      findings: Path | None, notes: str = "") -> tuple[str, str, str]:
    """Возвращает (user_prompt, allowed_tools, kind). kind = producer|critic.
    notes — опц. контекст (напр. findings прошлого гейта при bounce-retry)."""
    task_rel = task.relative_to(REPO).as_posix()
    note_block = (f"\n\nИСПРАВЬ по замечаниям прошлого прохода (перепиши артефакты):\n{notes}"
                  if notes.strip() else "")
    if role == "producer":
        spec_rel = spec.relative_to(REPO).as_posix()
        adr_rel = adr.relative_to(REPO).as_posix()
        prompt = (
            f"Locked task-file (ЕДИНСТВЕННЫЙ источник контракта): {task_rel}\n\n"
            f"Прочитай его через Read. Произведи ДВА артефакта, записав их через Write:\n"
            f"  1. spec → {spec_rel}\n"
            f"  2. ADR  → {adr_rel}\n\n"
            f"КАЖДЫЙ SP-point и AD-decision ОБЯЗАН нести machine-readable fenced-блок "
            f"(```spec / ```adr) в формате из твоей роли — их парсит детерминированный "
            f"gate-линтер. source-ref обязан указывать на РЕАЛЬНЫЕ непустые строки "
            f"{task_rel} (формат <file>#L<start>-L<end>): открой файл, возьми точные "
            f"номера строк, не выдумывай. covers ссылается только на существующие SP-id.\n"
            f"Проза + fenced-блоки в одном файле. Не пиши никаких других файлов."
            + note_block
        )
        return prompt, "Read,Write,Glob,Grep", "producer"
    elif role == "critic":
        assert findings is not None
        prompt = (
            f"Свежий критический проход. Прочитай через Read:\n"
            f"  task-file (источник): {task.relative_to(REPO).as_posix()}\n"
            f"  spec: {spec.relative_to(REPO).as_posix()}\n"
            f"  ADR:  {adr.relative_to(REPO).as_posix()}\n\n"
            f"Проверь: Gate-1 (каждый SP реально поддержан source-ref в task-file), "
            f"Gate-2 (каждый AD покрывает SP; каждый SP покрыт или явный gap), "
            f"level-boundary (solution-лексика в spec = leakage), прескриптивность.\n"
            f"Запиши findings через Write в {findings.relative_to(REPO).as_posix()}: "
            f"по одному на строку в формате `[blocker|major|minor] <файл>: <проблема>`. "
            f"Если дефектов нет — строка `[none] clean`. Не правь артефакты, не решай направление."
            + note_block
        )
        return prompt, "Read,Write,Glob,Grep", "critic"
    raise ValueError(f"неизвестная роль: {role!r}")


def run_claude(model: str, sys_prompt: str, user_prompt: str,
               allowed: str, timeout: int) -> tuple[int, dict]:
    """Запускает claude -p headless, structured JSON-return. ToS-safe (свой auth)."""
    cmd = [
        "claude", "-p", user_prompt,
        "--model", model,
        "--output-format", "json",
        "--append-system-prompt", sys_prompt,
        "--allowedTools", allowed,
        "--add-dir", str(REPO),
    ]
    try:
        r = subprocess.run(cmd, cwd=str(REPO), text=True, capture_output=True,
                           encoding="utf-8", errors="replace", timeout=timeout)
    except FileNotFoundError:
        print("ERROR: `claude` не найден в PATH (нужен Claude Code CLI)", file=sys.stderr)
        return 2, {}
    except subprocess.TimeoutExpired:
        print(f"ERROR: claude timeout ({timeout}s)", file=sys.stderr)
        return 124, {}
    meta: dict = {}
    if r.stdout.strip():
        try:
            meta = json.loads(r.stdout)
        except json.JSONDecodeError:
            meta = {"raw": r.stdout[-2000:]}
    if r.returncode != 0:
        print(f"claude rc={r.returncode}\n{r.stderr[-2000:]}", file=sys.stderr)
    return r.returncode, meta


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--role", required=True, choices=["producer", "critic"])
    ap.add_argument("--task", required=True)
    ap.add_argument("--spec", required=True)
    ap.add_argument("--adr", required=True)
    ap.add_argument("--findings", help="куда critic пишет findings (обяз. для critic)")
    ap.add_argument("--model", default="sonnet",
                    help="alias/id сильной модели (sonnet|opus|<id>); default sonnet (дешевле)")
    ap.add_argument("--notes", default="",
                    help="опц. контекст для воркера (напр. findings прошлого гейта при bounce-retry)")
    ap.add_argument("--timeout", type=int, default=600)
    args = ap.parse_args()

    task = Path(args.task).resolve()
    spec = Path(args.spec).resolve()
    adr = Path(args.adr).resolve()
    findings = Path(args.findings).resolve() if args.findings else None

    if not task.exists():
        print(f"ERROR: task-file не найден: {task}", file=sys.stderr)
        return 2
    if args.role == "critic" and findings is None:
        print("ERROR: --findings обязателен для роли critic", file=sys.stderr)
        return 2
    # артефакты должны лежать внутри репо (чтобы zone-check покрывал их на коммите)
    for p in (spec, adr) + ((findings,) if findings else ()):
        try:
            p.relative_to(REPO)
        except ValueError:
            print(f"ERROR: путь вне репо (не покрывается zone-check): {p}", file=sys.stderr)
            return 2
        p.parent.mkdir(parents=True, exist_ok=True)

    sys_prompt = role_prompt(args.role)
    user_prompt, allowed, kind = build_task_prompt(
        args.role, task, spec, adr, findings, args.notes)

    print(f"=== claude-worker [{args.role}] model={args.model} ===", flush=True)
    rc, meta = run_claude(args.model, sys_prompt, user_prompt, allowed, args.timeout)

    # верифицируем, что воркер выдал ожидаемые файлы (не доверяем только exit-коду)
    if kind == "producer":
        expect = [spec, adr]
    else:
        expect = [findings]  # type: ignore[list-item]
    written = [p for p in expect if p and p.exists()]
    missing = [p for p in expect if p and not p.exists()]

    result = {
        "role": args.role,
        "model": args.model,
        "cost_usd": meta.get("total_cost_usd"),
        "exit": rc,
        "files": [p.relative_to(REPO).as_posix() for p in written],
        "missing": [p.relative_to(REPO).as_posix() for p in missing],
    }
    if rc != 0:
        print(json.dumps(result, ensure_ascii=False))
        return 2 if rc in (2, 124) else 1
    if missing:
        print(f"ВОРКЕР не создал: {result['missing']}", file=sys.stderr)
        print(json.dumps(result, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
