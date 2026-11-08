/**
 * stats-cli (T7-5) — TS port of `tools/stats.py`'s CLI shell: `--path FILE`
 * (default `~/.omp/agent/telemetry.ndjson`), `--json` (raw aggregates),
 * `--csv FILE` (export run-rows), `--tid <id>` (drill-down). No data at all
 * (path missing / empty) -> stderr `нет данных: <path>`, exit 1 — same as
 * the Python original.
 *
 * Pure-core + thin-shell split (contract L-1, same pattern as
 * `../zone/zone-check{,-cli}.ts`): `runStatsCli(argv, deps)` is the
 * injectable, testable layer built on `./stats.ts`. `main` is the real
 * fs/argv/process.exit shell (not unit-tested, same as `../zone/zone-check-cli.ts`).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { load, summarize, render, drill, exportCsv } from "./stats.ts";

export interface StatsCliDeps {
  exists(p: string): boolean;
  readFile(p: string): string;
  writeFile(p: string, content: string): void;
  homedir(): string;
}

export interface StatsCliOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ParsedArgs {
  path?: string;
  json: boolean;
  csv?: string;
  tid?: string;
}

function parseArgv(argv: readonly string[]): { parsed?: ParsedArgs; error?: string } {
  const parsed: ParsedArgs = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--path") {
      const v = argv[++i];
      if (v === undefined) return { error: "--path: требуется значение" };
      parsed.path = v;
    } else if (a === "--json") {
      parsed.json = true;
    } else if (a === "--csv") {
      const v = argv[++i];
      if (v === undefined) return { error: "--csv: требуется значение" };
      parsed.csv = v;
    } else if (a === "--tid") {
      const v = argv[++i];
      if (v === undefined) return { error: "--tid: требуется значение" };
      parsed.tid = v;
    } else {
      return { error: `неизвестный аргумент: ${a}` };
    }
  }
  return { parsed };
}

/** argv -> path resolution -> `load`/`summarize`/`render`/`drill`/`exportCsv` -> `{stdout, stderr, exitCode}` (contract L-1 output/exit parity). */
export function runStatsCli(argv: readonly string[], deps: StatsCliDeps): StatsCliOutput {
  const { parsed, error } = parseArgv(argv);
  if (error || !parsed) {
    return { stdout: "", stderr: error ?? "usage error", exitCode: 2 };
  }

  const rawPath = parsed.path ?? path.join(deps.homedir(), ".omp", "agent", "telemetry.ndjson");
  const text = deps.exists(rawPath) ? deps.readFile(rawPath) : "";
  const { runs, guards } = load(text);

  if (!runs.length && !guards.length) {
    return { stdout: "", stderr: `нет данных: ${rawPath}`, exitCode: 1 };
  }

  if (parsed.csv) {
    const csv = exportCsv(runs);
    deps.writeFile(parsed.csv, csv);
    return { stdout: `CSV: ${runs.length} run-строк → ${parsed.csv}`, stderr: "", exitCode: 0 };
  }

  if (parsed.tid) {
    return { stdout: drill(parsed.tid, runs, guards), stderr: "", exitCode: 0 };
  }

  const s = summarize(runs, guards);
  const stdout = parsed.json ? JSON.stringify(s, null, 2) : render(s);
  return { stdout, stderr: "", exitCode: 0 };
}

// ---------------------------------------------------------------------------
// main — thin I/O shell (NOT unit-tested, same pattern as ../zone/zone-check-cli.ts)
// ---------------------------------------------------------------------------

function prodDeps(): StatsCliDeps {
  return {
    exists: fs.existsSync,
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
    homedir: () => os.homedir(),
  };
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const { stdout, stderr, exitCode } = runStatsCli(argv, prodDeps());
  if (stdout) process.stdout.write(stdout + "\n");
  if (stderr) process.stderr.write(stderr + "\n");
  process.exit(exitCode);
}

// Direct-run guard (`node core/src/ops/stats-cli.ts --path ...`) — inert
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
