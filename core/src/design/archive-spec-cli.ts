/**
 * archive-spec-cli (T7-3) — TS port of `tools/archive_spec.py`'s CLI shell:
 * `--change <p> [--capability <c=system>] [--spec-dir <d=docs/spec>]
 * [--reconcile] [--model <m=sonnet>]`. Merges a change-spec's SP/FR blocks
 * into the capability's canon (`<repo-root>/<spec-dir>/<capability>.md`),
 * writes the updated canon, and prints the same ADD/SKIP/RECONCILED/
 * COLLISION report + `ARCHIVE: OK` / `ARCHIVE: BLOCKED` as the Python
 * original. Exit 0 (clean merge) / 1 (unresolved collisions) / 2 (missing
 * change-spec / usage) — same mapping as the Python original.
 *
 * Pure-core + thin-shell split (same pattern as `./gate-lint-cli.ts` /
 * `../zone/zone-check-cli.ts`): `runArchiveSpecCli(argv, deps)` is the
 * injectable, testable layer (fs + optional claude-reconcile seam) built on
 * the pure `mergeCanon`/`emitCanon`/`parseBlocksRaw` (`./archive-spec.ts`).
 * `main` is the real fs/argv/process.exit shell (not unit-tested).
 *
 * `--reconcile`'s `claude -p ...` call is modeled via the same `GitSeam`
 * shape as `../rails/git-seam.ts` (a generic "run a binary" seam, args[0] =
 * the binary — here `"claude"` instead of `"git"`), not a new type: the
 * abstraction ("run one external binary, capture stdout/stderr/code") is
 * identical, only the argv differs.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { mergeCanon, emitCanon, parseBlocksRaw, type ReconcileFn } from "./archive-spec.ts";
import { nodeGitSeam, type GitSeam } from "../rails/git-seam.ts";

const BLOCK_RE = /```(spec|adr|fr)\s*\n([\s\S]*?)```/;

export interface ArchiveSpecCliDeps {
  exists(p: string): boolean;
  readFile(p: string): string;
  writeFile(p: string, content: string): void;
  mkdir(p: string): void;
  /** Repo root used to resolve `--spec-dir` (mirrors Python's `REPO = Path(__file__).resolve().parent.parent`, script-location-fixed, not cwd-relative). */
  repoRoot: string;
  /** `claude`-binary seam for `--reconcile` (omitted -> reconcile is a no-op, collisions stay unresolved). */
  claude?: GitSeam;
}

export interface ArchiveSpecCliOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ParsedArgs {
  change?: string;
  capability: string;
  specDir: string;
  reconcile: boolean;
  model: string;
}

function parseArgv(argv: readonly string[]): { parsed?: ParsedArgs; error?: string } {
  let change: string | undefined;
  let capability = "system";
  let specDir = "docs/spec";
  let reconcile = false;
  let model = "sonnet";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--change") {
      const v = argv[++i];
      if (v === undefined) return { error: "--change: требуется значение" };
      change = v;
    } else if (a === "--capability") {
      const v = argv[++i];
      if (v === undefined) return { error: "--capability: требуется значение" };
      capability = v;
    } else if (a === "--spec-dir") {
      const v = argv[++i];
      if (v === undefined) return { error: "--spec-dir: требуется значение" };
      specDir = v;
    } else if (a === "--reconcile") {
      reconcile = true;
    } else if (a === "--model") {
      const v = argv[++i];
      if (v === undefined) return { error: "--model: требуется значение" };
      model = v;
    } else {
      return { error: `неизвестный аргумент: ${a}` };
    }
  }
  if (!change) return { error: "--change: обязателен" };
  return { parsed: { change, capability, specDir, reconcile, model } };
}

/** `<basename-without-ext>` with every `-spec` substring stripped (Python's `Path.stem.replace("-spec", "")` — replaces ALL occurrences, not just a trailing suffix). */
function changeIdFrom(changePath: string): string {
  const stem = path.basename(changePath, path.extname(changePath));
  return stem.split("-spec").join("");
}

