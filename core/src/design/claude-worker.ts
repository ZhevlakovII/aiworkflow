/**
 * claude-worker (T7-4) — TS port of `tools/claude_worker.py`: `claude -p` as
 * the strong-model WORKER for design/critic. Producer reads the locked
 * task-file and writes spec+ADR fenced-blocks (parsed by `./gate-lint.ts`);
 * critic reads {task, spec, adr} with a fresh context and emits a
 * findings-file by severity. Prompts below are transcribed VERBATIM from the
 * Python original (contract L-1) — do not paraphrase.
 *
 * Containment: worker is given ONLY `{Read,Write,Glob,Grep}` (no Bash — no
 * escape). The real rail is not trust in the worker's output but the
 * zone-check on the commit chokepoint (`../rails/commit.ts`'s `gatedCommit`,
 * called by `design-stage.ts`) — writes outside the zone are caught
 * deterministically no matter what the worker produced.
 *
 * Pure-core + injectable-seam split (contract L-2, same seam pattern as
 * `../rails/git-seam.ts`): the real `claude -p` subprocess call goes through
 * `ClaudeSeam.run` (`nodeClaudeSeam`, production-only, spawnSync) — never
 * invoked directly by `runClaudeWorker`, so the whole producer/critic flow is
 * testable with a stub seam (no real `claude` binary touched by tests, no
 * ToS/network surface).
 */
import { spawnSync } from "node:child_process";
import * as path from "node:path";

import { resolveRolePrompt, stripFrontmatter } from "../roles/resolve.ts";

export { stripFrontmatter };

// ---------------------------------------------------------------------------
// ClaudeSeam — injectable boundary for the `claude -p` subprocess call
// (mirrors Python's `run_claude(model, sys_prompt, user_prompt, allowed,
// timeout)` argument shape exactly).
// ---------------------------------------------------------------------------

export interface ClaudeRunArgs {
  model: string;
  sysPrompt: string;
  userPrompt: string;
  allowedTools: string;
  timeout: number;
  cwd: string;
}

/** `code`: claude's own exit code, OR 2 (binary not found) / 124 (timeout) — mirrors Python's `run_claude`. */
export interface ClaudeRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ClaudeSeam {
  run(args: ClaudeRunArgs): ClaudeRunResult;
}

/**
 * Production `ClaudeSeam` — `spawnSync("claude", ...)`. NOT invoked by any
 * test in this repo (contract: real `claude -p` is never run here) — used
 * only by `claude-worker-cli.ts`'s `main()` / `design-stage-cli.ts`'s
 * `main()` (thin, un-unit-tested shells).
 */
export function nodeClaudeSeam(): ClaudeSeam {
  return {
    run(args: ClaudeRunArgs): ClaudeRunResult {
      const cmd = [
        "-p", args.userPrompt,
        "--model", args.model,
        "--output-format", "json",
        "--append-system-prompt", args.sysPrompt,
        "--allowedTools", args.allowedTools,
        "--add-dir", args.cwd,
      ];
      let res: ReturnType<typeof spawnSync>;
      try {
        res = spawnSync("claude", cmd, { cwd: args.cwd, encoding: "utf-8", timeout: args.timeout * 1000 });
      } catch (e) {
        return { code: 2, stdout: "", stderr: String((e as Error).message ?? e) };
      }
      const err = res.error as NodeJS.ErrnoException | undefined;
      if (err && err.code === "ENOENT") {
        return { code: 2, stdout: "", stderr: "ERROR: `claude` не найден в PATH (нужен Claude Code CLI)" };
      }
      if (err && (err.code === "ETIMEDOUT" || res.signal)) {
        return { code: 124, stdout: "", stderr: `ERROR: claude timeout (${args.timeout}s)` };
      }
      if (err) {
        return { code: 2, stdout: "", stderr: String(err.message ?? err) };
      }
      return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
    },
  };
}

// ---------------------------------------------------------------------------
// role prompt (A1): resolution itself now lives in `../roles/resolve.ts`
// (`resolveRolePrompt`, project-overlay -> installed-canon -> domain->executor
// fallback; `stripFrontmatter` re-exported above for backward-compat import
// sites, e.g. `../../test/claude-worker.test.ts`).
// ---------------------------------------------------------------------------
// task prompt (verbatim Python `build_task_prompt`)
// ---------------------------------------------------------------------------

