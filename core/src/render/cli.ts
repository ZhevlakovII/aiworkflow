/**
 * core/src/render/cli.ts — render-CLI (T-canon-single-source, requirement 4).
 *
 * `render --out <root> [--clients omp,claude,opencode,cursor] [--canon <path>]
 * [--adapters <path>] [--overlay <path>] [--target <name>]` — materializes
 * `canon/roles/*.md` + `tools/adapters/*.yml` into `<root>/.omp/agents`,
 * `<root>/.claude/agents`, `<root>/.opencode/agents`, `<root>/.cursor/agents`
 * (+ any other capability/layout the adapters declare) via `render()`
 * (`./engine.ts`).
 *
 * `--canon` defaults to `canon` (cwd-relative), `--adapters` defaults to
 * `tools/adapters` (cwd-relative) — the real repo invocation, run from the
 * repo root, needs no flags beyond `--out .`. Adapters are NOT nested under
 * canon (AD-canon-tool-neutral, T-canon-single-source requirement 2) — the
 * path is always an explicit parameter/default here, never derived from
 * `--canon`.
 *
 * Same pure-core + thin-shell split as the other `*-cli.ts` modules
 * (`runRenderCli(argv)` — testable, no `process.exit`; `main` — the real
 * argv/exit shell, not unit-tested).
 */
import { fileURLToPath } from "node:url";

import { render } from "./engine.ts";

export interface RenderCliOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ParsedArgs {
  out: string;
  canon: string;
  adapters: string;
  clients?: string[];
  overlay?: string;
  target?: string;
}

function parseArgv(argv: readonly string[]): { parsed?: ParsedArgs; error?: string } {
  if (argv[0] !== "render") {
    return { error: 'usage: render --out <root> [--clients omp,claude,opencode,cursor] [--canon <path>] [--adapters <path>] [--overlay <path>] [--target <name>]' };
  }
  let out: string | undefined;
  let canon = "canon";
  let adapters = "tools/adapters";
  let clients: string[] | undefined;
  let overlay: string | undefined;
  let target: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") {
      const v = argv[++i];
      if (v === undefined) return { error: "--out: требуется значение" };
      out = v;
    } else if (a === "--canon") {
      const v = argv[++i];
      if (v === undefined) return { error: "--canon: требуется значение" };
      canon = v;
    } else if (a === "--adapters") {
      const v = argv[++i];
      if (v === undefined) return { error: "--adapters: требуется значение" };
      adapters = v;
    } else if (a === "--clients") {
      const v = argv[++i];
      if (v === undefined) return { error: "--clients: требуется значение" };
      clients = v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    } else if (a === "--overlay") {
      const v = argv[++i];
      if (v === undefined) return { error: "--overlay: требуется значение" };
      overlay = v;
    } else if (a === "--target") {
      const v = argv[++i];
      if (v === undefined) return { error: "--target: требуется значение" };
      target = v;
    } else {
      return { error: `неизвестный аргумент: ${a}` };
    }
  }
  if (!out) return { error: "--out: обязателен" };
  return { parsed: { out, canon, adapters, clients, overlay, target } };
}

/** argv -> `render()` -> formatted `{stdout, stderr, exitCode}`. Exit 0 (no
 * errors) / 1 (`report.errors` non-empty, fail-soft per-client — see
 * `engine.ts`) / 2 (usage error). */
export function runRenderCli(argv: readonly string[]): RenderCliOutput {
  const { parsed, error } = parseArgv(argv);
  if (error || !parsed) {
    return { stdout: "", stderr: error ?? "usage error", exitCode: 2 };
  }

  const report = render(parsed.canon, parsed.out, {
    clients: parsed.clients,
    overlayRoot: parsed.overlay,
    target: parsed.target,
    adaptersRoot: parsed.adapters,
  });

  const lines: string[] = [
    `written: ${report.written.length} | unchanged: ${report.unchanged.length} | skipped: ${report.skipped.length} | unmanaged: ${report.unmanaged.length} | errors: ${report.errors.length}`,
  ];
  for (const w of report.written) lines.push(`  [write] ${w}`);
  for (const s of report.skipped) lines.push(`  [skip] ${s.client}:${s.resource} — ${s.reason}`);
  for (const e of report.errors) lines.push(`  [error] ${e}`);

  return { stdout: lines.join("\n"), stderr: "", exitCode: report.errors.length > 0 ? 1 : 0 };
}

// ---------------------------------------------------------------------------
// main — thin I/O shell (NOT unit-tested, same pattern as ../design/gate-lint-cli.ts)
// ---------------------------------------------------------------------------

export function main(argv: string[] = process.argv.slice(2)): void {
  const { stdout, stderr, exitCode } = runRenderCli(argv);
  if (stdout) process.stdout.write(stdout + "\n");
  if (stderr) process.stderr.write(stderr + "\n");
  process.exit(exitCode);
}

// Direct-run guard (`node core/src/render/cli.ts render --out .`) — inert
// under `node --test` / plain `import` (same pattern as ../design/gate-lint-cli.ts).
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
