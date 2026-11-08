/**
 * gate-lint-cli (T7-3) — TS port of `tools/gate_lint.py`'s CLI shell:
 * `--task <p> --spec <p> --adr <p> [--repo-root <p>]` (repo-root defaults to
 * `"."`). Output: `SP-points: N | AD-decisions: M | FR-points: K | findings: F`,
 * one `  [x] ...` line per finding, final `GATE: PASS` / `GATE: BOUNCE`.
 * Exit 0 (clean) / 1 (findings) / 2 (missing file / usage) — same mapping as
 * the Python original.
 *
 * Pure-core + thin-shell split (same pattern as `../zone/zone-check-cli.ts`):
 * `runGateLintCli(argv, deps)` is the injectable, testable argv-parsing
 * layer built on the pure `gateLint` (`./gate-lint.ts`). `main` is the real
 * argv/process.exit shell (not unit-tested).
 */
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

import { gateLint } from "./gate-lint.ts";

export interface GateLintCliDeps {
  /** Injectable existence-check (contract: testable without touching real fs). Defaults to `fs.existsSync`. */
  exists(p: string): boolean;
}

export interface GateLintCliOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ParsedArgs {
  task?: string;
  spec?: string;
  adr?: string;
  repoRoot: string;
}

function parseArgv(argv: readonly string[]): { parsed?: ParsedArgs; error?: string } {
  let task: string | undefined;
  let spec: string | undefined;
  let adr: string | undefined;
  let repoRoot = ".";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--task") {
      const v = argv[++i];
      if (v === undefined) return { error: "--task: требуется значение" };
      task = v;
    } else if (a === "--spec") {
      const v = argv[++i];
      if (v === undefined) return { error: "--spec: требуется значение" };
      spec = v;
    } else if (a === "--adr") {
      const v = argv[++i];
      if (v === undefined) return { error: "--adr: требуется значение" };
      adr = v;
    } else if (a === "--repo-root") {
      const v = argv[++i];
      if (v === undefined) return { error: "--repo-root: требуется значение" };
      repoRoot = v;
    } else {
      return { error: `неизвестный аргумент: ${a}` };
    }
  }
  if (!task) return { error: "--task: обязателен" };
  if (!spec) return { error: "--spec: обязателен" };
  if (!adr) return { error: "--adr: обязателен" };
  return { parsed: { task, spec, adr, repoRoot } };
}

/** argv -> file-existence check -> `gateLint` -> formatted `{stdout, stderr, exitCode}` (Python-parity). */
export function runGateLintCli(argv: readonly string[], deps: GateLintCliDeps): GateLintCliOutput {
  const { parsed, error } = parseArgv(argv);
  if (error || !parsed) {
    return { stdout: "", stderr: error ?? "usage error", exitCode: 2 };
  }

  for (const p of [parsed.task, parsed.spec, parsed.adr] as string[]) {
    if (!deps.exists(p)) {
      return { stdout: "", stderr: `ERROR: файл не найден: ${p}`, exitCode: 2 };
    }
  }

  const g = gateLint(parsed.task, parsed.spec, parsed.adr, parsed.repoRoot);

  const lines: string[] = [
    `SP-points: ${g.nSp} | AD-decisions: ${g.nAd} | FR-points: ${g.nFr} | findings: ${g.findings.length}`,
  ];
  for (const f of g.findings) lines.push(`  [x] ${f}`);
  lines.push(g.findings.length ? "GATE: BOUNCE" : "GATE: PASS");

  return { stdout: lines.join("\n"), stderr: "", exitCode: g.findings.length ? 1 : 0 };
}

// ---------------------------------------------------------------------------
// main — thin I/O shell (NOT unit-tested, same pattern as ../zone/zone-check-cli.ts)
// ---------------------------------------------------------------------------

export function main(argv: string[] = process.argv.slice(2)): void {
  const { stdout, stderr, exitCode } = runGateLintCli(argv, { exists: fs.existsSync });
  if (stdout) process.stdout.write(stdout + "\n");
  if (stderr) process.stderr.write(stderr + "\n");
  process.exit(exitCode);
}

// Direct-run guard (`node core/src/design/gate-lint-cli.ts --task ...`) —
// inert under `node --test` / plain `import` (same pattern as
// `../zone/zone-check-cli.ts`).
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
