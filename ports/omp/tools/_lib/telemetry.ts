// telemetry — структурированный NDJSON для улучшения продукта по 3 осям:
//   1) производительность (durationMs, bounce, num_turns)  2) потребление (tokens/cost)
//   3) качество/безопасность (срабатывания рельсов = где модель нарушает → куда харденить).
// Два kind в одном стриме: "run" (per stage-run) и "guard" (per срабатывание рельса).
// Копит в ДВА места: <cwd>/.workflow/telemetry.ndjson (по-проектно, runtime/gitignored) +
//   ~/.omp/agent/telemetry.ndjson (cross-project агрегат). Анализ: tools/stats.py / jq / duckdb.
// НИКОГДА не бросает в поток тула/хука (telemetry-сбой ≠ провал стадии) — всё в try/catch.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface WorkerUsage {
  costUsd?: number;
  inputTok?: number;
  outputTok?: number;
  totalTok?: number;
  durationMs?: number;
  sessionId?: string;   // линк на worker-session JSONL для глубокого replay
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
  agent?: string;               // execute: домен-агент
  outcome: string;              // committed|blocked|zone-violation|gate-red|fr-fail|no-changes|locked-nocommit|worker-error|misroute|error
  gate?: string;                // design: PASS|BOUNCE
  bounces?: number;             // design: сколько bounce-retry
  criticBlocking?: number;
  criticMinor?: number;
  zoneViolations?: number;      // execute
  testCmd?: string;             // green|red|none
  frCovered?: number;
  frTotal?: number;
  filesChanged?: number;
  durationMs?: number;          // вся стадия
  worker?: WorkerUsage;         // сумма по worker-вызовам (producer+critic для design)
  commit?: string;              // короткий sha
  // Ось 3b (task-4): классификация ошибок + причины. errClass/errMsg/errCode — при outcome=*error*.
  //   reqErrors/reqErrClasses — «тихие» ошибки запроса В ПОТОКЕ даже при успехе (провайдер ретраил).
  errClass?: string;            // auth|rate-limit|context-length|model-not-found|server-error|network|timeout|cli-missing|killed|git|config|unknown
  errMsg?: string;              // короткая выжимка причины (excerpt)
  errCode?: number;             // exit-code воркера/процесса
  reqErrors?: number;           // счётчик request-error сигнатур в stdout/stderr воркера (0 = чисто)
  reqErrClasses?: string;       // distinct-классы request-ошибок, csv (для быстрого разреза)
}

export interface GuardEvent {
  kind?: "guard";
  event: string;                // zone-violation|gate-bounce|critic-blocker|critic-minor|misroute-guard|
                                //   fr-trace-fail|test-cmd-red|no-changes|worker-error|request-error|model-unset|
                                //   raw-git-deny|protected-write|lead-guard|bypass-suspected
  tid?: string;
  tool?: string;                // какой тул/хук зафиксировал
  backend?: string;
  model?: string;
  detail?: string;              // короткое описание (что именно нарушено)
  errClass?: string;            // task-4: класс ошибки для worker-error/request-error guard-событий
}

// Ротация: файл > CAP → rename в .1 (одно поколение, старое .1 перезаписывается).
// Держит рост под контролем при объёмных прогонах; полная история — в git/внешнем сборе.
// Override размера: env OMP_TELEMETRY_CAP_MB.
const CAP_BYTES = (() => {
  const mb = Number(process.env.OMP_TELEMETRY_CAP_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : 20) * 1024 * 1024;
})();

function rotateIfBig(file: string): void {
  try {
    const st = fs.statSync(file);
    if (st.size >= CAP_BYTES) fs.renameSync(file, file + ".1");
  } catch { /* нет файла / не ротируется — не мешаем append */ }
}

function append(cwd: string, obj: Record<string, unknown>): void {
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
