// telemetry — structured NDJSON (run + guard). DSH paths: project + ~/.dsh/agent/.
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
  tool: string;
  tid: string;
  stage?: string;
  capability?: string;
  backend?: string;
  backendSrc?: string;
  model?: string;
  agent?: string;
  outcome: string;
  gate?: string;
  bounces?: number;
  criticBlocking?: number;
  criticMinor?: number;
  zoneViolations?: number;
  testCmd?: string;
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
  event: string;
  tid?: string;
  tool?: string;
  backend?: string;
  model?: string;
  detail?: string;
  errClass?: string;
}

const CAP_BYTES = (() => {
  const mb = Number(process.env.DSH_TELEMETRY_CAP_MB ?? process.env.OMP_TELEMETRY_CAP_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : 20) * 1024 * 1024;
})();

function rotateIfBig(file: string): void {
  try {
    const st = fs.statSync(file);
    if (st.size >= CAP_BYTES) fs.renameSync(file, file + ".1");
  } catch {
    /* no file */
  }
}

function append(cwd: string, obj: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n";
  const targets = [
    path.resolve(cwd, ".workflow/telemetry.ndjson"),
    path.join(os.homedir(), ".dsh", "agent", "telemetry.ndjson"),
  ];
  for (const t of targets) {
    try {
      fs.mkdirSync(path.dirname(t), { recursive: true });
      rotateIfBig(t);
      fs.appendFileSync(t, line, "utf8");
    } catch {
      /* best-effort */
    }
  }
}

export function recordRun(cwd: string, ev: RunEvent): void {
  try {
    append(cwd, { kind: "run", ...ev });
  } catch {
    /* swallow */
  }
}

export function recordGuard(cwd: string, ev: GuardEvent): void {
  try {
    append(cwd, { kind: "guard", ...ev });
  } catch {
    /* swallow */
  }
}
