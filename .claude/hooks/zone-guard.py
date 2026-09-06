#!/usr/bin/env python3
"""
zone-guard.py — Claude Code PreToolUse hook. Порт OMP zone-guard + raw-git deny.

Enforcement-слой CC-порта (docs/design/omp-to-claude-code-port-2026-09-06.md §4):
детерминированный рельс, держит независимо от режима/модели.

Блокирует (permissionDecision=deny, со стир-месседжем модели):
  - write/edit в .git/ и .omp/  (protected paths; .workflow — ledger lead'а, разрешён)
  - raw git-МУТАЦИИ через Bash (commit/add/push/merge/reset/checkout/restore/clean/
    stash/rm) → стир к нативным рельсам gated_commit/push/merge (python tools/*.py).
    git READ (status/diff/log/rev-parse/show/branch) — разрешён.
  - pipe-to-shell (| sh|bash), nc, ssh, rm -rf → hard deny (security).
  - bash-запись/удаление под .git|.omp (>, tee, rm, mv, cp target).

НЕ трогает python-рельсы: gated_commit.py зовёт git через subprocess (не Bash-тул),
хук их не видит — как pi.exec в OMP.

Контракт CC: stdin JSON {tool_name, tool_input, ...}; stdout JSON
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":..,"permissionDecisionReason":..}}.
Тихий allow — exit 0 без вывода. Ошибка хука не должна ломать поток → fail-open.
"""
from __future__ import annotations
import json
import re
import sys
from pathlib import Path


_PROJECT_ROOT: Path | None = None


def set_project_root(data: dict) -> None:
    """Project root = target-project cwd из stdin (не clone, где лежит хук).
    Делает хук location-independent → можно ставить глобально и обслуживать любой проект."""
    global _PROJECT_ROOT
    c = data.get("cwd")
    if c:
        _PROJECT_ROOT = Path(c).resolve()
        return
    p = Path(__file__).resolve()
    for anc in [p, *p.parents]:
        if (anc / ".omp").is_dir() or (anc / ".git").is_dir():
            _PROJECT_ROOT = anc
            return
    _PROJECT_ROOT = p.parents[2]


def repo_root() -> Path:
    return _PROJECT_ROOT if _PROJECT_ROOT is not None else Path.cwd()


def deny(reason: str) -> None:
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }))
    sys.exit(0)


PROTECTED = (".git", ".omp")  # .workflow разрешён (ledger lead'а)

# git-мутации (первое слово подкоманды). READ-подкоманды НЕ здесь → разрешены.
GIT_MUT = re.compile(r"\bgit\s+(commit|add|push|merge|reset|checkout|restore|clean|stash|rm|apply|cherry-pick|rebase|tag|branch\s+-[dD])\b")
RAIL = {
    "commit": "gated_commit → `python tools/gated_commit.py -m \"...\" [--gate <cmd>]`",
    "push": "gated_push → `python tools/gated_push.py [--pr --base <b>]`",
    "merge": "gated_merge → `python tools/gated_merge.py --branch <b> [--class <c>]`",
}
PIPE_SHELL = re.compile(r"\|\s*(sh|bash)\b")
NC_SSH = re.compile(r"(^|[;&|]\s*)(nc|ssh)\s")
RM_RF = re.compile(r"\brm\s+(-\w*r\w*f|-\w*f\w*r|-rf|-fr)\b")
BASH_WRITE_PROTECTED = re.compile(r"(>>?|tee\s+|\brm\s+|\bmv\s+|\bcp\s+)[^\n]*\.(git|omp)\b")


def check_path(path: str) -> None:
    if not path:
        return
    root = repo_root()
    try:
        rel = Path(path).resolve().relative_to(root)
        parts = rel.parts
    except Exception:
        # вне репо — не наша зона
        return
    if parts and parts[0] in PROTECTED:
        deny(f"zone-guard: запись в protected-путь `{parts[0]}/` запрещена. "
             f".git/.omp неприкосновенны; ledger lead'а пиши в .workflow/. "
             f"Код/контент — через worker в его allow-зоне.")


def check_bash(cmd: str) -> None:
    if PIPE_SHELL.search(cmd):
        deny("zone-guard: pipe-to-shell (download→exec) запрещён.")
    if NC_SSH.search(cmd):
        deny("zone-guard: nc/ssh запрещены (exfil/reverse-shell surface).")
    if RM_RF.search(cmd):
        deny("zone-guard: `rm -rf` запрещён.")
    if BASH_WRITE_PROTECTED.search(cmd):
        deny("zone-guard: bash-запись/удаление под .git|.omp запрещена.")
    m = GIT_MUT.search(cmd)
    if m:
        sub = m.group(1).split()[0]
        rail = RAIL.get(sub)
        if rail:
            deny(f"zone-guard: raw `git {sub}` заблокирован — коммить/пушь/мёржи "
                 f"ТОЛЬКО через рельс: {rail}. Рельс делает zone-check staged + "
                 f"test-cmd/probe (детерминир. enforcement на чокпоинте).")
        deny(f"zone-guard: raw git-мутация `git {sub}` запрещена (рельсы держат "
             f"дерево чистым; используй gated_commit/push/merge или читай состояние).")


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)  # fail-open
    set_project_root(data)
    tool = data.get("tool_name", "")
    ti = data.get("tool_input", {}) or {}
    try:
        if tool in ("Write", "Edit", "MultiEdit", "NotebookEdit"):
            check_path(ti.get("file_path") or ti.get("notebook_path") or "")
        elif tool == "Bash":
            check_bash(ti.get("command", "") or "")
    except SystemExit:
        raise
    except Exception:
        sys.exit(0)  # fail-open на неожиданном
    sys.exit(0)


if __name__ == "__main__":
    main()
