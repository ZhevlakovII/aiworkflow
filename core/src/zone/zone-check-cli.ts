/**
 * zone-check-cli (T7-2) — TS port of `tools/zone_check.py`'s CLI shell:
 * `--allow "<csv>"` (required, empty -> exit 2), `--deny "<csv>"`,
 * `--staged` (`git diff --cached --name-only`), `--from-git <ref>`
 * (`git diff --name-only <ref>`), else paths from stdin (one per line).
 * Output: `paths: N | violations: M`, one `  [x] ...` line per violation,
 * final `ZONE: OK` / `ZONE: VIOLATION`. Exit 0 (clean) / 1 (violations) /
 * 2 (usage/git error) — same mapping as the Python original.
 *
 * Split (contract L-3): `runZoneCheckCli(argv, deps)` is the injectable
 * argv-parsing + git-seam layer (testable without real stdin/process,
 * same pattern as `../rails/cli.ts`'s `runRailCli`) built on the pure
 * `checkZone` (`./zone-check.ts`). `main` is the thin real-stdin/argv/
 * process.exit shell (not unit-tested, same as `../rails/cli.ts`).
 *
 * Glob-semantics parity (contract L-2, Amend A1): a glob-semantics
 * divergence was found while porting — Python's `glob_to_re` treats a `**`
 * immediately followed by a `/` as ONE token (the slash is consumed, 0+
 * segments matched), while `path-zone.ts`'s `globToRegExp` originally did
 * not consume that slash (>=1 segment required), which under-matched a
 * deny-glob shaped `a` + `/` + `**` + `/` + `b` against `a/b` (weaker
 * protection than Python). Flagged to lead per contract L-2; lead's Amend
 * A1 fixed `path-zone.ts`'s `globToRegExp` at the source to also consume a
 * `/` immediately following `**` — the two implementations are now
 * Python-parity for this shape too (pinned by the "Amend A1 parity" tests
 * in `core/test/zone-check.test.ts`, formerly the "L-2 glob-semantics
 * divergence" tests). Every glob token (`**` at a boundary, `**` followed
 * by `/`, bare `*` within a segment, `?`, literal-escaping) is now
 * semantically identical between the two implementations.
 */
import { fileURLToPath } from "node:url";

import { checkZone } from "./zone-check.ts";
import { nodeGitSeam, type GitSeam } from "../rails/git-seam.ts";

export interface ZoneCliDeps {
  git: GitSeam;
  /** Pre-read stdin text (injectable — contract L-3: no real `process.stdin` in the pure/testable layer). */
  stdinText: string;
}

export interface ZoneCliOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ParsedArgs {
  allow: string;
  deny: string;
  staged: boolean;
  fromGit?: string;
}

function parseArgv(argv: readonly string[]): { parsed?: ParsedArgs; error?: string } {
  let allow = "";
  let deny = "";
  let staged = false;
  let fromGit: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--allow") {
      const v = argv[++i];
      if (v === undefined) return { error: "--allow: требуется значение" };
      allow = v;
    } else if (a === "--deny") {
      const v = argv[++i];
      if (v === undefined) return { error: "--deny: требуется значение" };
      deny = v;
    } else if (a === "--from-git") {
      const v = argv[++i];
      if (v === undefined) return { error: "--from-git: требуется значение" };
      fromGit = v;
    } else if (a === "--staged") {
      staged = true;
    } else {
      return { error: `неизвестный аргумент: ${a}` };
    }
  }
  return { parsed: { allow, deny, staged, fromGit } };
}

/** argv -> path-source resolution -> `checkZone` -> formatted `{stdout, stderr, exitCode}` (contract L-1 output/exit parity). */
export function runZoneCheckCli(argv: readonly string[], deps: ZoneCliDeps): ZoneCliOutput {
  const { parsed, error } = parseArgv(argv);
  if (error || !parsed) {
    return { stdout: "", stderr: error ?? "usage error", exitCode: 2 };
  }

  const allow = parsed.allow
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const deny = parsed.deny
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (allow.length === 0) {
    return { stdout: "", stderr: "ERROR: пустой --allow (зона обязательна)", exitCode: 2 };
  }

  let rawPaths: string[];
  if (parsed.staged) {
    const res = deps.git.run(["git", "diff", "--cached", "--name-only"]);
    if (res.code !== 0) return { stdout: "", stderr: res.stderr, exitCode: 2 };
    rawPaths = res.stdout.split("\n");
  } else if (parsed.fromGit) {
    const res = deps.git.run(["git", "diff", "--name-only", parsed.fromGit]);
    if (res.code !== 0) return { stdout: "", stderr: res.stderr, exitCode: 2 };
    rawPaths = res.stdout.split("\n");
  } else {
    rawPaths = deps.stdinText.split("\n");
  }

  const paths = rawPaths.filter((p) => p.trim().length > 0);
  const { violations, ok } = checkZone(paths, allow, deny);

  const lines: string[] = [`paths: ${paths.length} | violations: ${violations.length}`];
  for (const v of violations) lines.push(`  [x] ${v}`);
  lines.push(ok ? "ZONE: OK" : "ZONE: VIOLATION");

  return { stdout: lines.join("\n"), stderr: "", exitCode: ok ? 0 : 1 };
}

// ---------------------------------------------------------------------------
// main — thin I/O shell (NOT unit-tested, same pattern as ../rails/cli.ts)
// ---------------------------------------------------------------------------

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    try {
      process.stdin.setEncoding("utf-8");
      process.stdin.on("data", (chunk) => {
        data += chunk;
      });
      process.stdin.on("end", () => resolve(data));
      process.stdin.on("error", () => resolve(""));
    } catch {
      resolve("");
    }
  });
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const needsStdin = !argv.includes("--staged") && !argv.includes("--from-git");
  const stdinText = needsStdin ? await readStdin() : "";
  const git: GitSeam = nodeGitSeam(process.cwd());
  const { stdout, stderr, exitCode } = runZoneCheckCli(argv, { git, stdinText });
  if (stdout) process.stdout.write(stdout + "\n");
  if (stderr) process.stderr.write(stderr + "\n");
  process.exit(exitCode);
}

// Direct-run guard (`node core/src/zone/zone-check-cli.ts --allow ...`) —
// inert under `node --test` / plain `import` (same pattern as
// `../rails/cli.ts` / `../shim/command-hook.ts`).
if (process.argv[1]) {
  let isDirectRun = false;
  try {
    isDirectRun = fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    isDirectRun = false;
  }
  if (isDirectRun) {
    void main();
  }
}
