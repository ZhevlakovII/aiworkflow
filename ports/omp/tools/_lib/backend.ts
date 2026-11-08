// backend — выбор воркер-backend'а по стадии (design/execute) + унифицированный запуск.
// Backend'ы (B4): только omp | omp-fanout. claude/codex retired.
//   omp         — pi.exec("omp", -p …)            нативная модель из modelRoles/провайдера (вкл. strong-API).
//   omp-fanout  — изолированный субагент (git-worktree Path A; inner = omp).
//
// Резолв (приоритет): task-file поле (`design-backend:`/`execute-backend:`) > env
//   (OMP_BACKEND_DESIGN/OMP_BACKEND_EXECUTE) > .omp/delegation.yml > дефолт "omp".
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { WorkerUsage } from "./telemetry";

export type Backend = "omp" | "omp-fanout";
export type Stage = "design" | "execute";

const ALLOWED: Record<Stage, Backend[]> = {
  design: ["omp"],
  execute: ["omp", "omp-fanout"],
};

export interface WorkerPi {
  cwd: string;
  exec(cmd: string, args: string[], opts: { cwd: string }): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface WorkerReq {
  system: string;   // system-prompt (роль)
  user: string;     // user-prompt (контракт-инструкция)
  model: string;
  tools?: string;   // comma-list, дефолт "Read,Write,Glob,Grep"
  // omp-fanout: bring-back из worktree-клона фильтруется этим предикатом (файл в зоне?); вне-зоны discard
  //   вместе с клоном. Предикат инъектит вызывающий тул — так backend.ts остаётся self-contained.
  inZone?: (file: string) => boolean;
}

export interface WorkerRes { code: number; stdout: string; stderr: string; usage?: WorkerUsage; }

/** omp --mode json = NDJSON. Суммируем usage по distinct responseId (фреймы дублируют message). */
function parseOmpUsage(stdout: string): WorkerUsage | undefined {
  let sessionId: string | undefined;
  const seen = new Set<string>();
  let inTok = 0, outTok = 0, totalTok = 0, cost = 0, dur = 0, any = false;
  for (const line of stdout.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    let j: Record<string, unknown>;
    try { j = JSON.parse(s); } catch { continue; }
    if (j.type === "session" && typeof j.id === "string") sessionId = j.id;
    const msg = (j.message ?? j) as Record<string, unknown>;
    const rid = msg.responseId as string | undefined;
    const u = msg.usage as Record<string, unknown> | undefined;
    if (!u || !rid || seen.has(rid)) continue;
    seen.add(rid); any = true;
    inTok += Number(u.input || 0);
    outTok += Number(u.output || 0);
    totalTok += Number(u.totalTokens || 0);
    const c = (u.cost as Record<string, unknown> | undefined)?.total;
    cost += Number(c || 0);
    dur += Number(msg.duration || 0);
  }
  if (!any) return undefined;
  return { costUsd: cost, inputTok: inTok || undefined, outputTok: outTok || undefined,
           totalTok: totalTok || undefined, durationMs: dur || undefined, sessionId };
}

/** Читает scalar `<stage>: <val>` из .omp/delegation.yml (простой парс, без YAML-зависимости). */
function fromDelegationFile(cwd: string, stage: Stage): string | null {
  const p = path.resolve(cwd, ".omp/delegation.yml");
  if (!fs.existsSync(p)) return null;
  for (const raw of fs.readFileSync(p, "utf8").split("\n")) {
    const m = raw.match(new RegExp(`^\\s*${stage}\\s*:\\s*([^#\\s]+)`));
    if (m) return m[1].trim();
  }
  return null;
}

/** Резолв backend'а для стадии. Fail-closed на неизвестный/неразрешённый backend (enforcement > тихий фолбэк).
 *  `taskBackend` — уже извлечённое из task-file поле `<stage>-backend` (caller делает scalarField); null/"" = нет. */
export function resolveBackend(
  stage: Stage, taskBackend: string | null | undefined, cwd: string,
): { backend: Backend; source: string } {
  const envKey = `OMP_BACKEND_${stage.toUpperCase()}`;
  const fileVal = fromDelegationFile(cwd, stage);
  const raw =
    taskBackend && taskBackend.trim() ? { v: taskBackend, s: "task-file" } :
    process.env[envKey]               ? { v: process.env[envKey]!, s: `env ${envKey}` } :
    fileVal                           ? { v: fileVal, s: "delegation.yml" } :
                                        { v: "omp", s: "default" };
  const backend = raw.v.trim().toLowerCase() as Backend;
  if (!ALLOWED[stage].includes(backend)) {
    throw new Error(
      `backend "${backend}" не разрешён для стадии ${stage} (источник: ${raw.s}). ` +
      `Допустимо: ${ALLOWED[stage].join(" | ")}.`,
    );
  }
  return { backend, source: raw.s };
}

/** Унифицированный запуск воркера выбранным backend'ом. Возврат нормализован {code,stdout,stderr,usage?}. */
export async function runWorker(pi: WorkerPi, backend: Backend, req: WorkerReq): Promise<WorkerRes> {
  const tools = req.tools || "Read,Write,Glob,Grep";
  const combined = req.system.trim() ? `${req.system}\n\n---\n\n${req.user}` : req.user;

  if (backend === "omp") {
    // Вложенный omp -p = нативная модель из modelRoles/провайдера. Агентный (свой цикл).
    // `--mode json` = NDJSON-стрим; успех воркера = файлы на диске + git-state, не stdout.
    // --no-extensions КРИТИЧНО: без customTools (gated_commit) и без queue-runner recursion.
    const r = await pi.exec(
      "omp",
      ["-p", combined, "--model", req.model, "--mode", "json", "--tools", tools, "--no-extensions",
       "--add-dir", pi.cwd, "--cwd", pi.cwd, "--approval-mode", "yolo"],
      { cwd: pi.cwd },
    );
    return { code: r.code, stdout: r.stdout, stderr: r.stderr, usage: parseOmpUsage(r.stdout) };
  }

  // omp-fanout — ИЗОЛИРОВАННЫЙ воркер (Path A: git-worktree). Inner = omp (B4; was claude).
  return runFanoutIsolated(pi, req);
}

/** Внутренний воркер fanout'а: бежит в worktree-pi, пишет файлы. Инъектируем (тест подставляет фейк). */
export type InnerRunner = (innerPi: WorkerPi, req: WorkerReq) => Promise<WorkerRes>;

/** omp-fanout Path A (дефолт): воркер = omp в КЛОНЕ. */
const ompInnerRunner: InnerRunner = (innerPi, req) =>
  runWorker(innerPi, "omp", { system: req.system, user: req.user, model: req.model, tools: req.tools });

function runFanoutIsolated(pi: WorkerPi, req: WorkerReq): Promise<WorkerRes> {
  return fanoutOrchestrate(pi, req, ompInnerRunner);
}

/** omp-fanout Path A ядро: git-worktree клон → runInner в клоне → zone-фильтр bring-back → discard клона.
 *  runInner инъектируем (прод = omp; тест = фейк, пишущий файлы) — worktree/zone-логика тестируется без omp. */
export async function fanoutOrchestrate(pi: WorkerPi, req: WorkerReq, runInner: InnerRunner): Promise<WorkerRes> {
  const git = (args: string[], cwd: string = pi.cwd) => pi.exec("git", args, { cwd });
  // Prereq изоляции (P1-probe): валидный HEAD (≥1 коммит), иначе worktree fail-closed.
  if ((await git(["rev-parse", "HEAD"])).code !== 0)
    return { code: 1, stdout: "", stderr: "omp-fanout: изоляция требует git-репо с ≥1 коммитом (валидный HEAD)." };

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const wt = path.join(os.tmpdir(), `omp-fanout-${id}`);
  const branch = `omp/fanout/${id}`;
  const add = await git(["worktree", "add", "-b", branch, wt, "HEAD"]);
  if (add.code !== 0)
    return { code: 1, stdout: "", stderr: "omp-fanout: git worktree add failed:\n" + (add.stderr || "").slice(-800) };

  try {
    const innerPi: WorkerPi = { cwd: wt, exec: (c, a, o) => pi.exec(c, a, o) };
    const r = await runInner(innerPi, req);
    if (r.code !== 0) return r;  // воркер упал → finally уберёт worktree

    // Собрать изменённые файлы в клоне (add -A ловит новые/изменённые; удаления не переносим — редки в execute).
    if ((await git(["add", "-A"], wt)).code !== 0)
      return { code: 1, stdout: r.stdout, stderr: "omp-fanout: git add в worktree failed" };
    const changed = (await git(["diff", "--cached", "--name-only"], wt)).stdout
      .split("\n").map((s) => s.trim()).filter(Boolean);

    // Zone-фильтр bring-back: только файлы В зоне долетают до реального tree; вне-зоны отбрасываем с клоном.
    const inZone = req.inZone ?? (() => true);
    const bring = changed.filter(inZone);
    const discarded = changed.filter((f) => !inZone(f));

    for (const f of bring) {
      const src = path.join(wt, f), dst = path.join(pi.cwd, f);
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      } catch (e) {
        return { code: 1, stdout: r.stdout, stderr: `omp-fanout: copy-back ${f} failed: ${(e as Error).message}` };
      }
    }
    const note =
      `\n[omp-fanout] изолированно (git-worktree): ${bring.length} файл(ов) внесено в реальный tree.` +
      (discarded.length ? `\n[isolation] ОТБРОШЕНО вне зоны (не долетело до репо, discard с клоном): ${discarded.join(", ")}` : "");
    return { code: 0, stdout: (r.stdout || "") + note, stderr: r.stderr, usage: r.usage };
  } finally {
    await git(["worktree", "remove", "--force", wt]);
    await git(["branch", "-D", branch]);  // pi.exec не бросает; ветка-очистка best-effort
  }
}
