/**
 * queue-rpc-cli (T7-5, contract L-4) — TS port of `tools/queue_rpc.py`,
 * ported "as-is" (OMP-glue): a thin session-keeper for OMP's in-process
 * autonomous queue. NOT an orchestrator — the actual queue logic
 * (select/dispatch/verdict-on-HEAD-advance/advance/routing) lives INSIDE
 * OMP's `.omp/hooks/queue-runner.ts`. This driver only:
 *   1. spawns ONE persistent `omp --mode=rpc` (armed env `OMP_QUEUE`),
 *   2. sends a single kick-prompt (the hook then re-drives the queue itself
 *      via agent_end -> sendMessage),
 *   3. keeps stdin open (an rpc session disposes itself once stdin closes),
 *      streaming stdout/stderr into per-run log files,
 *   4. closes stdin once every task-id from `--tasks-dir` is terminal in
 *      `--state`.
 *
 * `--mode=rpc` (not `-p`, single-shot) is required so a hook-driven
 * re-injected prompt is not aborted by session disposal — same rationale as
 * the Python original's doc-comment.
 *
 * Pure helpers (task-id extraction, drained-check, error-event
 * classification) live in `./queue-rpc.ts` (contract L-1 pure-core split);
 * this file is the spawn/stdio/timer/argv glue, not unit-tested beyond that
 * (same "thin shell, not tested" pattern as `../rails/cli.ts`'s `main`).
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { KICK, extractTaskId, allTerminal, isErrorEvent, type QueueState } from "./queue-rpc.ts";

function taskIds(tasksDir: string): Set<string> {
  const ids = new Set<string>();
  if (!fs.existsSync(tasksDir) || !fs.statSync(tasksDir).isDirectory()) return ids;
  for (const name of fs.readdirSync(tasksDir).filter((n) => n.endsWith(".md"))) {
    const text = fs.readFileSync(path.join(tasksDir, name), "utf-8");
    ids.add(extractTaskId(text, path.basename(name, ".md")));
  }
  return ids;
}

function loadState(statePath: string): QueueState {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf-8")) as QueueState;
  } catch {
    return {};
  }
}

interface Args {
  cwd: string;
  tasksDir: string;
  state: string;
  model: string;
  advisor: boolean;
  rollbackOnBlock: boolean;
  timeout: number;
  quiet: boolean;
}

function parseArgv(argv: readonly string[]): Args {
  const a: Args = {
    cwd: "",
    tasksDir: ".workflow/tasks",
    state: ".workflow/queue-state.json",
    model: "",
    advisor: false,
    rollbackOnBlock: false,
    timeout: 1800,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--cwd") a.cwd = argv[++i] ?? "";
    else if (t === "--tasks-dir") a.tasksDir = argv[++i] ?? a.tasksDir;
    else if (t === "--state") a.state = argv[++i] ?? a.state;
    else if (t === "--model") a.model = argv[++i] ?? "";
    else if (t === "--advisor") a.advisor = true;
    else if (t === "--rollback-on-block") a.rollbackOnBlock = true;
    else if (t === "--timeout") a.timeout = Number(argv[++i]) || 1800;
    else if (t === "--quiet") a.quiet = true;
  }
  return a;
}

function tsForFilename(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function makeReader(
  sessStream: fs.WriteStream,
  errStream: fs.WriteStream,
  quiet: boolean,
  onError: () => void,
): (chunk: string) => void {
  let buf = "";
  return (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      sessStream.write(line + "\n");
      let ev: Record<string, unknown> | null = null;
      try {
        ev = JSON.parse(line) as Record<string, unknown>;
      } catch {
        ev = null;
      }
      if (isErrorEvent(line, ev)) {
        onError();
        errStream.write(line + "\n");
      }
      if (!quiet && ev) {
        const t = (ev.type as string) || "?";
        if (["agent_start", "agent_end", "response", "prompt_result", "error"].includes(t)) {
          console.log(`  ‹${t}›${t === "error" ? "  [ERROR]" : ""}`);
        }
      }
    }
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const args = parseArgv(argv);
  const base = args.cwd ? path.resolve(args.cwd) : repo;
  const tasksDir = path.isAbsolute(args.tasksDir) ? args.tasksDir : path.resolve(base, args.tasksDir);
  const statePath = path.isAbsolute(args.state) ? args.state : path.resolve(base, args.state);

  const ids = taskIds(tasksDir);
  if (ids.size === 0) {
    process.stderr.write(`нет задач в ${tasksDir} — нечего гнать.\n`);
    return 2;
  }

  const logsDir = path.join(base, ".workflow", "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const stamp = tsForFilename(new Date());
  const sessLogPath = path.join(logsDir, `rr-session-${stamp}.jsonl`);
  const errLogPath = path.join(logsDir, `err-${stamp}.log`);
  console.log(`  logs: ${path.basename(sessLogPath)} / ${path.basename(errLogPath)} (в .workflow/logs)`);

  const env: NodeJS.ProcessEnv = { ...process.env, OMP_QUEUE: "1", OMP_QUEUE_TASKS_DIR: tasksDir, OMP_QUEUE_STATE: statePath };
  if (args.rollbackOnBlock) env.OMP_QUEUE_ROLLBACK = "1";

  const cmdArgs = ["--mode=rpc", "--approval-mode", "yolo"];
  if (args.model) cmdArgs.push("--model", args.model);
  if (args.advisor) cmdArgs.unshift("--advisor");

  console.log(`=== QUEUE-RPC: ${ids.size} задач, model=${args.model || "default"}${args.advisor ? " +advisor" : ""} ===`);

  const child = spawn("omp", cmdArgs, { cwd: base, env, stdio: ["pipe", "pipe", "pipe"] });
  const sessStream = fs.createWriteStream(sessLogPath, { encoding: "utf-8" });
  const errStream = fs.createWriteStream(errLogPath, { encoding: "utf-8" });
  let errCount = 0;
  let closed = false;

  const onData = makeReader(sessStream, errStream, args.quiet, () => {
    errCount++;
  });
  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("close", () => {
    closed = true;
  });

  await new Promise((r) => setTimeout(r, 500));
  try {
    child.stdin.write(JSON.stringify({ id: "kick", type: "prompt", message: KICK }) + "\n");
  } catch {
    // best-effort, same as Python's un-guarded write (a dead process here means an immediate close/timeout below anyway).
  }

  const t0 = Date.now();
  let rc = 0;
  for (;;) {
    if (closed) {
      console.log("  rpc-стрим закрыт (сессия завершилась).");
      break;
    }
    if (allTerminal(ids, loadState(statePath))) {
      console.log("  очередь дренирована → закрываю stdin.");
      break;
    }
    if (Date.now() - t0 > args.timeout * 1000) {
      process.stderr.write(`  TIMEOUT (${args.timeout}s).\n`);
      rc = 124;
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  try {
    child.stdin.end();
  } catch {
    // already closed
  }
  await new Promise<void>((resolve) => {
    if (closed) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already dead
      }
      resolve();
    }, 30000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  if (child.exitCode !== null && child.exitCode !== 0) {
    try {
      errStream.write(JSON.stringify({ type: "error", source: "queue_rpc", detail: `omp exit ${child.exitCode}` }) + "\n");
      errCount++;
    } catch {
      // best-effort
    }
  }
  sessStream.end();
  errStream.end();

  const st = loadState(statePath);
  const doneN = [...ids].filter((i) => st[i] === "done").length;
  const blockedN = [...ids].filter((i) => st[i] === "blocked").length;
  console.log(`=== ИТОГ: done=${doneN} blocked=${blockedN} / ${ids.size}, errors=${errCount} (logs: ${logsDir}) ===`);
  return rc;
}

// Direct-run guard (`node core/src/ops/queue-rpc-cli.ts --cwd ...`) — inert
// under `node --test` / plain `import` (same pattern as `../rails/cli.ts`).
if (process.argv[1]) {
  let isDirectRun = false;
  try {
    isDirectRun = fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    isDirectRun = false;
  }
  if (isDirectRun) {
    main()
      .then((c) => process.exit(c))
      .catch((e: unknown) => {
        console.error("queue-rpc error:", e instanceof Error ? e.message : e);
        process.exit(2);
      });
  }
}
