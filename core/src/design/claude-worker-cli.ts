/**
 * claude-worker-cli (T7-4) — TS port of `tools/claude_worker.py`'s CLI shell:
 * `--role <producer|critic> --task <p> --spec <p> --adr <p> [--findings <p>]
 * [--model sonnet] [--notes <s>] [--timeout 600] [--repo-root .]`. Prints the
 * `=== claude-worker [role] ... ===` header + final JSON result line to
 * stdout, errors to stderr. Exit 0/1/2 — same mapping as the Python
 * original.
 *
 * `--repo-root` (default `.`, cwd) replaces the Python original's fixed
 * `REPO = Path(__file__).resolve().parent.parent` constant — this TS CLI has
 * no equivalent "script lives inside the repo it drives" assumption baked
 * into its own path (same cwd-relative convention as `./gate-lint-cli.ts`).
 *
 * Pure-core + thin-shell split (same pattern as `./gate-lint-cli.ts`):
 * `runClaudeWorkerCli(argv, deps)` is the injectable, testable layer built on
 * `runClaudeWorker` (`./claude-worker.ts`). `main` is the real fs/argv/
 * process.exit shell (not unit-tested — production seam is `nodeClaudeSeam`,
 * never invoked by any test).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { runClaudeWorker, nodeClaudeSeam, type ClaudeSeam, type WorkerRole } from "./claude-worker.ts";

export interface ClaudeWorkerCliDeps {
  seam: ClaudeSeam;
  exists(p: string): boolean;
  readFile(p: string): string;
  mkdirp(p: string): void;
  cwd: string;
}

export interface ClaudeWorkerCliOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ParsedArgs {
  role?: WorkerRole;
  task?: string;
  spec?: string;
  adr?: string;
  findings?: string;
  model: string;
  notes: string;
  timeout: number;
  repoRoot: string;
}

function parseArgv(argv: readonly string[]): { parsed?: ParsedArgs; error?: string } {
  let role: WorkerRole | undefined;
  let task: string | undefined;
  let spec: string | undefined;
  let adr: string | undefined;
  let findings: string | undefined;
  let model = "sonnet";
  let notes = "";
  let timeout = 600;
  let repoRoot = ".";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--role") {
      const v = argv[++i];
      if (v !== "producer" && v !== "critic") return { error: "--role: producer|critic" };
      role = v;
    } else if (a === "--task") {
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
    } else if (a === "--findings") {
      const v = argv[++i];
      if (v === undefined) return { error: "--findings: требуется значение" };
      findings = v;
    } else if (a === "--model") {
      const v = argv[++i];
      if (v === undefined) return { error: "--model: требуется значение" };
      model = v;
    } else if (a === "--notes") {
      const v = argv[++i];
      if (v === undefined) return { error: "--notes: требуется значение" };
      notes = v;
    } else if (a === "--timeout") {
      const v = argv[++i];
      if (v === undefined) return { error: "--timeout: требуется значение" };
      const n = Number(v);
      if (!Number.isFinite(n)) return { error: `--timeout: не число: ${v}` };
      timeout = n;
    } else if (a === "--repo-root") {
      const v = argv[++i];
      if (v === undefined) return { error: "--repo-root: требуется значение" };
      repoRoot = v;
    } else {
      return { error: `неизвестный аргумент: ${a}` };
    }
  }
  if (!role) return { error: "--role: обязателен" };
  if (!task) return { error: "--task: обязателен" };
  if (!spec) return { error: "--spec: обязателен" };
  if (!adr) return { error: "--adr: обязателен" };
  if (role === "critic" && !findings) return { error: "--findings обязателен для роли critic" };
  return { parsed: { role, task, spec, adr, findings, model, notes, timeout, repoRoot } };
}

/** argv -> resolved paths -> `runClaudeWorker` -> formatted `{stdout, stderr, exitCode}` (Python-parity). */
export function runClaudeWorkerCli(argv: readonly string[], deps: ClaudeWorkerCliDeps): ClaudeWorkerCliOutput {
  const { parsed, error } = parseArgv(argv);
  if (error || !parsed) {
    return { stdout: "", stderr: error ?? "usage error", exitCode: 2 };
  }

  const repoRoot = path.resolve(deps.cwd, parsed.repoRoot);
  const task = path.resolve(deps.cwd, parsed.task as string);
  const spec = path.resolve(deps.cwd, parsed.spec as string);
  const adr = path.resolve(deps.cwd, parsed.adr as string);
  const findings = parsed.findings ? path.resolve(deps.cwd, parsed.findings) : undefined;

  const result = runClaudeWorker(
    { role: parsed.role as WorkerRole, task, spec, adr, findings, model: parsed.model, notes: parsed.notes, timeout: parsed.timeout },
    { seam: deps.seam, exists: deps.exists, readFile: deps.readFile, mkdirp: deps.mkdirp, repoRoot },
  );

  return { stdout: result.stdoutLines.join("\n"), stderr: result.stderrLines.join("\n"), exitCode: result.exitCode };
}

// ---------------------------------------------------------------------------
// main — thin I/O shell (NOT unit-tested, same pattern as ./gate-lint-cli.ts)
// ---------------------------------------------------------------------------

function prodDeps(): ClaudeWorkerCliDeps {
  return {
    seam: nodeClaudeSeam(),
    exists: fs.existsSync,
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
    cwd: process.cwd(),
  };
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const { stdout, stderr, exitCode } = runClaudeWorkerCli(argv, prodDeps());
  if (stdout) process.stdout.write(stdout + "\n");
  if (stderr) process.stderr.write(stderr + "\n");
  process.exit(exitCode);
}

// Direct-run guard (`node core/src/design/claude-worker-cli.ts --role ...`) —
// inert under `node --test` / plain `import` (same pattern as
// `./gate-lint-cli.ts`).
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
