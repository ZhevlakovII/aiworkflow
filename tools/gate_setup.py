#!/usr/bin/env python3
"""
gate_setup.py — генерит .workflow/gate.cmd из task-file (P3, зонный enforcement на commit-чокпоинте).

Идея: единственный путь к коммиту — gated_commit.py, который гоняет .workflow/gate.cmd.
Если gate.cmd = zone_check(изменения vs зона задачи) [&& тесты], то запись вне зоны —
даже сделанная воркером в его isolated-клоне через bash (в обход мид-воркер хука) —
ДЕТЕРМИНИСТИЧНО блокирует коммит. Единый чокпоинт, модель-агностично.

Читает frontmatter task-file: zone.allow, zone.deny, опц. test-cmd, gate-optional.
Пишет .workflow/gate.cmd = shell-команда, которую запустит gated_commit.

Usage:
  python tools/gate_setup.py --task .workflow/tasks/<id>.md [--base HEAD]
Exit: 0 = записан gate.cmd; 2 = ошибка.
"""
from __future__ import annotations
import argparse
import re
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
except Exception:
    pass


def frontmatter(text: str) -> str:
    m = re.match(r"\s*---\s*\n(.*?)\n---", text, re.DOTALL)
    return m.group(1) if m else ""


def glob_list(fm: str, key: str) -> list[str]:
    m = re.search(rf"{key}:\s*\[([^\]]*)\]", fm)
    if not m:
        return []
    return re.findall(r'"([^"]+)"', m.group(1))


def scalar(fm: str, key: str) -> str | None:
    m = re.search(rf"^{key}:\s*(.+?)\s*$", fm, re.MULTILINE)
    return m.group(1).strip().strip('"') if m else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--task", required=True)
    ap.add_argument("--base", default="HEAD", help="git base ref для diff зоны")
    args = ap.parse_args()

    tp = Path(args.task)
    if not tp.exists():
        print(f"ERROR: task-file не найден: {tp}", file=sys.stderr)
        return 2
    fm = frontmatter(tp.read_text(encoding="utf-8"))
    allow = glob_list(fm, "allow")
    deny = glob_list(fm, "deny")
    if not allow:
        print("ERROR: в task-file нет zone.allow (зона обязательна, Q4)", file=sys.stderr)
        return 2
    # lead-state (ledger, task-file, gate.cmd) всегда коммитабелен — авто-allow, иначе каждый
    # коммит спотыкается на изменениях .workflow. Worker'ы туда не пишут (их зона — код).
    if ".workflow/**" not in allow:
        allow.append(".workflow/**")
    # .workflow ВСЕГДА allow → вычищаем из deny, иначе конфликт (deny побеждает в zone_check,
    # и ledger-запись lead'а падает). Баг из P4-live-прогона.
    deny = [d for d in deny if d not in (".workflow/**", ".workflow/*", ".workflow")]

    test_cmd = scalar(fm, "test-cmd")               # опц. проектная команда gate
    gate_optional = (scalar(fm, "gate-optional") or "false").lower() == "true"

    zc = (f'python tools/zone_check.py --staged '
          f'--allow "{",".join(allow)}"')
    if deny:
        zc += f' --deny "{",".join(deny)}"'

    parts = [zc]
    if test_cmd:
        parts.append(test_cmd)
    elif not gate_optional:
        # нет тестовой команды и задача не gate-optional → зона всё равно энфорсится (zc),
        # но предупредим, что корректностной проверки нет.
        parts.append('echo "WARN: нет test-cmd; гейт = только zone_check"')

    gate_cmd = " && ".join(parts)
    out = Path(".workflow/gate.cmd")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(gate_cmd + "\n", encoding="utf-8")
    print(f"gate.cmd записан ({tp.name}):")
    print("  " + gate_cmd)
    return 0


if __name__ == "__main__":
    sys.exit(main())
