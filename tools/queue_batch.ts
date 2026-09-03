// queue_batch — АВТОНОМНАЯ параллельная очередь через direct-spawn (Path A ×N). Альтернатива
// queue_rpc.py + queue-runner (single-lead, последовательно). Здесь очередь спавнит N изолированных
// воркеров САМА (git-worktree клон на воркера) параллельно с потолком per-model, минуя lead.
//
// Поток: scan pending → build BatchTask[] (домен-агент/зона/модель) → fanoutBatch (параллельная
//   worker-фаза, brought файлы в реальный tree) → per-task СЕРИЙНО commit-rail (zone-check→test-cmd→
//   FR-trace→commit) → state + telemetry + логи в .workflow/logs.
//
// Валидация worker-фазы/бюджета/изоляции — _lib/fanout_batch.test.ts (fake inner). Живой end-to-end
//   (реальный claude в клоне) — прогон пользователя; runInner инъектируем, тест подставляет фейк.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseZone, scalarField } from "../.omp/tools/_lib/task.ts";
import { zoneCheck } from "../.omp/tools/_lib/zonecheck.ts";
import { frTrace } from "../.omp/tools/_lib/frtrace.ts";
import { loadZoneMap, resolveAgent } from "../.omp/tools/_lib/zonemap.ts";
import { runWorker, type WorkerPi, type WorkerReq, type Backend } from "../.omp/tools/_lib/backend.ts";
import { fanoutBatch, type BatchTask, type BatchResult } from "../.omp/tools/_lib/fanout_batch.ts";
import { loadModelCaps, ConcurrencyBudget } from "../.omp/tools/_lib/modelcaps.ts";
import { recordRun, recordGuard } from "../.omp/tools/_lib/telemetry.ts";
import { classifyError, errExcerpt, scanRequestErrors } from "../.omp/tools/_lib/errclass.ts";

export type State = Record<string, "pending" | "active" | "done" | "blocked">;
type Status = State[string];

export interface QueueBatchOpts {
  cwd: string;
  tasksDir: string;      // абсолютный
  statePath: string;     // абсолютный
  maxParallel: number;   // globalCap
  logsDir?: string;      // абсолютный; дефолт <cwd>/.workflow/logs
  backend?: Backend;     // воркер-backend в клоне (claude|omp|codex); дефолт claude. Игнор если runInner задан.
}
interface TaskMeta { tid: string; capability: string; zone: ReturnType<typeof parseZone>; specPath: string | null; agent: string; taskRel: string; }
export interface QueueBatchSummary { done: number; blocked: number; total: number; outcomes: Record<string, number>; }

const mkExec = (): WorkerPi["exec"] => (cmd, args, opts) =>
  new Promise((res) => {
    const child = execFile(cmd, args, { cwd: opts.cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => res({ code: err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0, stdout: stdout || "", stderr: stderr || "" }));
    // КРИТИЧНО: закрыть stdin ребёнка (EOF). omp `--mode json` читает stdin — без этого node оставляет
    //   пайп открытым → omp ждёт ввод вечно (HANG). claude/git не задеты.
    try { child.stdin?.end(); } catch { /* stdin может отсутствовать */ }
  });

function rolePrompt(cwd: string, role: string): string {
  const p = path.resolve(cwd, ".omp/agents", `${role}.md`);
  if (!fs.existsSync(p)) return "";
  let t = fs.readFileSync(p, "utf8");
  if (t.startsWith("---")) { const parts = t.split("---"); if (parts.length >= 3) t = parts.slice(2).join("---"); }
  return t.trim();
}
function resolveDomain(cwd: string, allow: string[]): string {
  try { const zm = loadZoneMap(path.resolve(cwd, ".omp/zonemap.yml")); const r = resolveAgent(allow, zm); return r.denied.length || r.ambiguous ? "executor" : r.agent; }
  catch { return "executor"; }
}
function workerPrompt(taskRel: string): string {
  return `Locked task-file (ЕДИНСТВЕННЫЙ источник контракта): ${taskRel}\n\nПрочитай через Read, реализуй РОВНО контракт по Definition of Done — код + тесты, СТРОГО в allow-зоне. ` +
    `FR-* требования покрой тестом с указанием FR-id. Не выходи за зону. Верни одну строку: какие файлы создал.`;
}
function resolveSpec(cwd: string, text: string, tid: string): string | null {
  const field = scalarField(text, "spec");
  const cand = field ? path.resolve(cwd, field) : path.resolve(cwd, "docs/design", `${tid}-spec.md`);
  return fs.existsSync(cand) ? cand : null;
}

const loadState = (p: string): State => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; } };
const saveState = (p: string, st: State): void => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(st, null, 2), "utf8"); };

