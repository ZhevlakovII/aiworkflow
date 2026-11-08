// backend (порт OMP _lib/backend.ts, адаптирован под OpenCode) — выбор воркер-backend'а по стадии + запуск.
// B4: только opencode | opencode-fanout (зеркало OMP omp | omp-fanout). claude/codex retired.
//
// Backend'ы (все через exec-shim = Bun `$`; git внутри минует zone-guard plugin — аналог pi.exec):
//   opencode        — opencode run …        нативный движок в новом хосте (замена OMP-backend "omp").
//   opencode-fanout — изолированный воркер   git-worktree Path A; inner = opencode.
//
// Резолв (приоритет): task-file поле (`design-backend:`/`execute-backend:`) > env
//   (AIWF_BACKEND_DESIGN/AIWF_BACKEND_EXECUTE) > .opencode/delegation.yml > дефолт "opencode".
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { exec } from "./exec";
import type { WorkerUsage } from "./telemetry";

export type Backend = "opencode" | "opencode-fanout";
export type Stage = "design" | "execute";

const ALLOWED: Record<Stage, Backend[]> = {
  design: ["opencode"],
  execute: ["opencode", "opencode-fanout"],
};

export interface WorkerReq {
  system: string;   // system-prompt (роль)
  user: string;     // user-prompt (контракт-инструкция)
  model: string;
  agent?: string;   // имя opencode-агента (.opencode/agents/<agent>.md) — backend "opencode" зовёт с --agent
  tools?: string;   // comma-list, дефолт "read,write,glob,grep"
  // opencode-fanout: bring-back из worktree-клона фильтруется этим предикатом (файл в зоне?); вне-зоны discard.
  inZone?: (file: string) => boolean;
}

export interface WorkerRes { code: number; stdout: string; stderr: string; usage?: WorkerUsage; }

/** Читает scalar `<stage>: <val>` из .opencode/delegation.yml (простой парс, без YAML-зависимости). */
function fromDelegationFile(cwd: string, stage: Stage): string | null {
  const p = path.resolve(cwd, ".opencode/delegation.yml");
  if (!fs.existsSync(p)) return null;
  for (const raw of fs.readFileSync(p, "utf8").split("\n")) {
    const m = raw.match(new RegExp(`^\\s*${stage}\\s*:\\s*([^#\\s]+)`));
    if (m) return m[1].trim();
  }
  return null;
}

/** Резолв backend'а для стадии. Fail-closed на неизвестный/неразрешённый backend (enforcement > тихий фолбэк). */
export function resolveBackend(
  stage: Stage, taskBackend: string | null | undefined, cwd: string,
): { backend: Backend; source: string } {
  const envKey = `AIWF_BACKEND_${stage.toUpperCase()}`;
  const fileVal = fromDelegationFile(cwd, stage);
  const raw =
    taskBackend && taskBackend.trim() ? { v: taskBackend, s: "task-file" } :
    process.env[envKey]               ? { v: process.env[envKey]!, s: `env ${envKey}` } :
    fileVal                           ? { v: fileVal, s: "delegation.yml" } :
                                        { v: "opencode", s: "default" };
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
export async function runWorker(cwd: string, backend: Backend, req: WorkerReq): Promise<WorkerRes> {
  const combined = req.system.trim() ? `${req.system}\n\n---\n\n${req.user}` : req.user;

  if (backend === "opencode") {
    // Нативный движок: headless `opencode run`.
    // --agent <role> грузит .opencode/agents/<role>.md как воркер-агента.
    const args = ["run", "--model", req.model];
    if (req.agent) args.push("--agent", req.agent);
    args.push(req.agent ? req.user : combined);
    const r = await exec("opencode", args, { cwd });
    return { code: r.code, stdout: r.stdout, stderr: r.stderr };
  }

  // opencode-fanout — ИЗОЛИРОВАННЫЙ воркер (git-worktree Path A). Inner = opencode (B4; was claude).
  return runFanoutIsolated(cwd, req);
}

/** Внутренний воркер fanout'а: бежит в worktree-клоне, пишет файлы. Инъектируем (тест подставляет фейк). */
export type InnerRunner = (innerCwd: string, req: WorkerReq) => Promise<WorkerRes>;

/** opencode-fanout Path A: воркер = opencode в КЛОНЕ. */
const opencodeInnerRunner: InnerRunner = (innerCwd, req) =>
  runWorker(innerCwd, "opencode", { system: req.system, user: req.user, model: req.model, agent: req.agent, tools: req.tools });

function runFanoutIsolated(cwd: string, req: WorkerReq): Promise<WorkerRes> {
  return fanoutOrchestrate(cwd, req, opencodeInnerRunner);
}

/** opencode-fanout Path A ядро: git-worktree клон → runInner в клоне → zone-фильтр bring-back → discard клона.
 *  runInner инъектируем (прод = opencode; тест = фейк) — worktree/zone-логика тестируется без CLI. */
export async function fanoutOrchestrate(cwd: string, req: WorkerReq, runInner: InnerRunner): Promise<WorkerRes> {
  const git = (args: string[], gcwd: string = cwd) => exec("git", args, { cwd: gcwd });
  if ((await git(["rev-parse", "HEAD"])).code !== 0)
    return { code: 1, stdout: "", stderr: "opencode-fanout: изоляция требует git-репо с ≥1 коммитом (валидный HEAD)." };

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const wt = path.join(os.tmpdir(), `opencode-fanout-${id}`);
  const branch = `opencode/fanout/${id}`;
  const add = await git(["worktree", "add", "-b", branch, wt, "HEAD"]);
  if (add.code !== 0)
    return { code: 1, stdout: "", stderr: "opencode-fanout: git worktree add failed:\n" + (add.stderr || "").slice(-800) };

  try {
    const r = await runInner(wt, req);
    if (r.code !== 0) return r;

    if ((await git(["add", "-A"], wt)).code !== 0)
      return { code: 1, stdout: r.stdout, stderr: "opencode-fanout: git add в worktree failed" };
    const changed = (await git(["diff", "--cached", "--name-only"], wt)).stdout
      .split("\n").map((s) => s.trim()).filter(Boolean);

    const inZone = req.inZone ?? (() => true);
    const bring = changed.filter(inZone);
    const discarded = changed.filter((f) => !inZone(f));

    for (const f of bring) {
      const src = path.join(wt, f), dst = path.join(cwd, f);
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      } catch (e) {
        return { code: 1, stdout: r.stdout, stderr: `opencode-fanout: copy-back ${f} failed: ${(e as Error).message}` };
      }
    }
    const note =
      `\n[opencode-fanout] изолированно (git-worktree): ${bring.length} файл(ов) внесено в реальный tree.` +
      (discarded.length ? `\n[isolation] ОТБРОШЕНО вне зоны (discard с клоном): ${discarded.join(", ")}` : "");
    return { code: 0, stdout: (r.stdout || "") + note, stderr: r.stderr, usage: r.usage };
  } finally {
    await git(["worktree", "remove", "--force", wt]);
    await git(["branch", "-D", branch]);
  }
}
