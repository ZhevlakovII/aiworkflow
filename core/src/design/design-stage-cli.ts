/**
 * design-stage-cli (T7-4) — TS port of `tools/design_stage.py`'s CLI shell:
 * `--task <p> [--model <name>] [--timeout 600] [--no-commit] [--critic]`. Exit
 * 0 = design locked+committed; 1 = bounced/blocked (nothing committed);
 * 2 = usage/driver error — same mapping as the Python original.
 * `--critic` = opt-in model-critic (OR with task frontmatter; default off).
 *
 * `--help` / no-args -> usage + exit 2 (contract DoD, an explicit deviation
 * from Python argparse's own `--help` convention, which exits 0 — the
 * contract's DoD line spells out "usage+exit 2" for BOTH cases uniformly).
 *
 * Policy/git wiring mirrors `../rails/cli.ts`'s `RailCliDeps`/`prodDeps`
 * pattern exactly (`loadPolicyFile` + `buildPolicy` + `resolveInteractive` +
 * `nodeGitSeam`) — same `policy.yml`-driven `ResolvedPolicy` the commit rail
 * already uses, so `runDesignStage`'s final `gatedCommit` step is governed by
 * the SAME policy as `/aiwf-commit`, not a second parallel policy path.
 *
 * Pure-core + thin-shell split (same pattern as `../rails/cli.ts`):
 * `runDesignStageCli(argv, deps)` is the injectable, testable layer built on
 * `runDesignStage` (`./design-stage.ts`). `main` is the real fs/argv/
 * process.exit shell (not unit-tested — production `ClaudeSeam` is
 * `nodeClaudeSeam`, never invoked by any test, contract: no real `claude -p`).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { runDesignStage } from "./design-stage.ts";
import { nodeClaudeSeam, type ClaudeSeam } from "./claude-worker.ts";
import { nodeGitSeam, type GitSeam } from "../rails/git-seam.ts";
import type { Policy } from "../policy/policy.ts";
import { buildPolicy, loadPolicyFile, resolveInteractive } from "../wiring/policy-source.ts";

export interface DesignStageCliDeps {
  cwd: string;
  exists(p: string): boolean;
  readFile(p: string): string;
  writeFile(p: string, content: string): void;
  mkdirp(p: string): void;
  claude: ClaudeSeam;
  loadPolicy(cwd?: string): { policy: Policy; warnings: string[] };
  makeGitSeam(cwd?: string): GitSeam;
  isTTY?: boolean;
  /** Clock seam (`./design-stage.ts`'s `DesignStageDeps.now`) — ledger `date:` field. */
  now(): string;
}

export interface DesignStageCliOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const USAGE =
  "usage: design-stage --task <task-file> [--model <name>] [--timeout <sec>] [--no-commit] [--critic]";

interface ParsedArgs {
  task?: string;
  model: string;
  timeout: number;
  noCommit: boolean;
  critic: boolean;
  help: boolean;
}

function parseArgv(argv: readonly string[]): { parsed?: ParsedArgs; error?: string } {
  let task: string | undefined;
  let model = "";
  let timeout = 600;
  let noCommit = false;
  let critic = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      help = true;
    } else if (a === "--task") {
      const v = argv[++i];
      if (v === undefined) return { error: "--task: требуется значение" };
      task = v;
    } else if (a === "--model") {
      const v = argv[++i];
      if (v === undefined) return { error: "--model: требуется значение" };
      model = v;
    } else if (a === "--timeout") {
      const v = argv[++i];
      if (v === undefined) return { error: "--timeout: требуется значение" };
      const n = Number(v);
      if (!Number.isFinite(n)) return { error: `--timeout: не число: ${v}` };
      timeout = n;
    } else if (a === "--no-commit") {
      noCommit = true;
    } else if (a === "--critic") {
      critic = true;
    } else {
      return { error: `неизвестный аргумент: ${a}` };
    }
  }
  return { parsed: { task, model, timeout, noCommit, critic, help } };
}

/** argv -> policy/git wiring -> `runDesignStage` -> formatted `{stdout, stderr, exitCode}`. */
export function runDesignStageCli(argv: readonly string[], deps: DesignStageCliDeps): DesignStageCliOutput {
  if (argv.length === 0) {
    return { stdout: USAGE, stderr: "", exitCode: 2 };
  }
  const { parsed, error } = parseArgv(argv);
  if (error || !parsed) {
    return { stdout: USAGE, stderr: error ?? "usage error", exitCode: 2 };
  }
  if (parsed.help) {
    return { stdout: USAGE, stderr: "", exitCode: 2 };
  }
  if (!parsed.task) {
    return { stdout: USAGE, stderr: "--task: обязателен", exitCode: 2 };
  }

  const taskPath = path.resolve(deps.cwd, parsed.task);
  const { policy } = deps.loadPolicy(deps.cwd);
  const interactive = resolveInteractive({ isTTY: deps.isTTY });
  const { resolved } = buildPolicy({ policy, interactive });
  const git = deps.makeGitSeam(deps.cwd);

  const result = runDesignStage(
    {
      taskPath,
      model: parsed.model,
      timeout: parsed.timeout,
      noCommit: parsed.noCommit,
      critic: parsed.critic,
    },
    {
      repoRoot: deps.cwd,
      exists: deps.exists,
      readFile: deps.readFile,
      writeFile: deps.writeFile,
      mkdirp: deps.mkdirp,
      claude: deps.claude,
      git,
      policy: resolved,
      now: deps.now,
    },
  );

  return { stdout: result.stdoutLines.join("\n"), stderr: result.stderrLines.join("\n"), exitCode: result.exitCode };
}

// ---------------------------------------------------------------------------
// main — thin I/O shell (NOT unit-tested, same pattern as ../rails/cli.ts)
// ---------------------------------------------------------------------------

function prodDeps(): DesignStageCliDeps {
  return {
    cwd: process.cwd(),
    exists: fs.existsSync,
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
    claude: nodeClaudeSeam(),
    loadPolicy: (cwd) => loadPolicyFile((cwd || ".") + "/policy.yml"),
    makeGitSeam: (cwd) => nodeGitSeam(cwd),
    isTTY: process.stdout.isTTY === true,
    now: () => new Date().toISOString().slice(0, 10),
  };
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const { stdout, stderr, exitCode } = runDesignStageCli(argv, prodDeps());
  if (stdout) process.stdout.write(stdout + "\n");
  if (stderr) process.stderr.write(stderr + "\n");
  process.exit(exitCode);
}

// Direct-run guard (`node core/src/design/design-stage-cli.ts --task ...`) —
// inert under `node --test` / plain `import` (same pattern as
// `../rails/cli.ts`).
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
