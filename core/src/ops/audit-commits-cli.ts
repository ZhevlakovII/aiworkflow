/**
 * audit-commits-cli (T7-5) — TS port of `tools/audit_commits.py`'s CLI
 * shell: `--repo <path>` (default cwd), `--since <ref>` (default whole
 * history), `--emit` (writes a `bypass-suspected` guard row per suspect
 * commit to BOTH `<repo>/.workflow/telemetry.ndjson` and
 * `~/.omp/agent/telemetry.ndjson`, best-effort), `--json`. Exit 1 if any
 * suspect commit, 0 if all signed, 2 on a `git log` failure — same mapping
 * as the Python original.
 *
 * Pure-core + thin-shell split (contract L-1, same pattern as
 * `../rails/cli.ts`): `runAuditCommitsCli(argv, deps)` is the injectable,
 * testable layer (git via the `GitSeam` seam, same injectable boundary every
 * rail uses — contract L-3's git-seam invariant) built on `./audit-commits.ts`.
 * `main` is the real fs/git/argv/process.exit shell (not unit-tested).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { parseGitLog, classifyCommits, buildGuardRow, renderText, renderJson } from "./audit-commits.ts";
import { nodeGitSeam, type GitSeam } from "../rails/git-seam.ts";

export interface AuditCommitsCliDeps {
  git: GitSeam;
  cwd: string;
  homedir: string;
  mkdirp(p: string): void;
  appendLine(p: string, line: string): void;
  now(): string;
}

export interface AuditCommitsCliOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ParsedArgs {
  repo?: string;
  since?: string;
  emit: boolean;
  json: boolean;
}

function parseArgv(argv: readonly string[]): { parsed?: ParsedArgs; error?: string } {
  const parsed: ParsedArgs = { emit: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") {
      const v = argv[++i];
      if (v === undefined) return { error: "--repo: требуется значение" };
      parsed.repo = v;
    } else if (a === "--since") {
      const v = argv[++i];
      if (v === undefined) return { error: "--since: требуется значение" };
      parsed.since = v;
    } else if (a === "--emit") {
      parsed.emit = true;
    } else if (a === "--json") {
      parsed.json = true;
    } else {
      return { error: `неизвестный аргумент: ${a}` };
    }
  }
  return { parsed };
}

/** `%H%x00%an%x00%s%x00%b%x1e` — same escape rationale as the Python original: NUL/RS land in the git OUTPUT, not argv (Windows `CreateProcess` forbids NUL in args). */
const FMT = "%H%x00%an%x00%s%x00%b%x1e";

export function runAuditCommitsCli(argv: readonly string[], deps: AuditCommitsCliDeps): AuditCommitsCliOutput {
  const { parsed, error } = parseArgv(argv);
  if (error || !parsed) {
    return { stdout: "", stderr: error ?? "usage error", exitCode: 2 };
  }

  const repo = parsed.repo ? path.resolve(deps.cwd, parsed.repo) : deps.cwd;
  const gitArgs = ["git", "-C", repo, "log", `--format=${FMT}`];
  if (parsed.since) gitArgs.push(`${parsed.since}..HEAD`);
  const res = deps.git.run(gitArgs);
  if (res.code !== 0) {
    return { stdout: "", stderr: `git log failed: ${res.stderr.trim()}`, exitCode: 2 };
  }

  const commits = parseGitLog(res.stdout);
  const result = classifyCommits(commits);

  if (parsed.emit) {
    for (const c of result.suspect) {
      const line = JSON.stringify(buildGuardRow(c.sha, c.subject, deps.now())) + "\n";
      for (const target of [
        path.join(repo, ".workflow", "telemetry.ndjson"),
        path.join(deps.homedir, ".omp", "agent", "telemetry.ndjson"),
      ]) {
        try {
          deps.mkdirp(path.dirname(target));
          deps.appendLine(target, line);
        } catch {
          // best-effort, same as Python's `except OSError: pass`.
        }
      }
    }
  }

  const stdout = parsed.json ? JSON.stringify(renderJson(result), null, 2) : renderText(result);
  return { stdout, stderr: "", exitCode: result.suspect.length ? 1 : 0 };
}

// ---------------------------------------------------------------------------
// main — thin I/O shell (NOT unit-tested, same pattern as ../rails/cli.ts)
// ---------------------------------------------------------------------------

function prodDeps(): AuditCommitsCliDeps {
  return {
    git: nodeGitSeam(),
    cwd: process.cwd(),
    homedir: os.homedir(),
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
    appendLine: (p, line) => fs.appendFileSync(p, line, "utf-8"),
    now: () => new Date().toISOString(),
  };
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const { stdout, stderr, exitCode } = runAuditCommitsCli(argv, prodDeps());
  if (stdout) process.stdout.write(stdout + "\n");
  if (stderr) process.stderr.write(stderr + "\n");
  process.exit(exitCode);
}

// Direct-run guard (`node core/src/ops/audit-commits-cli.ts --since ...`) —
// inert under `node --test` / plain `import` (same pattern as `../rails/cli.ts`).
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
