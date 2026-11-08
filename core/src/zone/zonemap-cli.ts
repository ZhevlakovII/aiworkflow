/**
 * zonemap-cli (phase B2, contract L-2) — mechanical domain-agent resolver
 * CLI: `--zonemap <path> --allow <glob> [--allow <glob> ...] [--json]`.
 * Replaces the prose mapping-table that used to live inline in
 * `.claude/commands/aiwf-execute.md` (instruction, not enforcement) — the
 * command now shells out here instead.
 *
 * Exit codes: 0 = resolved (single domain or none -> default agent),
 * 3 = ambiguous (zone spans >1 domain — lead decides, not the model),
 * 4 = denied-domain (an allow-glob falls under `deny-domain`, e.g. legacy
 * `source/**`), 2 = usage error (missing/unknown args, unreadable zonemap
 * file). Denied-domain is checked before ambiguous — an explicit legacy-zone
 * hit is a stronger stop signal than "spans multiple valid domains".
 *
 * Pure-core + thin-shell split (same pattern as `./zone-check-cli.ts` /
 * `../design/gate-lint-cli.ts`): `runZonemapCli(argv, deps)` is the
 * injectable, testable argv-parsing layer built on the pure
 * `parseZoneMap`/`resolveAgent` (`./zonemap.ts`). `main` is the real
 * fs/argv/process.exit shell (not unit-tested).
 */
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

import { parseZoneMap, resolveAgent, type ResolveAgentResult } from "./zonemap.ts";

export interface ZonemapCliDeps {
  /** Injectable zonemap-file read (contract: testable without touching real fs). Defaults to `fs.readFileSync`. */
  readFile(p: string): string;
}

export interface ZonemapCliOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ParsedArgs {
  zonemap?: string;
  allow: string[];
  json: boolean;
}

function parseArgv(argv: readonly string[]): { parsed?: ParsedArgs; error?: string } {
  let zonemap: string | undefined;
  const allow: string[] = [];
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--zonemap") {
      const v = argv[++i];
      if (v === undefined) return { error: "--zonemap: требуется значение" };
      zonemap = v;
    } else if (a === "--allow") {
      const v = argv[++i];
      if (v === undefined) return { error: "--allow: требуется значение" };
      allow.push(v);
    } else if (a === "--json") {
      json = true;
    } else {
      return { error: `неизвестный аргумент: ${a}` };
    }
  }
  if (!zonemap) return { error: "--zonemap: обязателен" };
  if (allow.length === 0) return { error: "--allow: требуется хотя бы один глоб" };
  return { parsed: { zonemap, allow, json } };
}

function formatText(result: ResolveAgentResult): string {
  if (result.denied.length > 0) {
    return `DENIED-DOMAIN: ${result.denied.join(",")} (deny-domain зона — legacy, не трогать)`;
  }
  if (result.ambiguous) {
    return `AMBIGUOUS: matched=${result.matched.join(",")} (зона задевает >1 домен — решает lead, не модель)`;
  }
  return result.agent;
}

/** argv -> zonemap read -> `resolveAgent` -> formatted `{stdout, stderr, exitCode}`. */
export function runZonemapCli(argv: readonly string[], deps: ZonemapCliDeps): ZonemapCliOutput {
  const { parsed, error } = parseArgv(argv);
  if (error || !parsed) {
    return { stdout: "", stderr: error ?? "usage error", exitCode: 2 };
  }

  let text: string;
  try {
    text = deps.readFile(parsed.zonemap);
  } catch {
    return { stdout: "", stderr: `ERROR: не удалось прочитать zonemap: ${parsed.zonemap}`, exitCode: 2 };
  }

  let result: ResolveAgentResult;
  try {
    const zm = parseZoneMap(text);
    result = resolveAgent(parsed.allow, zm);
  } catch (e) {
    return { stdout: "", stderr: `ERROR: не удалось разобрать zonemap: ${(e as Error).message}`, exitCode: 2 };
  }

  const exitCode = result.denied.length > 0 ? 4 : result.ambiguous ? 3 : 0;

  if (parsed.json) {
    return { stdout: JSON.stringify(result), stderr: "", exitCode };
  }
  return { stdout: formatText(result), stderr: "", exitCode };
}

// ---------------------------------------------------------------------------
// main — thin I/O shell (NOT unit-tested, same pattern as ./zone-check-cli.ts)
// ---------------------------------------------------------------------------

export function main(argv: string[] = process.argv.slice(2)): void {
  const { stdout, stderr, exitCode } = runZonemapCli(argv, { readFile: (p) => fs.readFileSync(p, "utf8") });
  if (stdout) process.stdout.write(stdout + "\n");
  if (stderr) process.stderr.write(stderr + "\n");
  process.exit(exitCode);
}

// Direct-run guard (`node core/src/zone/zonemap-cli.ts --zonemap ... --allow ...`) —
// inert under `node --test` / plain `import` (same pattern as `./zone-check-cli.ts`).
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
