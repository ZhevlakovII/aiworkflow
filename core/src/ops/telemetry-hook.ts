/**
 * telemetry-hook (T7-5, contract L-2) — Claude Code PostToolUse hook, TS
 * port of `.claude/hooks/telemetry.py`. Best-effort NDJSON (`kind:tool` —
 * which tool, ok/not, timestamp) appended to `<project>/.workflow/
 * telemetry.ndjson`. NEVER blocks / never throws out of `main` — any error
 * is swallowed, exit is ALWAYS 0 (fail-silent, same as the Python original's
 * `main(); sys.exit(0)`). Writes NOTHING to stdout that CC could mistake for
 * a hook decision. Fast: no heavy imports beyond `node:fs`/`node:path`
 * (contract L-2 "no heavy imports").
 *
 * Off-switch: env `AIWF_TELEMETRY_OFF=1`, checked BEFORE stdin is even read
 * (same as Python's early-return — skips the stdin-read cost when disabled).
 *
 * Project-root resolution mirrors Python's `project_root()`: prefer
 * `data.cwd` from the PostToolUse payload (the TARGET project's cwd, not
 * this repo's own clone dir); else walk up from this script's own directory
 * looking for a sibling `.omp/` or `.git/`; final fallback `process.cwd()`.
 * (Python's `p = Path(__file__).resolve()` then iterates `[p, *p.parents]` —
 * the first candidate is the FILE itself, which never has a `.omp`/`.git`
 * child, so it is effectively a no-op; walking from the file's containing
 * directory here is the same search.)
 *
 * Rotation: same threshold as Python/OMP (`MAX_BYTES` = 20MB) — file renamed
 * to `telemetry.<epoch-seconds>.ndjson` before the new line is appended.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { MAX_BYTES, buildRecord, type TelemetryHookInput } from "./telemetry.ts";

export interface TelemetryHookDeps {
  exists(p: string): boolean;
  mkdirp(p: string): void;
  statSize(p: string): number;
  rename(from: string, to: string): void;
  appendLine(p: string, line: string): void;
  /** Directory this script physically lives in — walked up for the `.omp`/`.git` fallback. */
  scriptDir: string;
  now(): Date;
}

function resolveProjectRoot(data: TelemetryHookInput, deps: TelemetryHookDeps): string {
  if (data.cwd) return path.resolve(data.cwd);
  let dir = deps.scriptDir;
  for (;;) {
    if (deps.exists(path.join(dir, ".omp")) || deps.exists(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/**
 * Injectable core (contract-testable): parses `stdinText`, resolves the
 * project root, rotates if needed, appends the record. Never throws — every
 * failure is swallowed (fail-silent, same as Python). Returns the written
 * file path, or `null` if nothing was written (off / bad JSON / any error).
 */
export function runTelemetryHook(stdinText: string, deps: TelemetryHookDeps): string | null {
  if (process.env.AIWF_TELEMETRY_OFF === "1") return null;
  let data: TelemetryHookInput;
  try {
    data = JSON.parse(stdinText) as TelemetryHookInput;
  } catch {
    return null;
  }
  try {
    const record = buildRecord(data, deps.now());
    const root = resolveProjectRoot(data, deps);
    const wf = path.join(root, ".workflow");
    deps.mkdirp(wf);
    const f = path.join(wf, "telemetry.ndjson");
    if (deps.exists(f) && deps.statSize(f) >= MAX_BYTES) {
      deps.rename(f, path.join(wf, `telemetry.${Math.floor(Date.now() / 1000)}.ndjson`));
    }
    deps.appendLine(f, JSON.stringify(record) + "\n");
    return f;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// main — thin I/O shell (NOT unit-tested, same pattern as ../zone/zone-check-cli.ts)
// ---------------------------------------------------------------------------

function prodDeps(): TelemetryHookDeps {
  return {
    exists: fs.existsSync,
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
    statSize: (p) => fs.statSync(p).size,
    rename: (a, b) => fs.renameSync(a, b),
    appendLine: (p, line) => fs.appendFileSync(p, line, "utf-8"),
    scriptDir: path.dirname(fileURLToPath(import.meta.url)),
    now: () => new Date(),
  };
}

function readStdinSync(): string {
  try {
    return fs.readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

export function main(): void {
  try {
    if (process.env.AIWF_TELEMETRY_OFF !== "1") {
      const stdinText = readStdinSync();
      runTelemetryHook(stdinText, prodDeps());
    }
  } catch {
    // fail-silent (contract L-2) — never throw out of the hook.
  }
  process.exit(0);
}

// Direct-run guard (`node core/src/ops/telemetry-hook.ts` < json) — inert
// under `node --test` / plain `import` (same pattern as `../zone/zone-check-cli.ts`).
if (process.argv[1]) {
  let isDirectRun = false;
  try {
    isDirectRun = fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    isDirectRun = false;
  }
  if (isDirectRun) {
    main();
  }
}