export type WorkerRole = "producer" | "critic";

export interface TaskPromptResult {
  userPrompt: string;
  allowedTools: string;
  kind: WorkerRole;
}

/** `role` + repo-relative POSIX paths -> `(user_prompt, allowed_tools, kind)`, verbatim Python text. */
export function buildTaskPrompt(
  role: WorkerRole,
  taskRel: string,
  specRel: string,
  adrRel: string,
  findingsRel: string | undefined,
  notes: string,
): TaskPromptResult {
  const noteBlock = notes.trim()
    ? `\n\nИСПРАВЬ по замечаниям прошлого прохода (перепиши артефакты):\n${notes}`
    : "";

  if (role === "producer") {
    const prompt =
      `Locked task-file (ЕДИНСТВЕННЫЙ источник контракта): ${taskRel}\n\n` +
      `Прочитай его через Read. Произведи ДВА артефакта, записав их через Write:\n` +
      `  1. spec → ${specRel}\n` +
      `  2. ADR  → ${adrRel}\n\n` +
      `КАЖДЫЙ SP-point и AD-decision ОБЯЗАН нести machine-readable fenced-блок ` +
      "(```spec / ```adr) в формате из твоей роли — их парсит детерминированный " +
      "gate-линтер. source-ref обязан указывать на РЕАЛЬНЫЕ непустые строки " +
      `${taskRel} (формат <file>#L<start>-L<end>): открой файл, возьми точные ` +
      "номера строк, не выдумывай. covers ссылается только на существующие SP-id.\n" +
      "Проза + fenced-блоки в одном файле. Не пиши никаких других файлов." +
      noteBlock;
    return { userPrompt: prompt, allowedTools: "Read,Write,Glob,Grep", kind: "producer" };
  }

  // critic
  const prompt =
    "Свежий критический проход. Прочитай через Read:\n" +
    `  task-file (источник): ${taskRel}\n` +
    `  spec: ${specRel}\n` +
    `  ADR:  ${adrRel}\n\n` +
    "Проверь: Gate-1 (каждый SP реально поддержан source-ref в task-file), " +
    "Gate-2 (каждый AD покрывает SP; каждый SP покрыт или явный gap), " +
    "level-boundary (solution-лексика в spec = leakage), прескриптивность.\n" +
    `Запиши findings через Write в ${findingsRel}: ` +
    "по одному на строку в формате `[blocker|major|minor] <файл>: <проблема>`. " +
    "Если дефектов нет — строка `[none] clean`. Не правь артефакты, не решай направление." +
    noteBlock;
  return { userPrompt: prompt, allowedTools: "Read,Write,Glob,Grep", kind: "critic" };
}

// ---------------------------------------------------------------------------
// runClaudeWorker — orchestration (verbatim Python `main`, minus argv/exit)
// ---------------------------------------------------------------------------

export interface ClaudeWorkerOptions {
  role: WorkerRole;
  /** resolved absolute path */
  task: string;
  spec: string;
  adr: string;
  /** required for role=critic */
  findings?: string;
  model: string;
  notes?: string;
  timeout: number;
  /** port dir holding `agents/<role>.md` (project overlay), e.g. ".claude" for the CC driver.
   *  Default ".omp" preserves the historical hardcoded behaviour of this function. */
  portDir?: string;
}

export interface ClaudeWorkerDeps {
  seam: ClaudeSeam;
  exists(p: string): boolean;
  readFile(p: string): string;
  mkdirp(p: string): void;
  repoRoot: string;
}

export interface ClaudeWorkerResult {
  /** 0 = worker produced expected files; 1 = worker did not; 2 = input/launch error. */
  exitCode: number;
  stdoutLines: string[];
  stderrLines: string[];
}

function toPosixRel(repoRoot: string, p: string): { rel?: string; error?: string } {
  const r = path.relative(repoRoot, p);
  if (r.startsWith("..") || path.isAbsolute(r)) {
    return { error: `путь вне репо (не покрывается zone-check): ${p}` };
  }
  return { rel: r.split(path.sep).join("/") };
}

