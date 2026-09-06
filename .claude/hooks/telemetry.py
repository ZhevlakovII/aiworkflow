#!/usr/bin/env python3
"""
telemetry.py — Claude Code PostToolUse hook. Порт OMP omp-telemetry (best-effort NDJSON).

Пишет .workflow/telemetry.ndjson (kind:tool) — какой тул, успех, размер ответа.
Не влияет на поток: любая ошибка глотается (fail-silent), exit 0 всегда.
Ротация при ≥20MB (как в OMP). Off: env AIWF_TELEMETRY_OFF=1.
"""
from __future__ import annotations
import json
import os
import sys
import time
from pathlib import Path

MAX_BYTES = 20 * 1024 * 1024


def project_root(data: dict) -> Path:
    """Target-project cwd из stdin (не clone). Location-independent."""
    c = data.get("cwd")
    if c:
        return Path(c).resolve()
    p = Path(__file__).resolve()
    for anc in [p, *p.parents]:
        if (anc / ".omp").is_dir() or (anc / ".git").is_dir():
            return anc
    return Path.cwd()


def main() -> None:
    if os.environ.get("AIWF_TELEMETRY_OFF") == "1":
        return
    try:
        data = json.load(sys.stdin)
    except Exception:
        return
    try:
        resp = data.get("tool_response")
        ok = True
        if isinstance(resp, dict):
            ok = not (resp.get("is_error") or resp.get("error"))
        rec = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "kind": "tool",
            "tool": data.get("tool_name", ""),
            "ok": ok,
        }
        wf = project_root(data) / ".workflow"
        wf.mkdir(exist_ok=True)
        f = wf / "telemetry.ndjson"
        if f.exists() and f.stat().st_size >= MAX_BYTES:
            f.rename(wf / f"telemetry.{int(time.time())}.ndjson")
        with f.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception:
        pass  # fail-silent


if __name__ == "__main__":
    main()
    sys.exit(0)
