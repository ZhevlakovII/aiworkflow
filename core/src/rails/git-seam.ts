/**
 * git-seam (T4, contract §git-seam) — the injectable boundary every rail
 * (`commit.ts` / `push.ts` / `merge.ts`) uses instead of calling
 * `node:child_process` directly.
 *
 * Rail-seam invariant (contract, ported from the Python rails' `run()`
 * helper — `tools/gated_commit.py` / `gated_push.py` / `gated_merge.py`):
 * git (and any other external binary the rails shell out to, e.g. `gh` for
 * the push-rail's optional PR step) goes through subprocess/seam, NEVER
 * through the interactive bash-tool path — a rail is its own enforcement
 * chokepoint, not something `zone-guard` intercepts (it never sees this
 * child-process invocation at all).
 *
 * `run(args)` mirrors the Python `run(cmd: list[str])` helper exactly:
 * `args[0]` IS the binary (`"git"`, or `"gh"` for the push-rail's PR call) —
 * the seam does not implicitly prepend `"git"`. This is why the contract's
 * push-rail note reads `seam.run(["gh", ...])` for the PR step: it is the
 * SAME `run()`, just with a different argv[0], not a second entry point.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitSeam {
  /** `args[0]` is the binary (e.g. `"git"`, `"gh"`), the rest are its argv. */
  run(args: readonly string[]): GitRunResult;
  /** One shell-interpreted command string — used ONLY for the quality-gate cmd (stack-agnostic, arbitrary shell syntax). */
  runShell(cmd: string): GitRunResult;
}

/** Result-contract shared by every rail (contract §Результат-контракт рельсов). */
export interface RailResult {
  ok: boolean;
  status: string;
  detail?: string;
}

/** A message already carries a rail-signature trailer (any tool). */
const RAIL_TRAILER_RE = /\[omp-rail:/;

/**
 * Rail-signature trailer (T7-6, contract L-1) — every rail that creates a
 * commit signs it with `[omp-rail:<tool>]` so `audit-commits` (bypass-scan)
 * classifies it as rail-made, not a manual/suspect commit. Emitted as its
 * own `-m` (git joins separate `-m` args with a blank line — a trailer
 * block at the end, not glued to the subject/body). No-op (empty array)
 * when the message already carries ANY `[omp-rail:` trailer — never
 * double-sign.
 */
export function railTrailerArgs(message: string, tool: string): string[] {
  return RAIL_TRAILER_RE.test(message) ? [] : ["-m", `[omp-rail:${tool}]`];
}

/**
 * A5b (contract §Требуется 1) — `runShell` result carries this prefix in
 * `stderr` when no POSIX `sh` could be resolved. Callers (`commit.ts` /
 * `merge.ts`) sniff this prefix to surface a distinct `gate-shell-missing`
 * rail status instead of the generic `gate-red` — "явная ошибка гейта, не
 * тихий fallback на cmd".
 */
export const GATE_SHELL_MISSING = "gate-shell-missing";

/** Cap on how much of the gate's combined output the rail report carries — "хвост вывода" (contract §Требуется 2). */
const GATE_OUTPUT_TAIL_CHARS = 4000;

/** Truncate to the tail (most recent output matters most for diagnosing a gate failure). */
export function tailOutput(text: string): string {
  if (text.length <= GATE_OUTPUT_TAIL_CHARS) return text;
  return `...(truncated)\n${text.slice(-GATE_OUTPUT_TAIL_CHARS)}`;
}

/** `name` (+ `.exe` on Windows) resolved by walking `PATH` — a portable stand-in for `which`/`where`. */
function findInPath(name: string): string | null {
  const pathEnv = process.env.PATH ?? process.env.Path ?? "";
  const exts = process.platform === "win32" ? [".exe", ""] : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Resolve a POSIX `sh` — PATH first, then (Git for Windows layout) beside
 * the resolved `git` binary: `<git>/../usr/bin/sh.exe`, `<git>/../bin/sh.exe`
 * (contract §Требуется 1). Returns `null`, never a silent cmd.exe fallback.
 */
export function resolveShPath(): string | null {
  const shInPath = findInPath("sh");
  if (shInPath) return shInPath;
  const gitPath = findInPath("git");
  if (!gitPath) return null;
  const gitDir = path.dirname(gitPath);
  const candidates = [
    path.join(gitDir, "..", "usr", "bin", "sh.exe"),
    path.join(gitDir, "..", "bin", "sh.exe"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Production `GitSeam` — `node:child_process.spawnSync`, args-array for git
 * (no shell). `runShell` (the quality-gate command, an arbitrary
 * stack-agnostic shell line, same role as Python's
 * `subprocess.run(gate, shell=True)`) is interpreted by a resolved POSIX
 * `sh -c <cmd>` on every OS (A5b, contract §Требуется 1) — NOT `shell:true`
 * (which on Windows would route through cmd.exe) — so a gate command behaves
 * identically cross-platform.
 *
 * `cwd` is fixed at construction (closure) — the interface itself carries no
 * per-call `cwd` (contract signature: `run(args: string[])`); tests build a
 * fresh seam per tmp-repo via `nodeGitSeam(tmpRepoPath)`.
 */
export function nodeGitSeam(cwd?: string): GitSeam {
  return {
    run(args: readonly string[]): GitRunResult {
      if (args.length === 0) {
        return { code: 1, stdout: "", stderr: "nodeGitSeam.run: empty argv" };
      }
      const [bin, ...rest] = args;
      const res = spawnSync(bin, rest, { cwd, encoding: "utf-8" });
      if (res.error) {
        return { code: 1, stdout: "", stderr: String(res.error.message ?? res.error) };
      }
      return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
    },
    runShell(cmd: string): GitRunResult {
      const shPath = resolveShPath();
      if (!shPath) {
        return {
          code: 127,
          stdout: "",
          stderr: `${GATE_SHELL_MISSING}: POSIX sh не найден (PATH, <git>/../usr/bin/sh.exe, <git>/../bin/sh.exe) — нужен Git for Windows`,
        };
      }
      // Single argv element to `sh -c` — no extra shell layer (no shell:true).
      const res = spawnSync(shPath, ["-c", cmd], { cwd, encoding: "utf-8" });
      if (res.error) {
        return { code: 1, stdout: "", stderr: String(res.error.message ?? res.error) };
      }
      return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
    },
  };
}
