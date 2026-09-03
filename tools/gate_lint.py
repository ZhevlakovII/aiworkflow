#!/usr/bin/env python3
"""
gate_lint.py — детерминированный two-stage gate (INV-4). Модель-агностичен.

Зачем: LLM-lead делает движения гейта и рационализирует дефекты в PASS
(P2-probe: Qwen нашёл сфабрикованный SP-point и всё равно штампанул). Код не рационализирует.

Gate-1 (source ↔ spec): каждый SP-point несёт source-ref, который резолвится в реальные
                         непустые строки task-file. Отсутствие/битый ref → BOUNCE.
Gate-2 (spec ↔ ADR):     каждый SP покрыт ≥1 AD.covers ИЛИ помечен gap: true.
                         Каждый id в AD.covers существует в spec (нет фантомных). Иначе BOUNCE.

Формат артефактов (строгий, парсится без PyYAML) — fenced-блоки:

  ```spec
  id: SP-bounded-memory
  source: docs/tasks/foo.md#L20-L22
  statement: cache must not grow unbounded
  gap: false            # опц.; true = осознанно без покрытия
  ```

  ```adr
  id: AD-eviction
  covers: SP-bounded-memory, SP-stale-rejection
  statement: TTL-based eviction
  ```

Usage:
  python tools/gate_lint.py --task <task.md> --spec <spec.md> --adr <adr.md>
Exit: 0 = PASS, 1 = BOUNCE (дефекты), 2 = ошибка ввода.
"""
from __future__ import annotations
import argparse
import re
import sys
from pathlib import Path

# Windows-консоль по умолчанию cp1251 → форсим UTF-8, иначе не-ASCII глифы падают.
try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
except Exception:
    pass

BLOCK_RE = re.compile(r"```(spec|adr|fr)\s*\n(.*?)```", re.DOTALL)
SRC_RE = re.compile(r"^(?P<file>[^#]+)#L(?P<start>\d+)(?:-L?(?P<end>\d+))?$")
SHALL_RE = re.compile(r"\bshall\b", re.IGNORECASE)


def parse_blocks(md_path: Path, kind: str) -> list[dict]:
    """Вытащить fenced-блоки заданного вида, распарсить `key: value` строки."""
    text = md_path.read_text(encoding="utf-8")
    out: list[dict] = []
    for m in BLOCK_RE.finditer(text):
        if m.group(1) != kind:
            continue
        entry: dict[str, str] = {}
        for line in m.group(2).splitlines():
            line = line.split("#", 1)[0].rstrip() if kind == "adr" else line
            # для spec/fr не режем # (source содержит #Lx); режем только трейлинг-коммент после ' # '
            if kind in ("spec", "fr"):
                line = re.sub(r"\s+#\s.*$", "", line.rstrip())
            if ":" not in line:
                continue
            k, v = line.split(":", 1)
            entry[k.strip()] = v.strip()
        if entry.get("id"):
            out.append(entry)
    return out


def ears_check(fr: dict) -> str:
    """EARS-синтакс FR-блока (ядро-3). Возвращает finding-msg или '' (валиден)."""
    pat = fr.get("pattern", "").lower().strip()
    st = fr.get("statement", "").strip()
    if not st:
        return "нет statement"
    shall = SHALL_RE.search(st)
    if not shall:
        return f"EARS: нет \"SHALL\" ({st!r})"
    response = st[shall.end():].strip()
    if not response:
        return "EARS: пустой response после SHALL"
    before = st[:shall.start()]
    if pat == "ubiquitous":
        if re.match(r"\s*(WHEN|WHILE|IF)\b", st, re.IGNORECASE):
            return "EARS ubiquitous: не должно быть WHEN/WHILE/IF в начале"
        return ""
    if pat == "event":
        if not re.match(r"\s*WHEN\b", st, re.IGNORECASE):
            return "EARS event: должно начинаться с WHEN"
        trig = re.sub(r"\bthe\s+system\s*$", "", re.sub(r"^\s*WHEN\b", "", before, flags=re.IGNORECASE), flags=re.IGNORECASE).strip()
        if not trig:
            return "EARS event: пустой trigger между WHEN и SHALL"
        return ""
    if pat == "unwanted":
        if not re.match(r"\s*IF\b", st, re.IGNORECASE):
            return "EARS unwanted: должно начинаться с IF"
        if not re.search(r"\bTHEN\b", before, re.IGNORECASE):
            return "EARS unwanted: нет THEN перед SHALL"
        cond = re.sub(r"\bTHEN\b[\s\S]*$", "", re.sub(r"^\s*IF\b", "", before, flags=re.IGNORECASE), flags=re.IGNORECASE).strip()
        if not cond:
            return "EARS unwanted: пустое условие между IF и THEN"
        return ""
    return f"EARS: неизвестный pattern {pat!r} (ожидается ubiquitous|event|unwanted)"


