/**
 * fr-trace-cli (T7-3) — TS port of `tools/fr_trace.py`'s CLI shell:
 * `--spec <p> [--files f1 f2 ...] [--staged] [--repo-root <p=.>]`. `--staged`
 * appends `git diff --cached --name-only` to `--files` (via the injectable
 * `GitSeam`, same seam-not-bash-tool invariant as `../rails/git-seam.ts` /
 * `../zone/zone-check-cli.ts`). Output: `FR: N | covered: M | test-files: K
 * | findings: F`, one `  [x] ...` line per finding, final `FR-TRACE: PASS` /
 * `FR-TRACE: FAIL`. Exit 0 (clean / 0 FR) / 1 (uncovered FR) / 2 (missing
 * spec / usage) — same mapping as the Python original.
 *
 * Pure-core + thin-shell split (same pattern as `./gate-lint-cli.ts` /
 * `../zone/zone-check-cli.ts`): `runFrTraceCli(argv, deps)` is the
 * injectable, testable argv/git-seam layer built on the pure `frTrace`
 * (`./fr-trace.ts`). `main` is the real argv/git/process.exit shell (not
 * unit-tested).
 */
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

import { frTrace } from "./fr-trace.ts";
import { nodeGitSeam, type GitSeam } from "../rails/git-seam.ts";

export interface FrTraceCliDeps {
  git: GitSeam;
  /** Injectable existence-check (contract: testable without touching real fs). Defaults to `fs.existsSync`. */
  exists(p: string): boolean;
}

export interface FrTraceCliOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ParsedArgs {
  spec?: string;
  files: string[];
  staged: boolean;
  repoRoot: string;
}

function parseArgv(argv: readonly string[]): { parsed?: ParsedArgs; error?: string } {
  let spec: string | undefined;
  const files: string[] = [];
  let staged = false;
  let repoRoot = ".";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--spec") {
      const v = argv[++i];
      if (v === undefined) return { error: "--spec: требуется значение" };
      spec = v;
    } else if (a === "--files") {
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) files.push(argv[++i]);
    } else if (a === "--staged") {
      staged = true;
    } else if (a === "--repo-root") {
      const v = argv[++i];
      if (v === undefined) return { error: "--repo-root: требуется значение" };
      repoRoot = v;
    } else {
      return { error: `неизвестный аргумент: ${a}` };
    }
  }
  if (!spec) return { error: "--spec: обязателен" };
  return { parsed: { spec, files, staged, repoRoot } };
}

/** argv -> spec-existence check -> (git-seam --staged) -> `frTrace` -> formatted `{stdout, stderr, exitCode}` (Python-parity). */
export function runFrTraceCli(argv: readonly string[], deps: FrTraceCliDeps): FrTraceCliOutput {
  const { parsed, error } = parseArgv(argv);
  if (error || !parsed) {
    return { stdout: "", stderr: error ?? "usage error", exitCode: 2 };
  }
  if (!deps.exists(parsed.spec!)) {
    return { stdout: "", stderr: `ERROR: spec не найден: ${parsed.spec}`, exitCode: 2 };
  }

  const staged = [...parsed.files];
  if (parsed.staged) {
    const res = deps.git.run(["git", "diff", "--cached", "--name-only"]);
    staged.push(...res.stdout.split("\n").map((s) => s.trim()).filter((s) => s.length > 0));
  }

  const r = frTrace(parsed.spec!, staged, parsed.repoRoot);
  const lines: string[] = [
    `FR: ${r.frIds.length} | covered: ${r.covered.length} | test-files: ${r.testFiles.length} | findings: ${r.findings.length}`,
  ];
  for (const f of r.findings) lines.push(`  [x] ${f}`);
  lines.push(r.findings.length ? "FR-TRACE: FAIL" : "FR-TRACE: PASS");

  return { stdout: lines.join("\n"), stderr: "", exitCode: r.findings.length ? 1 : 0 };
}

// ---------------------------------------------------------------------------
// main — thin I/O shell (NOT unit-tested, same pattern as ./gate-lint-cli.ts)
// ---------------------------------------------------------------------------

export function main(argv: string[] = process.argv.slice(2)): void {
  const git: GitSeam = nodeGitSeam(process.cwd());
  const { stdout, stderr, exitCode } = runFrTraceCli(argv, { git, exists: fs.existsSync });
  if (stdout) process.stdout.write(stdout + "\n");
  if (stderr) process.stderr.write(stderr + "\n");
  process.exit(exitCode);
}

// Direct-run guard — inert under `node --test` / plain `import` (same pattern
// as `./gate-lint-cli.ts` / `../zone/zone-check-cli.ts`).
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