function relPosix(repoRoot: string, target: string): string {
  const rel = path.relative(repoRoot, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return target;
  return rel.split(path.sep).join("/");
}

function reconcileViaClaude(seam: GitSeam, repoRoot: string, model: string): ReconcileFn {
  return (cid: string, oldBody: string, newBody: string): string | null => {
    const prompt =
      "Две версии одного requirement-блока (совпал id, разошёлся statement). " +
      "Реши: какая актуальна, или слей. Верни ОДИН fenced-блок того же вида " +
      "(```spec или ```fr) с корректными полями (id/from/source/statement[/pattern]). " +
      `Новее — из change '${cid}'.\n\nСТАРЫЙ:\n${oldBody}\n\nНОВЫЙ:\n${newBody}`;
    const res = seam.run([
      "claude", "-p", prompt, "--model", model, "--output-format", "json",
      "--allowedTools", "", "--add-dir", repoRoot,
    ]);
    if (res.code !== 0) return null;
    let result = res.stdout;
    try {
      const parsed = JSON.parse(res.stdout);
      result = typeof parsed?.result === "string" ? parsed.result : res.stdout;
    } catch { /* not JSON — fall back to raw stdout, same as Python */ }
    const mm = BLOCK_RE.exec(result);
    return mm ? mm[2].replace(/\n+$/, "") : null;
  };
}

/** argv -> fs reads -> `mergeCanon` -> canon write -> formatted `{stdout, stderr, exitCode}` (Python-parity). */
export function runArchiveSpecCli(argv: readonly string[], deps: ArchiveSpecCliDeps): ArchiveSpecCliOutput {
  const { parsed, error } = parseArgv(argv);
  if (error || !parsed) {
    return { stdout: "", stderr: error ?? "usage error", exitCode: 2 };
  }

  const changeP = path.resolve(parsed.change!);
  if (!deps.exists(changeP)) {
    return { stdout: "", stderr: `ERROR: change-spec не найден: ${changeP}`, exitCode: 2 };
  }
  const changeId = changeIdFrom(changeP);
  const canonP = path.resolve(deps.repoRoot, parsed.specDir, `${parsed.capability}.md`);

  const incoming = parseBlocksRaw(deps.readFile(changeP));
  if (!incoming.length) {
    return {
      stdout: `change '${changeId}': нет SP/FR-блоков для архива — nothing to merge`,
      stderr: "",
      exitCode: 0,
    };
  }

  const canonText = deps.exists(canonP) ? deps.readFile(canonP) : "";
  const reconcile = parsed.reconcile && deps.claude ? reconcileViaClaude(deps.claude, deps.repoRoot, parsed.model) : undefined;
  const merged = mergeCanon(incoming, canonText, changeId, reconcile);

  deps.mkdir(path.dirname(canonP));
  deps.writeFile(canonP, emitCanon(parsed.capability, merged.canon));

  const rel = relPosix(deps.repoRoot, canonP);
  const lines: string[] = [
    `archive '${changeId}' → ${rel} (capability=${parsed.capability})`,
    `  ADD:${merged.added.length} SKIP:${merged.skipped.length} RECONCILED:${merged.reconciled.length} COLLISION:${merged.collisions.length}`,
  ];
  for (const fid of merged.added) lines.push(`    + ${fid}`);
  for (const fid of merged.reconciled) lines.push(`    ~ ${fid} (reconciled)`);
  for (const fid of merged.collisions) lines.push(`    ! ${fid} (COLLISION — statement различается, не решено)`);
  if (merged.collisions.length) {
    lines.push("ARCHIVE: BLOCKED (нерешённые коллизии — запусти с --reconcile или разведи id вручную)");
    return { stdout: lines.join("\n"), stderr: "", exitCode: 1 };
  }
  lines.push("ARCHIVE: OK");
  return { stdout: lines.join("\n"), stderr: "", exitCode: 0 };
}

// ---------------------------------------------------------------------------
// main — thin I/O shell (NOT unit-tested, same pattern as ./gate-lint-cli.ts)
// ---------------------------------------------------------------------------

function repoRootFromModule(): string {
  // core/src/design/archive-spec-cli.ts -> up 3 -> repo root (mirrors Python's
  // `REPO = Path(__file__).resolve().parent.parent`, script-location-fixed).
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const repoRoot = repoRootFromModule();
  const deps: ArchiveSpecCliDeps = {
    exists: fs.existsSync,
    readFile: (p) => fs.readFileSync(p, "utf8"),
    writeFile: (p, content) => fs.writeFileSync(p, content, "utf8"),
    mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
    repoRoot,
    claude: nodeGitSeam(repoRoot),
  };
  const { stdout, stderr, exitCode } = runArchiveSpecCli(argv, deps);
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