/** Основной прогон. runInner инъектируем (тест = фейк); иначе inner = runWorker(opts.backend||claude). */
export async function runQueueBatch(
  pi: WorkerPi, opts: QueueBatchOpts, runInner?: (ip: WorkerPi, rq: WorkerReq) => Promise<import("../.omp/tools/_lib/backend.ts").WorkerRes>,
): Promise<QueueBatchSummary> {
  const inner = runInner ?? ((ip: WorkerPi, rq: WorkerReq) => runWorker(ip, opts.backend ?? "claude", rq));
  const { cwd, tasksDir, statePath, maxParallel } = opts;
  const logsDir = opts.logsDir || path.resolve(cwd, ".workflow/logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const log = (level: string, msg: string) => {
    try { fs.appendFileSync(path.join(logsDir, `queue-batch-${new Date().toISOString().slice(0, 10)}.log`), `${new Date().toISOString()} [${level}] ${msg}\n`, "utf8"); } catch { /* best-effort */ }
  };
  const git = (args: string[], c = cwd) => pi.exec("git", args, { cwd: c });

  const st = loadState(statePath);
  // 1. Собрать pending execute-задачи.
  const tasks: BatchTask<TaskMeta>[] = [];
  if (fs.existsSync(tasksDir)) {
    for (const f of fs.readdirSync(tasksDir).filter((n) => n.endsWith(".md")).sort()) {
      const text = fs.readFileSync(path.join(tasksDir, f), "utf8");
      const tid = scalarField(text, "id") || path.basename(f, ".md");
      const status = st[tid];
      if (status === "done" || status === "blocked" || status === "active") continue;
      if ((scalarField(text, "stage") || "").toLowerCase().startsWith("design")) continue;  // design → не сюда
      const zone = parseZone(text);
      const model = scalarField(text, "execute-model") || "sonnet";
      const agent = resolveDomain(cwd, zone.allow);
      const sys = rolePrompt(cwd, agent) || rolePrompt(cwd, "executor");
      const taskRel = path.relative(cwd, path.join(tasksDir, f)).replace(/\\/g, "/");
      const inZone = (fp: string) => !zone.allow.length || zoneCheck([fp], zone.allow, zone.deny).length === 0;
      tasks.push({
        id: tid, model, req: { system: sys, user: workerPrompt(taskRel), model, inZone },
        meta: { tid, capability: scalarField(text, "capability") || "", zone, specPath: resolveSpec(cwd, text, tid), agent, taskRel },
      });
    }
  }
  if (!tasks.length) { log("info", "нет pending execute-задач — очередь пуста."); return { done: 0, blocked: 0, total: 0, outcomes: {} }; }

  const budget = new ConcurrencyBudget(loadModelCaps(cwd), maxParallel > 0 ? maxParallel : Infinity);
  log("info", `direct-spawn: ${tasks.length} задач, globalCap=${maxParallel}, модели=${[...new Set(tasks.map((t) => t.model))].join(",")}`);

  // 2. Параллельная worker-фаза (изоляты + budget).
  const results = await fanoutBatch(pi, tasks, budget, inner);

  // 3. Серийный commit-rail per task (зоны непересекающиеся → детерминированно).
  const outcomes: Record<string, number> = {};
  const t0 = Date.now();
  for (const r of results) {
    const m = r.meta; const t = tasks.find((x) => x.id === r.id)!;
    const base = { tool: "queue_batch", tid: m.tid, stage: "execute", capability: m.capability, backend: "omp-fanout", model: t.model, agent: m.agent };
    const scan = scanRequestErrors((r.worker?.stderr || "") + "\n" + (r.worker?.stdout || ""));
    const reqErrors = scan.count || undefined, reqErrClasses = scan.classes.join(",") || undefined;
    if (scan.count) recordGuard(cwd, { event: "request-error", tid: m.tid, tool: "queue_batch", backend: "omp-fanout", model: t.model, detail: `${scan.count}× ${reqErrClasses}: ${scan.sample}`, errClass: scan.classes[0] });

    const fin = (outcome: Status, extra: Record<string, unknown> = {}, guard?: { event: string; detail?: string; errClass?: string }) => {
      st[m.tid] = outcome === "done" ? "done" : "blocked";
      recordRun(cwd, { ...base, outcome: outcome === "done" ? "committed" : (extra.outcome as string || outcome), durationMs: Date.now() - t0, worker: r.worker?.usage, reqErrors, reqErrClasses, ...extra });
      if (guard) recordGuard(cwd, { event: guard.event, tid: m.tid, tool: "queue_batch", backend: "omp-fanout", model: t.model, detail: guard.detail, errClass: guard.errClass });
      outcomes[String(extra.outcome || outcome)] = (outcomes[String(extra.outcome || outcome)] || 0) + 1;
      log(outcome === "done" ? "info" : "error", `${m.tid}: ${extra.outcome || outcome}${guard ? " (" + guard.event + ")" : ""}`);
    };

    // setup / worker error
    if (r.error || !r.worker || r.worker.code !== 0) {
      const stderr = r.error || r.worker?.stderr || r.worker?.stdout || "";
      const cls = classifyError(stderr, r.worker?.code);
      fin("blocked", { outcome: "worker-error", errClass: cls, errMsg: errExcerpt(stderr), errCode: r.worker?.code }, { event: "worker-error", detail: `${cls}: ${errExcerpt(stderr)}`, errClass: cls });
      continue;
    }
    if (!r.brought.length) { fin("blocked", { outcome: "no-changes", filesChanged: 0 }, { event: "no-changes" }); continue; }

    // stage только brought-файлы (в tree их принёс bring-back).
    if ((await git(["add", "--", ...r.brought])).code !== 0) { fin("blocked", { outcome: "error", errClass: "git", errMsg: "git add failed" }); continue; }
    // zone-check (safety — brought уже in-zone, но deny/edge проверяем).
    const v = zoneCheck(r.brought, m.zone.allow, m.zone.deny);
    if (v.length) { await git(["reset", "-q", "--", ...r.brought]); fin("blocked", { outcome: "zone-violation", zoneViolations: v.length }, { event: "zone-violation", detail: v.slice(0, 5).join("; ") }); continue; }
    // test-cmd.
    let testCmd = "none";
    if (m.zone.testCmd) {
      const tr = await pi.exec("sh", ["-c", m.zone.testCmd], { cwd });
      if (tr.code !== 0) { await git(["reset", "-q", "--", ...r.brought]); fin("blocked", { outcome: "gate-red", testCmd: "red", filesChanged: r.brought.length }, { event: "test-cmd-red", detail: `exit ${tr.code}` }); continue; }
      testCmd = "green";
    }
    // FR-trace.
    let frCovered: number | undefined, frTotal: number | undefined;
    if (m.specPath) {
      const ft = frTrace(m.specPath, r.brought, cwd); frTotal = ft.frIds.length; frCovered = ft.covered.length;
      if (ft.findings.length) { await git(["reset", "-q", "--", ...r.brought]); fin("blocked", { outcome: "fr-fail", testCmd, frCovered, frTotal }, { event: "fr-trace-fail", detail: ft.findings.slice(0, 5).join("; ") }); continue; }
    }
    // commit (rail-подпись → tidCommitted/audit распознают).
    const c = await git(["commit", "-m", `feat(${m.tid}): ${m.capability || "execute"} via queue_batch (${m.agent}, zone+test green)`, "-m", "[omp-rail:queue_batch]"]);
    if (c.code !== 0) { fin("blocked", { outcome: "error", errClass: "git", errMsg: errExcerpt(c.stderr) }); continue; }
    const sha = (await git(["rev-parse", "--short", "HEAD"])).stdout.trim();
    fin("done", { testCmd, frCovered, frTotal, filesChanged: r.brought.length, commit: sha });
  }
  saveState(statePath, st);

  const done = Object.values(st).filter((s) => s === "done").length;
  const blocked = Object.values(st).filter((s) => s === "blocked").length;
  log("info", `ИТОГ: done=${done} blocked=${blocked}, outcomes=${JSON.stringify(outcomes)}`);
  return { done, blocked, total: tasks.length, outcomes };
}

// --- CLI ---
async function cli(): Promise<number> {
  const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
  const cwd = path.resolve(arg("--cwd", process.cwd()));
  const tasksDir = path.resolve(cwd, arg("--tasks-dir", ".workflow/tasks"));
  const statePath = path.resolve(cwd, arg("--state", ".workflow/queue-state.json"));
  const maxParallel = Number(arg("--max-parallel", "1")) || 1;
  const backend = arg("--backend", "claude") as Backend;
  const pi: WorkerPi = { cwd, exec: mkExec() };
  console.log(`=== QUEUE-BATCH (direct-spawn): tasks=${tasksDir} globalCap=${maxParallel} backend=${backend} ===`);
  const s = await runQueueBatch(pi, { cwd, tasksDir, statePath, maxParallel, backend });
  console.log(`=== ИТОГ: done=${s.done} blocked=${s.blocked} / ${s.total}, outcomes=${JSON.stringify(s.outcomes)} ===`);
  return s.blocked && !s.done ? 1 : 0;
}
// Запуск как CLI (не при import из теста).
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("queue_batch.ts")) {
  cli().then((c) => process.exit(c)).catch((e) => { console.error("queue_batch error:", e?.message || e); process.exit(2); });
}
