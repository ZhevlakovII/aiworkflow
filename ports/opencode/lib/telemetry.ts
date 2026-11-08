// telemetry — структурированный NDJSON (порт OMP _lib/telemetry.ts + recordTool из CC PostToolUse).
// 3 оси: 1) perf (durationMs/bounce) 2) consumption (tokens/cost) 3) quality/safety (срабатывания рельсов).
// Kind в стриме: "run" (per stage-run), "guard" (per срабатывание рельса), "tool" (per tool.execute.after).
// Копит в <cwd>/.workflow/telemetry.ndjson + ~/.omp/agent/telemetry.ndjson (cross-project агрегат).
// НИКОГДА не бросает в поток тула/плагина (сбой ≠ провал стадии) — всё в try/catch. Off: env AIWF_TELEMETRY_OFF=1.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface WorkerUsage {
  costUsd?: number;
  inputTok?: number;
  outputTok?: number;
  totalTok?: number;
  durationMs?: number;
  sessionId?: string;
}

export interface RunEvent {
  kind?: "run";
  tool: string;                 // design_worker | execute_worker | codex_worker
  tid: string;
  stage?: string;
  capability?: string;
  backend?: string;
  backendSrc?: string;
  model?: string;
  agent?: string;
  outcome: string;              // committed|blocked|zone-violation|gate-red|fr-fail|no-changes|locked-nocommit|worker-error|misroute|error
  gate?: string;                // design: PASS|BOUNCE
  bounces?: number;
  criticBlocking?: number;
  criticMinor?: number;
  zoneViolations?: number;
  testCmd?: string;             // green|red|none
  frCovered?: number;
  frTotal?: number;
  filesChanged?: number;
  durationMs?: number;
  worker?: WorkerUsage;
  commit?: string;
  errClass?: string;
  errMsg?: string;
  errCode?: number;
  reqErrors?: number;
  reqErrClasses?: string;
}

export interface GuardEvent {
  kind?: "guard";
  event: string;                // zone-violation|gate-bounce|critic-blocker|misroute-guard|fr-trace-fail|
                                //   test-cmd-red|no-changes|worker-error|request-error|raw-git-deny|protected-write|...
  tid?: string;
  tool?: string;
  backend?: string;
  model?: string;
  detail?: string;
  errClass?: string;
}

export interface ToolEvent {
  kind?: "tool";
  tool: string;
  ok: boolean;
}

const CAP_BYTES = (() => {
  const mb = Number(process.env.OMP_TELEMETRY_CAP_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : 20) * 1024 * 1024;
})();

function rotateIfBig(file: string): void {
  try {
    const st = fs.statSync(file);
    if (st.size >= CAP_BYTES) fs.renameSync(file, file + ".1");
  } catch { /* нет файла — не мешаем append */ }
}

function append(cwd: string, obj: Record<string, unknown>): void {
  if (process.env.AIWF_TELEMETRY_OFF === "1") return;
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n";
  const targets = [
    path.resolve(cwd, ".workflow/telemetry.ndjson"),
    path.join(os.homedir(), ".omp", "agent", "telemetry.ndjson"),
  ];
  for (const t of targets) {
    try {
      fs.mkdirSync(path.dirname(t), { recursive: true });
      rotateIfBig(t);
      fs.appendFileSync(t, line, "utf8");
    } catch { /* best-effort — глотаем */ }
  }
}

/** per stage-run (оси 1+2 + outcome). Best-effort, не бросает. */
export function recordRun(cwd: string, ev: RunEvent): void {
  try { append(cwd, { kind: "run", ...ev }); } catch { /* глотаем */ }
}

/** per срабатывание рельса (ось 3). Best-effort, не бросает. */
export function recordGuard(cwd: string, ev: GuardEvent): void {
  try { append(cwd, { kind: "guard", ...ev }); } catch { /* глотаем */ }
}

/** per tool.execute.after (порт CC PostToolUse kind:tool). Best-effort, не бросает. */
export function recordTool(cwd: string, ev: ToolEvent): void {
  try { append(cwd, { kind: "tool", ...ev }); } catch { /* глотаем */ }
}