def check_source_ref(ref: str, repo_root: Path) -> tuple[bool, str]:
    """Резолвится ли source-ref в реальные непустые строки."""
    mm = SRC_RE.match(ref.strip())
    if not mm:
        return False, f"source не в формате <file>#Lx[-Ly]: {ref!r}"
    f = (repo_root / mm.group("file")).resolve()
    if not f.exists():
        return False, f"source-file не найден: {mm.group('file')}"
    lines = f.read_text(encoding="utf-8").splitlines()
    start = int(mm.group("start"))
    end = int(mm.group("end") or start)
    if start < 1 or end > len(lines) or start > end:
        return False, f"диапазон L{start}-L{end} вне файла (всего {len(lines)} строк)"
    body = "\n".join(lines[start - 1:end]).strip()
    if not body:
        return False, f"строки L{start}-L{end} пусты"
    return True, body


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--task", required=True)
    ap.add_argument("--spec", required=True)
    ap.add_argument("--adr", required=True)
    ap.add_argument("--repo-root", default=".")
    args = ap.parse_args()

    repo_root = Path(args.repo_root).resolve()
    spec_p, adr_p = Path(args.spec), Path(args.adr)
    for p in (Path(args.task), spec_p, adr_p):
        if not p.exists():
            print(f"ERROR: файл не найден: {p}", file=sys.stderr)
            return 2

    sps = parse_blocks(spec_p, "spec")
    ads = parse_blocks(adr_p, "adr")
    frs = parse_blocks(spec_p, "fr")   # FR живёт в spec (problem-space: WHAT система делает)
    findings: list[str] = []

    if not sps:
        findings.append("SPEC: не найдено ни одного ```spec-блока (формат нарушен)")
    if not ads:
        findings.append("ADR: не найдено ни одного ```adr-блока (формат нарушен)")

    # Gate-1: SP ↔ source
    sp_ids: set[str] = set()
    for sp in sps:
        sid = sp["id"]
        sp_ids.add(sid)
        src = sp.get("source", "")
        if not src:
            findings.append(f"G1 {sid}: нет source-ref")
            continue
        ok, msg = check_source_ref(src, repo_root)
        if not ok:
            findings.append(f"G1 {sid}: {msg}")

    # Gate-2: SP ↔ AD coverage
    covered: set[str] = set()
    for ad in ads:
        aid = ad["id"]
        covers = [c.strip() for c in ad.get("covers", "").split(",") if c.strip()]
        if not covers:
            findings.append(f"G2 {aid}: covers пуст (решение ничего не покрывает)")
        for c in covers:
            if c not in sp_ids:
                findings.append(f"G2 {aid}: covers ссылается на несуществующий {c} (фантом)")
            else:
                covered.add(c)
    for sp in sps:
        sid = sp["id"]
        if sid not in covered and sp.get("gap", "").lower() != "true":
            findings.append(f"G2 {sid}: не покрыт ни одним AD и не помечен gap:true")

    # Gate-3: FR ↔ source + EARS-синтакс (FR условен — пусто = OK, линтим только имеющиеся)
    for fr in frs:
        fid = fr["id"]
        src = fr.get("source", "")
        if not src:
            findings.append(f"G1 {fid}: FR нет source-ref")
        else:
            ok, msg = check_source_ref(src, repo_root)
            if not ok:
                findings.append(f"G1 {fid}: {msg}")
        e = ears_check(fr)
        if e:
            findings.append(f"G3 {fid}: {e}")

    print(f"SP-points: {len(sps)} | AD-decisions: {len(ads)} | FR-points: {len(frs)} | findings: {len(findings)}")
    for f in findings:
        print("  [x] " + f)
    if findings:
        print("GATE: BOUNCE")
        return 1
    print("GATE: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
