#!/usr/bin/env python3
"""Extract a zip, normalizing backslash member names to forward slashes.

CLI: python tools/extract-zip.py <zip> <dest>
Stdlib only. Rejects absolute member names and any '..' segment.
Skips directory entries. Creates parent directories for files.
"""

from __future__ import annotations

import sys
import zipfile
from pathlib import Path


def normalize_member(name: str) -> str:
    """Return a relative forward-slash path, or raise SystemExit."""
    norm = name.replace("\\", "/")
    if norm.startswith("/") or norm.startswith("//"):
        raise SystemExit("refusing absolute zip member")
    if len(norm) >= 2 and norm[1] == ":":
        raise SystemExit("refusing absolute zip member")
    parts: list[str] = []
    for seg in norm.split("/"):
        if seg == "" or seg == ".":
            continue
        if seg == "..":
            raise SystemExit("refusing zip member with ..")
        parts.append(seg)
    return "/".join(parts)


def _is_dir_entry(info: zipfile.ZipInfo) -> bool:
    name = info.filename
    if name.endswith("/") or name.endswith("\\"):
        return True
    return info.is_dir()


def extract_zip(zip_path: str, dest: str) -> None:
    dest_path = Path(dest)
    dest_path.mkdir(parents=True, exist_ok=True)
    dest_root = dest_path.resolve()
    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            if _is_dir_entry(info):
                continue
            rel = normalize_member(info.filename)
            if not rel:
                continue
            out = dest_path.joinpath(*rel.split("/"))
            out.parent.mkdir(parents=True, exist_ok=True)
            try:
                out.resolve().relative_to(dest_root)
            except ValueError:
                raise SystemExit("refusing zip member that escapes dest")
            with zf.open(info, "r") as src, out.open("wb") as dst:
                while True:
                    chunk = src.read(1024 * 1024)
                    if not chunk:
                        break
                    dst.write(chunk)


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: python tools/extract-zip.py <zip> <dest>", file=sys.stderr)
        return 2
    extract_zip(argv[1], argv[2])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
