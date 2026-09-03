#!/usr/bin/env python3
"""
archive_spec.py — delta→archive живая спека (P9 B.2). Накапливает requirements
(SP + FR блоки) из завершённого change-spec в канонический `docs/spec/<capability>.md`.

Топология (маппинг на существующее): change-unit = task-file + docs/design/<id>-{spec,adr}.
Канон-слой = docs/spec/<capability>.md (накопительный, копит ```spec/```fr с `from:<change>`).
ADR (solution-space) в канон НЕ идёт — канон = requirements (problem-space), AD остаётся пофично.

Merge = ГИБРИД ID+модель (детерминир. common-path + модель на трудное):
  - id нет в каноне            → ADD (с провенансом from:<change-id>)
  - id есть, statement равен    → SKIP (no-op)
  - id есть, statement различен → COLLISION
      · без --reconcile: репорт + non-zero exit (человек/next-step решает)
      · с  --reconcile: claude -p примиряет (supersede/merge) — B.2b слой

Usage:
  python tools/archive_spec.py --change docs/design/<id>-spec.md [--capability system]
                               [--spec-dir docs/spec] [--reconcile] [--model sonnet]
Exit: 0 = merge чист (нет нерешённых коллизий); 1 = нерешённые коллизии; 2 = ошибка ввода.
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
BLOCK_RE = re.compile(r"```(spec|adr|fr)\s*\n(.*?)```", re.DOTALL)
REQ_KINDS = ("spec", "fr")   # канон = requirements (SP+FR); adr не архивируем


def parse_blocks_raw(text: str, kinds: tuple[str, ...]) -> list[tuple[str, dict, str]]:
    """→ list of (kind, fields, raw_body). Сохраняет тело блока дословно (провенанс/формат)."""
    out: list[tuple[str, dict, str]] = []
    for m in BLOCK_RE.finditer(text):
        kind = m.group(1)
        if kind not in kinds:
            continue
        body = m.group(2)
        fields: dict[str, str] = {}
        for line in body.splitlines():
            ln = re.sub(r"\s+#\s.*$", "", line.rstrip())  # spec/fr: source содержит #Lx → режем только ' # '
            if ":" in ln:
                k, v = ln.split(":", 1)
                fields[k.strip()] = v.strip()
        if fields.get("id"):
            out.append((kind, fields, body.rstrip("\n")))
    return out


def inject_from(body: str, change_id: str) -> str:
    """Вставить `from: <change-id>` после строки id: (если ещё нет)."""
    if re.search(r"^\s*from:", body, re.MULTILINE):
        return body
    out: list[str] = []
    for line in body.split("\n"):
        out.append(line)
        if re.match(r"\s*id:", line):
            out.append(f"from: {change_id}")
    return "\n".join(out)


def emit_canon(capability: str, blocks: list[tuple[str, str]]) -> str:
    """blocks = list of (kind, raw_body). Собрать канонический markdown."""
    parts = [
        f"# Living spec: {capability}",
        "",
        "_Накопительная система-спека (P9 B.2, archive_spec). Копится merge'ем из change-specs "
        "по FR/SP-id. НЕ редактировать вручную — источник истины = change-specs + этот merge._",
        "",
    ]
    for kind, body in blocks:
        parts.append(f"```{kind}")
        parts.append(body)
        parts.append("```")
        parts.append("")
    return "\n".join(parts).rstrip() + "\n"


def reconcile(model: str, cid: str, old_body: str, new_body: str) -> str | None:
    """B.2b: claude -p примиряет коллизию → reconciled body (или None при ошибке)."""
    prompt = (
        "Две версии одного requirement-блока (совпал id, разошёлся statement). "
        "Реши: какая актуальна, или слей. Верни ОДИН fenced-блок того же вида "
        "(```spec или ```fr) с корректными полями (id/from/source/statement[/pattern]). "
        f"Новее — из change '{cid}'.\n\nСТАРЫЙ:\n{old_body}\n\nНОВЫЙ:\n{new_body}"
    )
    cmd = ["claude", "-p", prompt, "--model", model, "--output-format", "json",
           "--allowedTools", "", "--add-dir", str(REPO)]
    try:
        r = subprocess.run(cmd, cwd=str(REPO), text=True, capture_output=True,
                           encoding="utf-8", errors="replace", timeout=300)
    except Exception as e:  # noqa: BLE001
        print(f"  reconcile: claude недоступен ({e})", file=sys.stderr)
        return None
    if r.returncode != 0:
        return None
    import json
    try:
        result = json.loads(r.stdout).get("result", "")
    except Exception:  # noqa: BLE001
        result = r.stdout
    mm = BLOCK_RE.search(result)
    return mm.group(2).rstrip("\n") if mm else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--change", required=True, help="change-spec (docs/design/<id>-spec.md)")
    ap.add_argument("--capability", default="system", help="канон-файл docs/spec/<cap>.md")
    ap.add_argument("--spec-dir", default="docs/spec")
    ap.add_argument("--reconcile", action="store_true", help="claude -p примиряет коллизии (B.2b)")
    ap.add_argument("--model", default="sonnet")
    args = ap.parse_args()

    change_p = Path(args.change).resolve()
    if not change_p.exists():
        print(f"ERROR: change-spec не найден: {change_p}", file=sys.stderr)
        return 2
    change_id = change_p.stem.replace("-spec", "")
    canon_p = (REPO / args.spec_dir / f"{args.capability}.md").resolve()

    incoming = parse_blocks_raw(change_p.read_text(encoding="utf-8"), REQ_KINDS)
    if not incoming:
        print(f"change '{change_id}': нет SP/FR-блоков для архива — nothing to merge")
        return 0

    canon_blocks: list[tuple[str, str]] = []   # (kind, raw_body), сохраняем порядок
    canon_by_id: dict[str, int] = {}
    if canon_p.exists():
        for kind, fields, body in parse_blocks_raw(canon_p.read_text(encoding="utf-8"), REQ_KINDS):
            canon_by_id[fields["id"]] = len(canon_blocks)
            canon_blocks.append((kind, body))

    def stmt(body: str) -> str:
        m = re.search(r"^\s*statement:\s*(.+?)\s*$", body, re.MULTILINE)
        return (m.group(1).strip() if m else "").strip()

    added, skipped, collisions, reconciled = [], [], [], []
    for kind, fields, body in incoming:
        fid = fields["id"]
        new_body = inject_from(body, change_id)
        if fid not in canon_by_id:
            canon_by_id[fid] = len(canon_blocks)
            canon_blocks.append((kind, new_body))
            added.append(fid)
            continue
        idx = canon_by_id[fid]
        if stmt(canon_blocks[idx][1]) == stmt(new_body):
            skipped.append(fid)
            continue
        # COLLISION
        if args.reconcile:
            merged = reconcile(args.model, change_id, canon_blocks[idx][1], new_body)
            if merged:
                canon_blocks[idx] = (kind, inject_from(merged, change_id))
                reconciled.append(fid)
                continue
        collisions.append(fid)

    canon_p.parent.mkdir(parents=True, exist_ok=True)
    canon_p.write_text(emit_canon(args.capability, canon_blocks), encoding="utf-8")

    try:
        rel = canon_p.relative_to(REPO).as_posix()
    except ValueError:
        rel = str(canon_p)   # канон вне репо (напр. в тесте) — показываем абсолютный
    print(f"archive '{change_id}' → {rel} (capability={args.capability})")
    print(f"  ADD:{len(added)} SKIP:{len(skipped)} RECONCILED:{len(reconciled)} COLLISION:{len(collisions)}")
    for fid in added:
        print(f"    + {fid}")
    for fid in reconciled:
        print(f"    ~ {fid} (reconciled)")
    for fid in collisions:
        print(f"    ! {fid} (COLLISION — statement различается, не решено)")
    if collisions:
        print("ARCHIVE: BLOCKED (нерешённые коллизии — запусти с --reconcile или разведи id вручную)")
        return 1
    print("ARCHIVE: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
