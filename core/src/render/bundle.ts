/**
 * core/src/render/bundle.ts — core-bundle emitter (T5c-1).
 *
 * Model A (locked, user 2026-09-19): in-process shims (OMP/OpenCode) get the
 * TS-core via a render-bundle — the engine copies `core/src` byte-for-byte
 * into `<client-dir>/_core/` (dist-style), the shim imports its OWN copy.
 * Preserves the build-vs-run invariant (runtime only ever reads its own
 * directory). Closes the shim/seed emission T3 deferred to T5 (T3 L-1).
 *
 * L-2 (contract): reuses `writeIfChanged` (C4 idempotency) from `engine.ts` —
 * does NOT duplicate walk/write/compare.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import nodePath from "node:path";

import { writeIfChanged } from "./engine.ts";
import type { RenderReport } from "./engine.ts";

const posixPath = nodePath.posix;

function normalizeRoot(p: string): string {
  const n = p.replace(/\\/g, "/");
  return n.length > 1 ? n.replace(/\/+$/, "") : n;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Sorted recursive walk of `.ts` files under `root` (mirrors engine.ts'
 * `walkFiles` determinism: sorted per-directory, then whole-list sorted). */
function walkTsFiles(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    if (!isDir(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = posixPath.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(p);
    }
  }
  walk(root);
  return out.sort();
}

/**
 * Recursively copies every `.ts` file under `coreSrcRoot` into `outCoreDir`,
 * preserving the relative directory structure (so relative imports like
 * `../classify/x.ts` keep resolving inside the copy). Idempotency is
 * delegated to `writeIfChanged` (C4) — a re-run with no source changes writes
 * nothing (`report.written` stays empty, `report.unchanged` grows).
 *
 * Returns the absolute paths of every file the bundle claims (written OR
 * unchanged this run) — the caller (`render()`) adds these to its `claimed`
 * set so the bundle never shows up in `report.unmanaged`.
 */
export function bundleCore(
  coreSrcRoot: string,
  outCoreDir: string,
  report: RenderReport,
  labelPrefix: string
): string[] {
  const srcRoot = normalizeRoot(coreSrcRoot);
  const dstRoot = normalizeRoot(outCoreDir);
  const claimed: string[] = [];

  for (const srcFile of walkTsFiles(srcRoot)) {
    const rel = srcFile.slice(srcRoot.length).replace(/^\/+/, "");
    const dstFile = posixPath.join(dstRoot, rel);
    const label = `${labelPrefix}/${rel}`;
    const content = readFileSync(srcFile, "utf-8");
    writeIfChanged(dstFile, content, report, label);
    claimed.push(dstFile);
  }

  return claimed;
}