export function runClaudeWorker(options: ClaudeWorkerOptions, deps: ClaudeWorkerDeps): ClaudeWorkerResult {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  if (!deps.exists(options.task)) {
    stderrLines.push(`ERROR: task-file не найден: ${options.task}`);
    return { exitCode: 2, stdoutLines, stderrLines };
  }
  if (options.role === "critic" && !options.findings) {
    stderrLines.push("ERROR: --findings обязателен для роли critic");
    return { exitCode: 2, stdoutLines, stderrLines };
  }

  // артефакты должны лежать внутри репо (чтобы zone-check покрывал их на коммите)
  const artefacts = [options.spec, options.adr, ...(options.findings ? [options.findings] : [])];
  for (const p of artefacts) {
    const { error } = toPosixRel(deps.repoRoot, p);
    if (error) {
      stderrLines.push(`ERROR: ${error}`);
      return { exitCode: 2, stdoutLines, stderrLines };
    }
    deps.mkdirp(path.dirname(p));
  }

  const role = resolveRolePrompt(
    { role: options.role, projectRoot: deps.repoRoot, portDir: options.portDir ?? ".omp" },
    { exists: deps.exists, readFile: deps.readFile },
  );
  if (role.error) {
    stderrLines.push(`ERROR: ${role.error}`);
    return { exitCode: 2, stdoutLines, stderrLines };
  }

  const taskRelR = toPosixRel(deps.repoRoot, options.task);
  if (taskRelR.error) {
    stderrLines.push(`ERROR: ${taskRelR.error}`);
    return { exitCode: 2, stdoutLines, stderrLines };
  }
  const taskRel = taskRelR.rel as string;
  const specRel = toPosixRel(deps.repoRoot, options.spec).rel as string;
  const adrRel = toPosixRel(deps.repoRoot, options.adr).rel as string;
  const findingsRel = options.findings ? toPosixRel(deps.repoRoot, options.findings).rel : undefined;

  const { userPrompt, allowedTools, kind } = buildTaskPrompt(
    options.role, taskRel, specRel, adrRel, findingsRel, options.notes ?? "",
  );

  stdoutLines.push(`=== claude-worker [${options.role}] model=${options.model} ===`);

  const run = deps.seam.run({
    model: options.model,
    sysPrompt: role.text as string,
    userPrompt,
    allowedTools,
    timeout: options.timeout,
    cwd: deps.repoRoot,
  });

  let meta: Record<string, unknown> = {};
  if (run.stdout.trim()) {
    try {
      meta = JSON.parse(run.stdout) as Record<string, unknown>;
    } catch {
      meta = { raw: run.stdout.slice(-2000) };
    }
  }
  if (run.code !== 0) {
    stderrLines.push(`claude rc=${run.code}\n${run.stderr.slice(-2000)}`);
  }

  const expect = kind === "producer" ? [options.spec, options.adr] : [options.findings as string];
  const written = expect.filter((p) => deps.exists(p));
  const missing = expect.filter((p) => !deps.exists(p));

  const result = {
    role: options.role,
    model: options.model,
    cost_usd: (meta.total_cost_usd as number | undefined) ?? null,
    exit: run.code,
    files: written.map((p) => toPosixRel(deps.repoRoot, p).rel),
    missing: missing.map((p) => toPosixRel(deps.repoRoot, p).rel),
    /** where the role's system-prompt came from — visible in the worker's own JSON report (A1 §4). */
    source: role.source,
  };

  if (run.code !== 0) {
    stdoutLines.push(JSON.stringify(result));
    return { exitCode: run.code === 2 || run.code === 124 ? 2 : 1, stdoutLines, stderrLines };
  }
  if (missing.length) {
    stderrLines.push(`ВОРКЕР не создал: ${JSON.stringify(result.missing)}`);
    stdoutLines.push(JSON.stringify(result));
    return { exitCode: 1, stdoutLines, stderrLines };
  }
  stdoutLines.push(JSON.stringify(result));
  return { exitCode: 0, stdoutLines, stderrLines };
}
