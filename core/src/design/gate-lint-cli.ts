/**
 * gate-lint-cli — thin argv shell over `gateLint`.
 *
 * Legacy: `--task --spec --adr [--repo-root]`
 * New gen: `--task --spec [--roadmap] [--generation spec-roadmap] [--repo-root]`
 *   `--adr` optional / ignored when generation=spec-roadmap.
 */
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

import { gateLint, type GateLintOptions } from "./gate-lint.ts";
import { GEN_SPEC_ROADMAP, isSpecRoadmapGeneration } from "./generation.ts";

export interface GateLintCliDeps {
  exists(p: string): boolean;
  readFile?(p: string): string;
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
  roadmap?: string;
  generation?: string;
  repoRoot: string;
}

function parseArgv(argv: readonly string[]): { parsed?: ParsedArgs; error?: string } {
  let task: string | undefined;
  let spec: string | undefined;
  let adr: string | undefined;
  let roadmap: string | undefined;
  let generation: string | undefined;
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
    } else if (a === "--roadmap") {
      const v = argv[++i];
      if (v === undefined) return { error: "--roadmap: требуется значение" };
      roadmap = v;
    } else if (a === "--generation") {
      const v = argv[++i];
      if (v === undefined) return { error: "--generation: требуется значение" };
      generation = v;
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
  return { parsed: { task, spec, adr, roadmap, generation, repoRoot } };
}

function resolveCliGeneration(
  parsed: ParsedArgs,
  deps: GateLintCliDeps,
): "sp-adr" | "spec-roadmap" {
  if (parsed.generation === GEN_SPEC_ROADMAP || parsed.generation === "spec-roadmap") {
    return "spec-roadmap";
  }
  if (parsed.generation === "sp-adr") return "sp-adr";
  if (deps.exists(parsed.task!) && deps.readFile) {
    try {
      if (isSpecRoadmapGeneration(deps.readFile(parsed.task!))) return "spec-roadmap";
    } catch {
      // legacy
    }
  } else if (deps.exists(parsed.task!)) {
    try {
      if (isSpecRoadmapGeneration(fs.readFileSync(parsed.task!, "utf8"))) return "spec-roadmap";
    } catch {
      // legacy
    }
  }
  return "sp-adr";
}

/** argv -> file-existence check -> `gateLint` -> formatted output. */
export function runGateLintCli(argv: readonly string[], deps: GateLintCliDeps): GateLintCliOutput {
  const { parsed, error } = parseArgv(argv);
  if (error || !parsed) {
    return { stdout: "", stderr: error ?? "usage error", exitCode: 2 };
  }

  const gen = resolveCliGeneration(parsed, deps);
  if (!deps.exists(parsed.task!)) {
    return { stdout: "", stderr: `ERROR: файл не найден: ${parsed.task}`, exitCode: 2 };
  }
  if (!deps.exists(parsed.spec!)) {
    return { stdout: "", stderr: `ERROR: файл не найден: ${parsed.spec}`, exitCode: 2 };
  }

  if (gen === "sp-adr") {
    if (!parsed.adr) return { stdout: "", stderr: "--adr: обязателен", exitCode: 2 };
    if (!deps.exists(parsed.adr)) {
      return { stdout: "", stderr: `ERROR: файл не найден: ${parsed.adr}`, exitCode: 2 };
    }
  }
  if (parsed.roadmap && !deps.exists(parsed.roadmap)) {
    return { stdout: "", stderr: `ERROR: файл не найден: ${parsed.roadmap}`, exitCode: 2 };
  }

  const opts: GateLintOptions = { generation: gen };
  if (parsed.roadmap) opts.roadmapPath = parsed.roadmap;

  const g = gateLint(
    parsed.task!,
    parsed.spec!,
    gen === "sp-adr" ? parsed.adr! : null,
    parsed.repoRoot,
    opts,
  );

  const lines: string[] = [
    `SP-points: ${g.nSp} | AD-decisions: ${g.nAd} | FR-points: ${g.nFr} | AC: ${g.nAc} | phase: ${g.nPhase} | findings: ${g.findings.length}`,
  ];
  for (const f of g.findings) lines.push(`  [x] ${f}`);
  lines.push(g.findings.length ? "GATE: BOUNCE" : "GATE: PASS");

  return { stdout: lines.join("\n"), stderr: "", exitCode: g.findings.length ? 1 : 0 };
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const { stdout, stderr, exitCode } = runGateLintCli(argv, {
    exists: fs.existsSync,
    readFile: (p) => fs.readFileSync(p, "utf-8"),
  });
  if (stdout) process.stdout.write(stdout + "\n");
  if (stderr) process.stderr.write(stderr + "\n");
  process.exit(exitCode);
}

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
