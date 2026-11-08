/**
 * gate-setup-cli (T7-4) — TS port of `tools/gate_setup.py`'s CLI shell:
 * `--task <p>` (required), `--base <ref>` (accepted for argv-parity with the
 * Python original — parsed there too but never actually used by its output
 * logic, a vestigial flag; kept accept-and-ignore here rather than erroring
 * on it). Writes `.workflow/gate.cmd` (cwd-relative) and prints
 * `gate.cmd записан (<task-basename>):` + the generated line, exit 0.
 * Missing task-file / missing `zone.allow` -> `ERROR: ...` to stderr, exit 2
 * — same mapping as the Python original.
 *
 * ADDITIVE `--print` flag (NOT in the Python original, contract DoD: a
 * no-write dry-run mode for verifying gate.cmd generation against an
 * existing task-file without mutating `.workflow/gate.cmd`): prints the
 * generated gate.cmd line to stdout and returns WITHOUT writing the file.
 *
 * Pure-core + thin-shell split (same pattern as `./gate-lint-cli.ts`):
 * `runGateSetupCli(argv, deps)` is the injectable, testable layer built on
 * the pure `buildGateSetup` (`./gate-setup.ts`). `main` is the real
 * fs/argv/process.exit shell (not unit-tested).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { buildGateSetup } from "./gate-setup.ts";

export interface GateSetupCliDeps {
  exists(p: string): boolean;
  readFile(p: string): string;
  writeFile(p: string, content: string): void;
  mkdirp(p: string): void;
  cwd: string;
}

export interface GateSetupCliOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ParsedArgs {
  task?: string;
  print: boolean;
}

function parseArgv(argv: readonly string[]): { parsed?: ParsedArgs; error?: string } {
  let task: string | undefined;
  let print = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--task") {
      const v = argv[++i];
      if (v === undefined) return { error: "--task: требуется значение" };
      task = v;
    } else if (a === "--base") {
      const v = argv[++i]; // accepted, unused — vestigial in the Python original too
      if (v === undefined) return { error: "--base: требуется значение" };
    } else if (a === "--print") {
      print = true;
    } else {
      return { error: `неизвестный аргумент: ${a}` };
    }
  }
  if (!task) return { error: "--task: обязателен" };
  return { parsed: { task, print } };
}

/** argv -> task-file read -> `buildGateSetup` -> write (or `--print`) -> formatted output (Python-parity). */
export function runGateSetupCli(argv: readonly string[], deps: GateSetupCliDeps): GateSetupCliOutput {
  const { parsed, error } = parseArgv(argv);
  if (error || !parsed) {
    return { stdout: "", stderr: error ?? "usage error", exitCode: 2 };
  }
  const taskPath = parsed.task as string;
  if (!deps.exists(taskPath)) {
    return { stdout: "", stderr: `ERROR: task-file не найден: ${taskPath}`, exitCode: 2 };
  }

  const { gateCmd, error: gateError } = buildGateSetup(deps.readFile(taskPath));
  if (gateError) {
    return { stdout: "", stderr: `ERROR: ${gateError}`, exitCode: 2 };
  }

  if (parsed.print) {
    return { stdout: gateCmd, stderr: "", exitCode: 0 };
  }

  const outPath = path.join(deps.cwd, ".workflow", "gate.cmd");
  deps.mkdirp(path.dirname(outPath));
  deps.writeFile(outPath, gateCmd + "\n");
  const lines = [`gate.cmd записан (${path.basename(taskPath)}):`, `  ${gateCmd}`];
  return { stdout: lines.join("\n"), stderr: "", exitCode: 0 };
}

// ---------------------------------------------------------------------------
// main — thin I/O shell (NOT unit-tested, same pattern as ./gate-lint-cli.ts)
// ---------------------------------------------------------------------------

function prodDeps(): GateSetupCliDeps {
  return {
    exists: fs.existsSync,
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
    cwd: process.cwd(),
  };
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const { stdout, stderr, exitCode } = runGateSetupCli(argv, prodDeps());
  if (stdout) process.stdout.write(stdout + "\n");
  if (stderr) process.stderr.write(stderr + "\n");
  process.exit(exitCode);
}

// Direct-run guard (`node core/src/design/gate-setup-cli.ts --task ...`) —
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
